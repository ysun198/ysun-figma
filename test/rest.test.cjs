const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rest = require('../src/host/rest.cjs');
const mcp = require('../src/host/mcp.cjs');
const spec = require('../skills/ysun-figma/references/rest-api.json');
const { createBridgeServer } = require('../src/host/bridge-server.cjs');
function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ysun-rest-test-'));
  const keys = [
    'FIGMA_PLUGIN_STATE_DIR',
    'FIGMA_REST_TOKEN',
    'FIGMA_REST_TOKEN_TYPE',
    'FIGMA_REST_CREDENTIAL_FILE',
  ];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  process.env.FIGMA_PLUGIN_STATE_DIR = root;
  t.after(() => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function sample(schema, depth = 0) {
  if (!schema || depth > 30) return null;
  if (schema.$ref)
    return sample(
      schema.$ref
        .slice(2)
        .split('/')
        .reduce((o, k) => o[k], spec),
      depth + 1,
    );
  if (schema.enum) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.oneOf || schema.anyOf)
    return sample((schema.oneOf || schema.anyOf)[0], depth + 1);
  if (schema.allOf)
    return Object.assign({}, ...schema.allOf.map((s) => sample(s, depth + 1)));
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== 'null')
    : schema.type;
  if (type === 'object' || schema.properties)
    return Object.fromEntries(
      (schema.required || []).map((k) => [
        k,
        sample(schema.properties?.[k], depth + 1),
      ]),
    );
  if (type === 'array')
    return Array.from({ length: schema.minItems || 0 }, () =>
      sample(schema.items, depth + 1),
    );
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return false;
  return 'SampleValue12';
}
test('every official REST operation has a complete executable route and discoverable input/response contract', async () => {
  assert.equal(rest.list().total, 72);
  assert.deepEqual(rest.list().families, { rest: 59, discovery: 1, scim: 12 });
  const contract = mcp.tools.find((tool) => tool.name === 'figma_rest');
  assert(rest.operations.some((op) => op.method === 'DELETE'));
  assert.equal(
    contract.annotations.destructiveHint,
    true,
    'a tool exposing cloud deletion must not advertise only additive changes',
  );
  assert.equal(
    contract.annotations.openWorldHint,
    true,
    'direct cloud APIs interact with external entities',
  );
  for (const op of rest.operations) {
    const input = {
      endpoint: op.operationId,
      operationId: 'contract-' + op.operationId,
      pathParams: {},
      query: {},
    };
    for (const p of op.parameters) {
      if (p.in === 'path') input.pathParams[p.name] = 'SampleValue12';
      else if (p.in === 'query' && p.required)
        input.query[p.name] =
          p.name === 'start_date' ? '2026-01-01T00:00:00Z' : sample(p.schema);
    }
    if (op.requestBody?.required)
      input.body = sample(op.requestBody.content['application/json'].schema);
    mcp.validate(
      { action: 'request', ...input },
      mcp.tools.find((t) => t.name === 'figma_rest').inputSchema,
    );
    const result = rest.prepare(input);
    assert.equal(
      new URL(result.url).origin,
      op.baseUrl || 'https://api.figma.com',
    );
    assert(!result.url.includes('{'));
    assert.equal(result.method, op.method);
    assert(rest.describe(op.operationId).operation.responses);
    const scheme = Object.keys(op.security[0])[0];
    const type = {
      PersonalAccessToken: 'pat',
      PlanAccessToken: 'plan',
      OAuth2: 'oauth',
      OrgOAuth2: 'org_oauth',
      ScimBearer: 'scim',
    }[scheme];
    const response = await rest.execute(result, {
      auth: {
        type,
        token: 'contract-test',
        tenantId: input.pathParams.tenant_id,
      },
      fetch: async (url, init) => {
        assert.equal(url, result.url);
        assert.equal(init.method, op.method);
        assert.equal(init.redirect, 'error');
        assert.equal(
          init.headers[
            ['pat', 'plan'].includes(type) ? 'X-Figma-Token' : 'Authorization'
          ],
          ['pat', 'plan'].includes(type)
            ? 'contract-test'
            : 'Bearer contract-test',
        );
        assert.equal(
          init.body,
          input.body === undefined ? undefined : JSON.stringify(input.body),
        );
        return Response.json({ contract: op.operationId });
      },
    });
    assert.equal(response.body.contract, op.operationId);
    assert(response.ok);
  }
});
test('REST preflight rejects path injection, unknown parameters and invalid bodies before any network request', () => {
  assert.throws(
    () =>
      rest.prepare({ endpoint: 'getFile', pathParams: { file_key: '../me' } }),
    /Invalid path/,
  );
  assert.throws(
    () =>
      rest.prepare({
        endpoint: 'getFile',
        pathParams: { file_key: 'CloudFile12' },
        query: { access_token: 'secret' },
      }),
    /Unknown query/,
  );
  assert.throws(
    () =>
      rest.prepare({
        endpoint: 'postComment',
        pathParams: { file_key: 'CloudFile12' },
        body: { message: 42 },
        operationId: 'invalid-body-12',
      }),
    /invalid type/,
  );
  assert.throws(
    () =>
      rest.prepare({
        endpoint: 'postComment',
        pathParams: { file_key: 'CloudFile12' },
        body: { message: 'Test' },
      }),
    /stable operationId/,
  );
});
test('credentials stay private, OAuth refresh is atomic, and verified account identities cannot silently change', async (t) => {
  const root = environment(t),
    file = path.join(root, 'credential.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'oauth',
      accessToken: 'old-test-token',
      refreshToken: 'test-refresh',
      clientId: 'client',
      clientSecret: 'test-client-secret',
      expiresAt: '2020-01-01T00:00:00Z',
      accountId: 'user-12',
    }),
    { mode: 0o600 },
  );
  rest.configure({ credentialFile: file });
  const calls = [];
  const send = async (url, options) => {
    calls.push({ url, options });
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (url.endsWith('/refresh'))
      return Response.json({
        access_token: 'new-test-token',
        refresh_token: 'new-test-refresh',
        expires_in: 3600,
      });
    assert.equal(options.headers.Authorization, 'Bearer new-test-token');
    return Response.json({ id: 'user-12' });
  };
  const identities = await Promise.all(
    Array.from({ length: 8 }, () => rest.verifiedCredentials({ fetch: send })),
  );
  const auth = identities[0];
  assert(identities.every((identity) => identity.accountId === auth.accountId));
  assert.equal(auth.accountId, 'user-12');
  assert.equal(calls.length, 2);
  const saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.refreshToken, 'new-test-refresh');
  assert(!JSON.stringify(rest.authStatus()).includes('test-token'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  assert.throws(() => rest.authStatus(), /0600/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...saved,
      accessToken: 'different-test-token',
      accountId: 'other-user',
    }),
  );
  await assert.rejects(
    rest.verifiedCredentials({
      fetch: async () => Response.json({ id: 'actual-user' }),
    }),
    /different account/,
  );
});
test('cloud REST writes share durable deduplication and unknown-outcome barriers with original receipts', async (t) => {
  const root = environment(t);
  process.env.FIGMA_REST_TOKEN = 'test-only-token';
  let calls = 0,
    mode = 'ok';
  const bridge = createBridgeServer({
    port: 0,
    databasePath: path.join(root, 'operations.sqlite'),
    artifactDirectory: path.join(root, 'artifacts'),
    restFetch: async (url) => {
      if (url.endsWith('/v1/me')) return Response.json({ id: 'account-12' });
      calls++;
      if (mode === 'network') throw new Error('socket closed');
      return Response.json({ comments: [{ id: 'comment-12' }] });
    },
  });
  const { url } = await bridge.start();
  t.after(() => bridge.stop());
  const call = async (route, body) => {
    const r = await fetch(url + route, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + bridge.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const request = {
    action: 'request',
    endpoint: 'postComment',
    pathParams: { file_key: 'CloudFile12' },
    body: { message: 'Isolated HTTP fixture' },
    operationId: 'rest-once-1234',
  };
  const pair = await Promise.all([
    call('/v1/rest', request),
    call('/v1/rest', request),
  ]);
  assert(pair.every((r) => r.body.job.status === 'succeeded'));
  assert.equal(calls, 1);
  assert.equal(
    (await call('/v1/rest', { ...request, body: { message: 'Different' } }))
      .status,
    409,
  );
  assert.equal(calls, 1);
  mode = 'network';
  const unknown = await call('/v1/rest', {
    ...request,
    operationId: 'rest-unknown-1234',
  });
  assert.equal(unknown.body.job.status, 'outcome_unknown');
  assert(!JSON.stringify(unknown.body).includes('test-only-token'));
  mode = 'ok';
  const blocked = await call('/v1/rest', {
    ...request,
    operationId: 'rest-blocked-1234',
  });
  assert.equal(blocked.status, 409);
  assert.equal(calls, 2);
  const read = await call('/v1/rest', {
    ...request,
    endpoint: 'getComments',
    body: undefined,
    operationId: 'rest-inspect-1234',
  });
  assert.equal(read.body.job.status, 'succeeded');
  await call('/v1/jobs/rest-unknown-1234/reconcile', {
    outcome: 'not_applied',
    note: 'Fixture server confirmed no comment was stored.',
  });
  assert.equal(
    (
      await call('/v1/rest', {
        ...request,
        operationId: 'rest-after-review-1234',
      })
    ).body.job.status,
    'succeeded',
  );
});
test('REST preserves rate limits and pagination, while submitted server failures remain uncertain', async () => {
  const request = rest.prepare({
    endpoint: 'getFileVersions',
    pathParams: { file_key: 'CloudFile12' },
  });
  const result = await rest.execute(request, {
    auth: { type: 'pat', token: 'test' },
    fetch: async () =>
      Response.json(
        { pagination: { next_page: 'next-12' } },
        {
          status: 429,
          headers: { 'retry-after': '60', 'x-figma-rate-limit-type': 'high' },
        },
      ),
  });
  assert.equal(result.ok, false);
  assert.equal(result.rateLimit.retryAfter, '60');
  assert.equal(result.pagination.next_page, 'next-12');
  assert.equal(result.outcomeUnknown, false);
  const write = rest.prepare({
    endpoint: 'postComment',
    pathParams: { file_key: 'CloudFile12' },
    body: { message: 'Fixture' },
    operationId: 'rest-server-failure',
  });
  assert.equal(
    (
      await rest.execute(write, {
        auth: { type: 'pat', token: 'test' },
        fetch: async () => Response.json({ error: true }, { status: 500 }),
      })
    ).outcomeUnknown,
    true,
  );
});

test('an HTTP success with invalid JSON cannot confirm a cloud read or write', async () => {
  for (const write of [false, true]) {
    const request = rest.prepare({
      endpoint: write ? 'postComment' : 'getFileVersions',
      pathParams: { file_key: 'CloudFile12' },
      ...(write
        ? { body: { message: 'Fixture' }, operationId: 'rest-invalid-json' }
        : {}),
    });
    const result = await rest.execute(request, {
      auth: { type: 'pat', token: 'test' },
      fetch: async () => new Response('<html>sign in</html>', { status: 200 }),
    });
    assert.equal(result.ok, false);
    assert.match(result.semanticError, /JSON/);
    assert.equal(result.outcomeUnknown, write);
  }
});

test('bulk and context REST operations pin all affected files and distinguish HTTP success from resource rejection', async () => {
  const input = {
    endpoint: 'postDevResources',
    operationId: 'rest-bulk-test',
    body: {
      dev_resources: [
        {
          file_key: 'CloudFile12',
          node_id: '1:2',
          name: 'One',
          url: 'https://example.com/one',
        },
        {
          file_key: 'CloudFile34',
          node_id: '3:4',
          name: 'Two',
          url: 'https://example.com/two',
        },
      ],
    },
  };
  const prepared = rest.prepare(input);
  assert.deepEqual(prepared.fileKeys, ['CloudFile12', 'CloudFile34']);
  const { sameFile } = require('../src/host/targets.cjs');
  assert(sameFile(prepared, { fileKey: 'CloudFile34' }));
  assert(!sameFile(prepared, { fileKey: 'OtherFile12' }));
  const rejected = await rest.execute(prepared, {
    auth: { type: 'pat', token: 'fixture' },
    fetch: async () =>
      Response.json({
        links_created: [],
        errors: [{ error: 'File not found' }],
      }),
  });
  assert.equal(rejected.httpStatus, 200);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.outcomeUnknown, false);
  const partial = await rest.execute(prepared, {
    auth: { type: 'pat', token: 'fixture' },
    fetch: async () =>
      Response.json({
        links_created: [{ id: 'link-12' }],
        errors: [{ error: 'File not found' }],
      }),
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.partialApplication, true);
  assert.equal(partial.outcomeUnknown, true);
  assert.equal(
    rest.prepare({
      endpoint: 'getWebhooks',
      query: { context: 'file', context_id: 'CloudFile12' },
    }).fileKey,
    'CloudFile12',
  );
  const description = rest.describe('postDevResources');
  assert(
    description.schemas['#/components/responses/PostDevResourcesResponse'],
  );
  assert(description.authentication.OAuth2);
});

test('organization and SCIM grants coexist with the personal connection and do not require an impossible user identity scope', async (t) => {
  const root = environment(t);
  const save = (name, value) => {
    const file = path.join(root, name + '.json');
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    return file;
  };
  rest.configure({
    credentialFile: save('user', {
      type: 'pat',
      accessToken: 'personal-test',
      accountId: 'person-1',
    }),
  });
  rest.configure({
    credentialProfile: 'org',
    credentialFile: save('org', {
      type: 'org_oauth',
      accessToken: 'org-test',
      accountId: 'org-1',
    }),
  });
  rest.configure({
    credentialProfile: 'scim',
    credentialFile: save('scim', {
      type: 'scim',
      accessToken: 'scim-test',
      accountId: 'org-1',
      tenantId: 'tenant-1',
    }),
  });
  assert.equal(rest.credentials().token, 'personal-test');
  assert.equal(rest.authStatus('org').accountId, 'org-1');
  const request = rest.prepare({
    endpoint: 'getDiscovery',
    query: { start_date: '2026-01-01T00:00:00Z' },
  });
  const org = await rest.verifiedCredentials({
    profile: request.credentialProfile,
    request,
    fetch: async () => {
      throw Error('organization credentials must not call getMe');
    },
  });
  assert.equal(org.type, 'org_oauth');
  let calls = 0;
  const scim = await rest.verifiedCredentials({
    profile: 'scim',
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://www.figma.com/scim/v2/tenant-1');
      assert.equal(init.headers.Authorization, 'Bearer scim-test');
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(calls, 1);
  await assert.rejects(
    rest.execute(
      rest.prepare({
        endpoint: 'scimGetTenant',
        pathParams: { tenant_id: 'another' },
      }),
      { auth: scim },
    ),
    /tenant differs/,
  );
  await assert.rejects(
    rest.execute(request, { auth: rest.credentials() }),
    /OrgOAuth2/,
  );
  await assert.rejects(
    rest.execute(
      { ...request, url: 'https://example.com/v1/discovery' },
      { auth: org },
    ),
    /official service/,
  );
  await assert.rejects(
    rest.execute(
      { ...request, url: 'https://api.figma.com/v1/me' },
      { auth: org },
    ),
    /official service/,
  );
  await assert.rejects(
    rest.execute({ ...request, method: 'DELETE' }, { auth: org }),
    /official service/,
  );
  assert(!JSON.stringify(rest.authStatus('scim')).includes('scim-test'));
  assert.equal(
    rest.prepare({
      endpoint: 'scimGetUsers',
      pathParams: { tenant_id: 'tenant-1' },
      operationId: 'scim-read-bind-12',
    }).readOnly,
    false,
  );
});

test('every documented supplemental route sends the correct service authentication and preserves its actual response', async () => {
  for (const op of rest.operations.filter((o) => o.source)) {
    const input = {
      endpoint: op.operationId,
      operationId: 'transport-' + op.operationId,
      pathParams: {},
      query: {},
    };
    for (const p of op.parameters)
      if (p.required) {
        const value =
          p.name === 'start_date' ? '2026-01-01T00:00:00Z' : 'tenant-12';
        (p.in === 'path' ? input.pathParams : input.query)[p.name] = value;
      }
    if (op.requestBody)
      input.body = sample(op.requestBody.content['application/json'].schema);
    const req = rest.prepare(input);
    const value = await rest.execute(req, {
      auth: {
        type: op.credentialProfile === 'scim' ? 'scim' : 'org_oauth',
        token: 'test-supplement',
        tenantId: 'tenant-12',
      },
      fetch: async (url, init) => {
        assert.equal(url, req.url);
        assert.equal(init.method, op.method);
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, 'Bearer test-supplement');
        if (input.body) assert.deepEqual(JSON.parse(init.body), input.body);
        return op.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({ test: op.operationId });
      },
    });
    assert(value.ok);
    if (op.method !== 'DELETE') assert.equal(value.body.test, op.operationId);
  }
  assert.throws(
    () =>
      rest.prepare({
        endpoint: 'getDiscovery',
        query: {
          start_date: '2026-01-01T00:00:00Z',
          end_date: '2026-01-03T00:00:00Z',
        },
      }),
    /24 hours/,
  );
});
