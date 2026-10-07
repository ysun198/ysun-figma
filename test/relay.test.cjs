const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readLedger, seedLedger } = require('./helpers/ledger.cjs');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const {
  createBridgeServer,
  CLIENT_LEASE_MS,
  SESSION_TTL_MS,
  PAIRING_TTL_MS,
  MAX_RUN_MS,
} = require('../src/host/bridge-server.cjs');
const { BRIDGE_RUNTIME_VERSION } = require('../src/shared/core.js');
const { targetIdentity } = require('../src/host/targets.cjs');
async function setup(t, options = {}) {
  const bridge = createBridgeServer({ port: 0, ...options });
  const { url } = await bridge.start();
  t.after(() => bridge.stop());
  const call = async (
    route,
    body,
    secret = bridge.token,
    headers = {},
    method,
  ) => {
    const response = await fetch(url + route, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  };
  const pair = async (
    id = 'client-alpha',
    fileName = 'Audit file',
    metadata = {},
  ) => {
    const code = (await call('/v1/pairings', {})).body.code;
    const response = await call(
      '/v1/pair',
      {
        code,
        clientId: id,
        fileName,
        runtimeVersion: BRIDGE_RUNTIME_VERSION,
        ...metadata,
      },
      '',
    );
    assert.equal(response.status, 200);
    return { id, token: response.body.token, code };
  };
  const submit = async (clientId, extra = {}) => {
    const client =
      (await call('/v1/status?summary=1')).body.clients.find(
        (client) => client.id === clientId,
      ) || bridge.clients.get(clientId);
    return call('/v1/jobs', {
      kind: 'exec',
      operationId: randomUUID(),
      source: 'return 42;',
      target: client ? targetIdentity(client) : undefined,
      ...extra,
    });
  };
  const claim = async (client) =>
    call(`/v1/jobs/next?clientId=${client.id}&wait=1`, null, client.token);
  return { bridge, url, call, pair, submit, claim };
}
test('verified cloud identities separate copied documents and preserve unknown-write barriers across connections', async (t) => {
  const api = await setup(t);
  const original = await api.pair('scope-original-client', 'Original', {
    documentId: 'a'.repeat(32),
    fileKey: 'OriginalFile12',
  });
  const copy = await api.pair('scope-copy-client', 'Copy', {
    documentId: 'a'.repeat(32),
    fileKey: 'DifferentFile12',
  });
  const reopened = await api.pair('scope-another-client', 'Original', {
    documentId: 'b'.repeat(32),
    fileKey: 'OriginalFile12',
  });
  const {
    body: { job },
  } = await api.submit(original.id);
  await api.claim(original);
  await api.call(
    `/v1/jobs/${job.id}/result`,
    {
      clientId: original.id,
      outcomeUnknown: true,
    },
    original.token,
  );
  const copied = await api.submit(copy.id);
  assert.equal(
    copied.status,
    202,
    'copied plugin metadata does not join different cloud files',
  );
  assert.equal((await api.claim(copy)).body.job.id, copied.body.job.id);
  const sameFile = await api.submit(reopened.id);
  assert.equal(
    sameFile.status,
    409,
    'a new connection cannot bypass the original cloud file receipt',
  );
  assert.deepEqual(sameFile.body.blockingOperationIds, [job.id]);
});
test('same-file instances serialize claims and recheck unknown writes queued before the original receipt', async (t) => {
  const api = await setup(t);
  const first = await api.pair('queue-first-client', 'Shared file', {
    documentId: 'a'.repeat(32),
    fileKey: 'SharedFile12',
  });
  const second = await api.pair('queue-second-client', 'Shared file', {
    documentId: 'b'.repeat(32),
    fileKey: 'SharedFile12',
  });
  const original = await api.submit(first.id);
  const queued = await api.submit(second.id);
  await api.claim(first);
  assert.equal(
    (await api.claim(second)).status,
    204,
    'concurrent claims share one file execution boundary',
  );
  await api.call(
    `/v1/jobs/${original.body.job.id}/result`,
    {
      clientId: first.id,
      outcomeUnknown: true,
    },
    first.token,
  );
  assert.equal(
    (await api.claim(second)).status,
    204,
    'an already accepted write cannot bypass a later uncertain receipt',
  );
  const read = await api.submit(second.id, { options: { readOnly: true } });
  assert.equal((await api.claim(second)).body.job.id, read.body.job.id);
  await api.call(
    `/v1/jobs/${read.body.job.id}/result`,
    {
      clientId: second.id,
      ok: true,
    },
    second.token,
  );
  await api.call(`/v1/jobs/${original.body.job.id}/reconcile`, {
    outcome: 'not_applied',
    note: 'Inspected the original file before allowing the queued write.',
  });
  assert.equal((await api.claim(second)).body.job.id, queued.body.job.id);
});
test('a failed reconciliation commit leaves the original write blocked until durable confirmation', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-reconcile-commit-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'operations.sqlite');
  const api = await setup(t, { databasePath });
  const client = await api.pair();
  const {
    body: { job },
  } = await api.submit(client.id, {
    operationId: 'uncertain-before-reconcile-commit',
  });
  await api.claim(client);
  await api.call(
    `/v1/jobs/${job.id}/result`,
    {
      clientId: client.id,
      outcomeUnknown: true,
      error: 'native write was interrupted',
    },
    client.token,
  );
  const decision = {
    outcome: 'partially_applied',
    note: 'Inspected the original canvas.',
  };
  const locked = new DatabaseSync(databasePath);
  locked.exec(`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON operations
    BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END;`);
  try {
    assert.equal(
      (await api.call(`/v1/jobs/${job.id}/reconcile`, decision)).status,
      500,
    );
    const observed = (await api.call(`/v1/jobs/${job.id}`)).body.job;
    assert.equal(observed.reconciledAt, undefined);
    assert.equal(observed.reconciliation, undefined);
    assert.equal(
      (
        await api.submit(client.id, {
          operationId: 'write-before-durable-confirmation',
        })
      ).status,
      409,
    );
  } finally {
    locked.exec('DROP TRIGGER reject_confirmation');
    locked.close();
  }
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}/reconcile`, decision)).status,
    200,
  );
  await api.bridge.stop();
  const restarted = await setup(t, { databasePath });
  assert.deepEqual(
    (await restarted.call(`/v1/jobs/${job.id}`)).body.job.reconciliation,
    decision,
  );
});
test('anonymous bootstrap reveals no credential; pairing is one-use and plugin privileges are scoped', async (t) => {
  const api = await setup(t);
  const boot = await api.call('/v1/status', null, '', { Origin: 'null' });
  assert.equal(boot.status, 401);
  assert.equal(boot.body.token, undefined);
  assert.equal(boot.headers.get('access-control-allow-origin'), 'null');
  assert.equal(
    (await api.call('/v1/jobs', { kind: 'exec', source: 'return 42;' }, ''))
      .status,
    401,
  );
  const client = await api.pair();
  const reused = await api.call(
    '/v1/pair',
    {
      code: client.code,
      clientId: 'client-another',
      fileName: 'Other',
      runtimeVersion: BRIDGE_RUNTIME_VERSION,
    },
    '',
  );
  assert.equal(reused.status, 401);
  assert.equal(
    (
      await api.call(
        '/v1/jobs',
        { kind: 'exec', source: 'return 42;' },
        client.token,
      )
    ).status,
    403,
  );
  assert.equal((await api.call('/v1/status', null, client.token)).status, 403);
  assert.equal(
    (
      await api.call(
        '/v1/jobs/next?clientId=someone-else&wait=1',
        null,
        client.token,
      )
    ).status,
    403,
  );
});
test('host and origin checks protect loopback, and stale runtimes cannot pair', async (t) => {
  const api = await setup(t);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(
      api.url + '/v1/status',
      { headers: { Host: 'attacker.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal(
    (
      await api.call('/v1/status', null, '', {
        Origin: 'https://attacker.example',
      })
    ).status,
    403,
  );
  const code = (await api.call('/v1/pairings', {})).body.code;
  assert.equal(
    (
      await api.call(
        '/v1/pair',
        { code, clientId: 'client-legacy', fileName: 'Old', runtimeVersion: 6 },
        '',
      )
    ).status,
    409,
  );
});
test('a plugin can disconnect itself without gaining access to another paired file', async (t) => {
  const api = await setup(t);
  const a = await api.pair('client-alpha'),
    b = await api.pair('client-bravo');
  assert.equal(
    (await api.call(`/v1/clients/${b.id}`, null, a.token, {}, 'DELETE')).status,
    403,
  );
  assert.equal(
    (await api.call(`/v1/clients/${a.id}`, null, a.token, {}, 'DELETE')).status,
    200,
  );
  assert.equal(
    (await api.call('/v1/clients/heartbeat', {}, a.token)).status,
    401,
  );
  assert.equal(
    (await api.call('/v1/clients/heartbeat', {}, b.token)).status,
    200,
  );
});
test('workbench waits follow native revisions and write receipts through the same ledger, without native polling jobs', async (t) => {
  const api = await setup(t);
  const client = await api.pair();
  await api.call(
    '/v1/clients/heartbeat',
    { fileKey: 'CloudFile1', pageId: '0:1', documentRevision: 1 },
    client.token,
  );
  await api.call('/v1/catalog', {
    status: 'ready',
    accountId: '123',
    files: [{ fileKey: 'CloudFile1', name: 'Native file' }],
  });
  const initial = (await api.call('/v1/app')).body;
  assert.match(initial.cursor, /^sha256:[a-f0-9]{64}$/);
  assert.equal(initial.files[0].sessions[0].writing, false);
  let settled = false;
  const wait = api
    .call('/v1/app?waitMs=1000&cursor=' + initial.cursor)
    .then((response) => {
      settled = true;
      return response;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await api.call('/v1/clients/heartbeat', {}, client.token);
  assert.equal((await api.call('/v1/app')).body.cursor, initial.cursor);
  assert.equal(
    settled,
    false,
    'ordinary presence heartbeats do not fabricate a document change',
  );
  await api.call(
    '/v1/clients/heartbeat',
    { documentRevision: 2 },
    client.token,
  );
  const changed = (await wait).body;
  assert.notEqual(changed.cursor, initial.cursor);
  assert.equal(changed.files[0].sessions[0].documentRevision, 2);
  assert.equal((await api.call('/v1/status')).body.jobs.length, 0);
  const queued = await api.submit(client.id, {
    operationId: 'workbench-write',
  });
  assert.equal(queued.status, 202);
  const writing = (await api.call('/v1/app')).body;
  assert.equal(writing.files[0].sessions[0].writing, true);
  await api.claim(client);
  assert.equal((await api.call('/v1/app')).body.cursor, writing.cursor);
  const receiptWait = api.call('/v1/app?waitMs=1000&cursor=' + writing.cursor);
  const receipt = await api.call(
    '/v1/jobs/workbench-write/result',
    {
      clientId: client.id,
      ok: true,
      result: { value: { nodeId: '1:1' } },
      context: { documentRevision: 3 },
    },
    client.token,
  );
  assert.equal(receipt.status, 200);
  const finished = (await receiptWait).body;
  assert.equal(finished.files[0].sessions[0].writing, false);
  assert.equal(finished.files[0].sessions[0].documentRevision, 3);
  assert.notEqual(finished.cursor, writing.cursor);
  assert.equal((await api.call('/v1/status')).body.jobs.length, 1);
  assert.equal(JSON.stringify(finished).includes(client.token), false);
});
test('workbench cursors wake on catalog account changes and disconnects, time out unchanged and remain admin-only', async (t) => {
  const api = await setup(t);
  const client = await api.pair();
  const initial = (await api.call('/v1/app')).body;
  const pending = api.call('/v1/app?cursor=' + initial.cursor + '&waitMs=1000');
  await api.call('/v1/catalog', {
    status: 'ready',
    accountId: '321',
    files: [{ fileKey: 'CloudFile1', name: 'Account file' }],
  });
  const updated = (await pending).body;
  assert.equal(updated.catalog.accountId, '321');
  assert.equal(updated.files[0].fileKey, 'CloudFile1');
  assert.deepEqual(
    (await api.call('/v1/app?cursor=' + updated.cursor + '&waitMs=10')).body,
    updated,
  );
  assert.equal((await api.call('/v1/app', null, client.token)).status, 403);
  assert.equal((await api.call('/v1/app?cursor=invalid&waitMs=1')).status, 400);
  assert.equal((await api.call('/v1/app?waitMs=25001')).status, 400);
  await api.call(
    '/v1/clients/heartbeat',
    { fileKey: 'CloudFile1' },
    client.token,
  );
  const connected = (await api.call('/v1/app')).body;
  assert.equal(connected.files[0].connected, true);
  const disconnected = api.call(
    '/v1/app?cursor=' + connected.cursor + '&waitMs=1000',
  );
  await api.call('/v1/clients/' + client.id, null, client.token, {}, 'DELETE');
  assert.equal((await disconnected).body.files[0].connected, false);
});
test('same-name sessions are rejected and explicit client binding cannot be claimed by another file', async (t) => {
  const api = await setup(t);
  const a = await api.pair('client-alpha', 'Untitled'),
    b = await api.pair('client-bravo', 'Untitled');
  assert.equal(
    (
      await api.call('/v1/jobs', {
        kind: 'exec',
        source: 'return 42;',
        targetFileName: 'Untitled',
      })
    ).status,
    400,
  );
  assert.equal(
    (await api.call('/v1/jobs', { kind: 'exec', source: 'return 42;' })).status,
    400,
  );
  const queued = await api.submit(b.id);
  assert.equal(queued.status, 202);
  assert.equal(queued.body.job.target.clientId, b.id);
  assert.equal((await api.claim(a)).status, 204);
  assert.equal((await api.claim(b)).body.job.id, queued.body.job.id);
});

test('job target retains verified cloud identity and native versions after live metadata changes', async (t) => {
  const api = await setup(t),
    code = (await api.call('/v1/pairings', {})).body.code;
  const documentId = 'a'.repeat(32),
    instanceId = 'b'.repeat(32),
    clientId = 'snapshot-native-client',
    fileKey = 'SnapshotFile123';
  const paired = await api.call(
    '/v1/pair',
    {
      code,
      clientId,
      documentId,
      instanceId,
      fileName: 'Original name',
      editorType: 'figma',
      runtimeVersion: BRIDGE_RUNTIME_VERSION,
      nativeBuild: 'a'.repeat(64),
    },
    '',
  );
  assert.equal(paired.status, 200);
  assert.equal(
    (
      await api.call('/v1/catalog/bind', {
        clientId,
        documentId,
        fileKey,
        verifiedUrl: 'https://www.figma.com/design/' + fileKey,
      })
    ).status,
    200,
  );
  const queued = await api.submit(clientId, {
    operationId: 'snapshot-operation',
  });
  assert.equal(queued.status, 202);
  assert.deepEqual(queued.body.job.target, {
    clientId,
    documentId,
    instanceId,
    fileKey,
    fileName: 'Original name',
    editorType: 'figma',
    runtimeVersion: BRIDGE_RUNTIME_VERSION,
    nativeBuild: 'a'.repeat(64),
  });
  await api.call(
    '/v1/clients/heartbeat',
    { fileName: 'Renamed', nativeBuild: 'b'.repeat(64) },
    paired.body.token,
  );
  assert.deepEqual(
    (await api.call('/v1/jobs/snapshot-operation')).body.job.target,
    queued.body.job.target,
  );
});
test('operation IDs and identical receipts are idempotent, conflicting receipts are rejected', async (t) => {
  const api = await setup(t),
    client = await api.pair();
  const extra = { operationId: 'operation-stable-123' };
  const queued = await api.submit(client.id, extra),
    repeated = await api.submit(client.id, extra);
  assert.equal(repeated.status, 200);
  assert.equal((await api.call('/v1/status?summary=1')).body.jobCount, 1);
  assert.equal(
    (await api.submit(client.id, { ...extra, source: 'return 43;' })).status,
    409,
  );
  await api.claim(client);
  assert.equal((await api.claim(client)).status, 204);
  const receipt = {
    clientId: client.id,
    ok: true,
    result: { nodeIdMap: { root: '10:1' } },
    context: { fileName: 'Renamed file', pageName: 'New page' },
  };
  const route = `/v1/jobs/${queued.body.job.id}/result`;
  assert.equal((await api.call(route, receipt, client.token)).status, 200);
  assert.equal(
    (await api.call('/v1/status')).body.clients[0].pageName,
    'New page',
  );
  assert.equal((await api.call(route, receipt, client.token)).status, 200);
  assert.equal(
    (
      await api.call(
        route,
        { ...receipt, result: { changed: true } },
        client.token,
      )
    ).status,
    409,
  );
  assert.equal((await api.claim(client)).status, 204);
});
test('a delayed heartbeat does not end a claimed write or allow another delivery', async (t) => {
  let clock = 10000;
  const api = await setup(t, { now: () => clock }),
    client = await api.pair();
  const {
    body: { job },
  } = await api.submit(client.id);
  await api.claim(client);
  clock += CLIENT_LEASE_MS + 1;
  const status = (await api.call('/v1/status')).body;
  assert.equal(status.clients.length, 0);
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'running',
  );
  assert.equal((await api.submit(client.id)).status, 409);
  await api.call('/v1/clients/heartbeat', {}, client.token);
  const queued = await api.submit(client.id);
  assert.equal(queued.status, 202);
  assert.equal((await api.claim(client)).status, 204);
  await api.call(
    `/v1/jobs/${job.id}/result`,
    { clientId: client.id, ok: true, result: { complete: true } },
    client.token,
  );
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'succeeded',
  );
  assert.equal((await api.claim(client)).body.job.id, queued.body.job.id);
});
test('a claimed write reaches its execution deadline and a late receipt reconciles it without replay', async (t) => {
  let clock = 10000;
  const api = await setup(t, { now: () => clock }),
    client = await api.pair();
  const {
    body: { job },
  } = await api.submit(client.id);
  await api.claim(client);
  clock += MAX_RUN_MS;
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'outcome_unknown',
  );
  await api.call('/v1/clients/heartbeat', {}, client.token);
  assert.equal((await api.submit(client.id)).status, 409);
  await api.call(
    `/v1/jobs/${job.id}/result`,
    { clientId: client.id, ok: true, result: { complete: true } },
    client.token,
  );
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'succeeded',
  );
  assert.equal((await api.claim(client)).status, 204);
});
test('revoking the session ends its pending claimed write as unknown', async (t) => {
  const api = await setup(t),
    client = await api.pair();
  const {
    body: { job },
  } = await api.submit(client.id);
  await api.claim(client);
  await api.call(
    `/v1/clients/${client.id}`,
    null,
    api.bridge.token,
    {},
    'DELETE',
  );
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'outcome_unknown',
  );
  assert.equal((await api.claim(client)).status, 401);
});
test('heartbeats keep long operations alive, but session credentials expire', async (t) => {
  let clock = 10000;
  const api = await setup(t, { now: () => clock }),
    client = await api.pair();
  const {
    body: { job },
  } = await api.submit(client.id);
  await api.claim(client);
  for (let i = 0; i < 4; i++) {
    clock += 30000;
    await api.call('/v1/clients/heartbeat', {}, client.token);
  }
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'running',
  );
  clock += SESSION_TTL_MS;
  assert.equal(
    (await api.call('/v1/clients/heartbeat', {}, client.token)).status,
    401,
  );
});
test('expired pairing codes, expired queues, and revoked clients cannot cause a write', async (t) => {
  let clock = 10000;
  const api = await setup(t, { now: () => clock });
  const code = (await api.call('/v1/pairings', {})).body.code;
  clock += PAIRING_TTL_MS + 1;
  assert.equal(
    (
      await api.call(
        '/v1/pair',
        {
          code,
          clientId: 'client-expired',
          fileName: 'Old',
          runtimeVersion: BRIDGE_RUNTIME_VERSION,
        },
        '',
      )
    ).status,
    401,
  );
  const client = await api.pair();
  const {
    body: { job },
  } = await api.submit(client.id, { expiresInMs: 1000 });
  clock += 1001;
  assert.equal((await api.claim(client)).status, 204);
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'failed',
  );
  await api.call(
    `/v1/clients/${client.id}`,
    null,
    api.bridge.token,
    {},
    'DELETE',
  );
  assert.equal((await api.claim(client)).status, 401);
});
test('journal survives relay restart and running work is never silently replayed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-relay-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'operations.sqlite');
  const first = await setup(t, { databasePath }),
    client = await first.pair();
  const {
    body: { job },
  } = await first.submit(client.id);
  await first.claim(client);
  await first.bridge.stop();
  const next = await setup(t, { databasePath });
  assert.notEqual(first.bridge.token, next.bridge.token);
  assert.equal(
    (await next.call('/v1/status', null, first.bridge.token)).status,
    401,
  );
  assert.equal(
    (await next.call(`/v1/jobs/${job.id}`)).body.job.status,
    'outcome_unknown',
  );
  assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
  assert.equal(readLedger(databasePath).jobs[0].spec, undefined);
});
test('read-only native font queries use the paired transport without canvas writes', async (t) => {
  const api = await setup(t),
    client = await api.pair();
  const submitted = await api.call('/v1/jobs', {
    kind: 'exec',
    source: 'return await figma.listAvailableFontsAsync();',
    operationId: 'native-font-query',
    target: targetIdentity(api.bridge.clients.get(client.id)),
    options: { readOnly: true, commitUndo: false },
  });
  assert.equal(submitted.status, 202);
  const received = await api.claim(client);
  assert.equal(received.body.job.kind, 'exec');
  assert.equal(received.body.job.options.readOnly, true);
  assert.equal(received.body.job.spec, undefined);
});
test('native script jobs are authenticated, targeted, hashed and keep source/assets out of journals', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-script-relay-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'operations.sqlite');
  const api = await setup(t, { databasePath }),
    client = await api.pair();
  const { uploadAssets } = require('../src/host/artifact-client.cjs');
  const source = path.join(directory, 'image.bin');
  fs.writeFileSync(source, Buffer.from([0, 1]));
  const assets = await uploadAssets(
    { url: api.url, token: api.bridge.token, protocolVersion: 3 },
    { image: source },
  );
  const request = {
    kind: 'exec',
    source: 'return args;',
    args: { title: 'Local' },
    assets,
    target: targetIdentity(api.bridge.clients.get(client.id)),
    operationId: 'native-script-001',
  };
  assert.equal((await api.call('/v1/jobs', request, client.token)).status, 403);
  const queued = await api.call('/v1/jobs', request);
  assert.equal(queued.status, 202);
  assert.equal(queued.body.job.source, undefined);
  assert.match(queued.body.job.sourceHash, /^sha256:/);
  assert.equal((await api.call('/v1/jobs', request)).status, 200);
  assert.equal(
    (await api.call('/v1/jobs', { ...request, source: 'figma.createFrame();' }))
      .status,
    409,
  );
  const claimed = (await api.claim(client)).body.job;
  assert.equal(claimed.source, request.source);
  assert.deepEqual(claimed.args, request.args);
  assert.deepEqual(claimed.assets, request.assets);
  assert.deepEqual(claimed.options, {
    commitUndo: true,
    readOnly: false,
    operationId: request.operationId,
  });
  const stored = readLedger(databasePath).jobs[0];
  for (const name of ['source', 'args', 'assets'])
    assert.equal(stored[name], undefined);
  assert.equal(
    (
      await api.call('/v1/jobs', {
        ...request,
        operationId: 'native-script-002',
        assets: { image: 'invalid' },
      })
    ).status,
    400,
  );
});

test('an occupied port cannot rewrite a running relay journal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-relay-bind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'operations.sqlite');
  const api = await setup(t, { databasePath }),
    client = await api.pair();
  const queued = await api.submit(client.id, {
    operationId: 'bind-preserved-operation',
  });
  await api.claim(client);
  const before = readLedger(databasePath);
  const collision = createBridgeServer({
    databasePath,
    port: Number(new URL(api.url).port),
  });
  await assert.rejects(collision.start(), /EADDRINUSE/);
  await collision.stop();
  assert.deepEqual(readLedger(databasePath), before);
  assert.equal(
    (await api.call(`/v1/jobs/${queued.body.job.id}`)).body.job.status,
    'running',
  );
});
test('unknown outcomes remain visible beyond the retention window and recent-history limit', async (t) => {
  let clock = 10000;
  const api = await setup(t, { now: () => clock }),
    lost = await api.pair('client-lost');
  const id = 'unresolved-old-operation';
  await api.submit(lost.id, { operationId: id });
  await api.claim(lost);
  clock += SESSION_TTL_MS + 1;
  assert.equal(
    (await api.call(`/v1/jobs/${id}`)).body.job.status,
    'outcome_unknown',
  );
  const client = await api.pair('client-current');
  for (let i = 0; i < 25; i++) {
    const job = (
      await api.submit(client.id, { operationId: `recent-operation-${i}` })
    ).body.job;
    await api.claim(client);
    await api.call(
      `/v1/jobs/${job.id}/result`,
      { clientId: client.id, ok: true, result: {} },
      client.token,
    );
  }
  const status = (await api.call('/v1/status?summary=1')).body;
  assert.equal(status.jobCount, 26);
  assert.equal(status.jobCounts.outcome_unknown, 1);
  assert.equal(status.unresolvedJobCount, 1);
  assert.deepEqual(status.jobs, []);
  assert.equal(status.jobsTruncated, true);
  assert(
    (await api.call('/v1/status?summary=1&scope=all')).body.jobs.some(
      (j) => j.id === id,
    ),
  );
  assert.equal(
    (await api.call('/v1/status?summary=1&clientId=' + client.id)).body
      .clients[0].id,
    client.id,
  );
  assert.equal(
    (await api.call('/v1/status?summary=1&clientId=disconnected')).status,
    400,
  );
  assert.equal(
    (await api.call('/v1/status?summary=1&scope=all&clientId=' + client.id))
      .status,
    400,
  );
  clock += 8 * 24 * 60 * 60 * 1000;
  assert.equal(
    (await api.call(`/v1/jobs/${id}`)).body.job.status,
    'outcome_unknown',
  );
});
test('a newer relay process preserves unresolved receipts loaded from disk', async (t) => {
  let clock = 10000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-relay-unresolved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'operations.sqlite');
  const a = await setup(t, { databasePath, now: () => clock }),
    client = await a.pair();
  const id = 'unknown-across-relay-restart';
  await a.submit(client.id, { operationId: id });
  await a.claim(client);
  clock += MAX_RUN_MS;
  await a.call('/v1/status');
  await a.bridge.stop();
  clock += 8 * 24 * 60 * 60 * 1000;
  const b = await setup(t, { databasePath, now: () => clock });
  assert.equal(
    (await b.call(`/v1/jobs/${id}`)).body.job.status,
    'outcome_unknown',
  );
});

test('recovery heartbeat reports only the original client actions without changing their state', async (t) => {
  const api = await setup(t),
    a = await api.pair('client-recovery-a'),
    b = await api.pair('client-recovery-b');
  const job = (
    await api.submit(a.id, { operationId: 'claimed-recovery-fixture' })
  ).body.job;
  await api.claim(a);
  const recovered = await api.call('/v1/clients/heartbeat', {}, a.token);
  assert.deepEqual(recovered.body.recovery, {
    active: [job.id],
    unresolved: [],
  });
  assert.deepEqual(
    (await api.call('/v1/clients/heartbeat', {}, b.token)).body.recovery,
    { active: [], unresolved: [] },
  );
  assert.equal(
    (await api.call(`/v1/jobs/${job.id}`)).body.job.status,
    'running',
  );
  await api.call(
    `/v1/jobs/${job.id}/result`,
    {
      clientId: a.id,
      ok: false,
      outcomeUnknown: true,
      error: 'simulated partial operation',
    },
    a.token,
  );
  assert.deepEqual(
    (await api.call('/v1/clients/heartbeat', {}, a.token)).body.recovery,
    { active: [], unresolved: [job.id] },
  );
});
test('reconciled uncertain operations release capacity while their IDs and reconciliation survive restart', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-resolved-capacity-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'operations.sqlite'),
    api = await setup(t, { databasePath }),
    client = await api.pair();
  for (let i = 0; i < 200; i++) {
    const operationId = 'resolved-operation-' + i;
    assert.equal((await api.submit(client.id, { operationId })).status, 202);
    await api.claim(client);
    await api.call(
      `/v1/jobs/${operationId}/result`,
      {
        clientId: client.id,
        ok: false,
        outcomeUnknown: true,
        error: 'partial',
      },
      client.token,
    );
    assert.equal(
      (
        await api.call(`/v1/jobs/${operationId}/reconcile`, {
          outcome: 'applied',
          note: 'Inspected the original node IDs.',
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await api.submit(client.id, {
        operationId: 'capacity-after-reconciliation',
      })
    ).status,
    202,
  );
  const archived = (await api.call('/v1/jobs/resolved-operation-0')).body.job;
  assert.equal(archived.archived, true);
  assert.equal(archived.reconciliation.outcome, 'applied');
  await api.bridge.stop();
  const next = await setup(t, { databasePath });
  const restored = (await next.call('/v1/jobs/resolved-operation-0')).body.job;
  assert.deepEqual(restored.reconciliation, archived.reconciliation);
  assert.equal(restored.reconciledAt, archived.reconciledAt);
});
test('unresolved history preserves receipts without blocking the reads needed for recovery', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-recovery-capacity-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'operations.sqlite'),
    clientId = 'client-recovery-capacity';
  const jobs = Array.from({ length: 200 }, (_, i) => ({
    id: 'uncertain-operation-' + i,
    kind: 'exec',
    status: 'outcome_unknown',
    clientId,
    target: { clientId },
    options: { readOnly: false },
    createdAt: Date.now(),
    finishedAt: Date.now(),
    error: 'Original partial write',
  }));
  seedLedger(databasePath, jobs);
  const api = await setup(t, { databasePath }),
    client = await api.pair(clientId);
  assert.equal(
    (await api.submit(client.id, { operationId: 'unsafe-new-write' })).status,
    409,
  );
  const read = await api.submit(client.id, {
    operationId: 'recovery-read',
    options: { readOnly: true },
  });
  assert.equal(read.status, 202);
  assert.equal((await api.claim(client)).body.job.id, 'recovery-read');
  assert.equal(
    (await api.call('/v1/jobs/uncertain-operation-0')).body.job.error,
    'Original partial write',
  );
  await api.call(
    '/v1/jobs/recovery-read/result',
    { clientId: client.id, ok: true, result: { observed: true } },
    client.token,
  );
  await api.bridge.stop();
  const restored = await setup(t, { databasePath });
  assert.equal(
    (await restored.call('/v1/jobs/uncertain-operation-199')).body.job.status,
    'outcome_unknown',
  );
  assert.equal(
    (await restored.call('/v1/jobs/recovery-read')).body.job.status,
    'succeeded',
  );
});
test('in-flight capacity remains bounded without discarding accepted jobs', async (t) => {
  const api = await setup(t),
    client = await api.pair();
  for (let i = 0; i < 200; i++)
    assert.equal(
      (await api.submit(client.id, { operationId: 'pending-operation-' + i }))
        .status,
      202,
    );
  assert.equal(
    (
      await api.submit(client.id, {
        operationId: 'excess-read',
        options: { readOnly: true },
      })
    ).status,
    429,
  );
  assert.equal((await api.call('/v1/status?summary=1')).body.jobCount, 200);
  assert.equal(
    (await api.call('/v1/jobs/pending-operation-0')).body.job.status,
    'queued',
  );
});
test('relay restart retains receipts but does not pretend an in-memory pairing survived', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-reconnect-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'operations.sqlite');
  const first = await setup(t, { databasePath }),
    client = await first.pair('restart-fixture');
  const job = (
    await first.submit(client.id, { operationId: 'restart-known-request' })
  ).body.job;
  await first.bridge.stop();
  const next = await setup(t, { databasePath });
  assert.equal(
    (await next.call('/v1/clients/heartbeat', {}, client.token)).status,
    401,
  );
  assert.equal(
    (await next.call(`/v1/jobs/${job.id}`)).body.job.status,
    'failed',
  );
  assert.equal((await next.call('/v1/status?summary=1')).body.jobCount, 1);
});
