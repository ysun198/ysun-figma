const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { bridgeStateDirectory, writePrivateJson } = require('./state.cjs');
const reference = path.resolve(__dirname, '../../skills/ysun-figma/references');
const spec = require(path.join(reference, 'rest-api.json'));
const provenance = require(path.join(reference, 'REST-API-SOURCE.json'));
const supplement = require('./rest-supplement.cjs');
const operations = Object.entries(spec.paths).flatMap(([route, item]) =>
  Object.entries(item)
    .filter(([method]) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method),
    )
    .map(([method, operation]) => ({
      ...operation,
      method: method.toUpperCase(),
      route,
      parameters: [...(item.parameters || []), ...(operation.parameters || [])],
    })),
);
operations.push(...supplement.operations);
const failure = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });
const configPath = () => path.join(bridgeStateDirectory(), 'rest/config.json');
function privateJson(file) {
  if (!path.isAbsolute(file))
    throw failure(
      'REST_AUTH_INVALID',
      'Credential file must be an absolute path',
    );
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.size > 65536
  )
    throw failure(
      'REST_AUTH_INVALID',
      'Credential file must be an owned regular file with mode 0600',
    );
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function credentials(profile = 'default') {
  if (!['default', 'org', 'scim'].includes(profile))
    throw failure('REST_AUTH_INVALID', 'Unknown credential profile');
  const config = fs.existsSync(configPath()) ? privateJson(configPath()) : {};
  const credentialFile =
    profile === 'default'
      ? process.env.FIGMA_REST_CREDENTIAL_FILE || config.credentialFile
      : config.profiles?.[profile]?.credentialFile;
  const saved = credentialFile ? privateJson(credentialFile) : {};
  const fromEnvironment = profile === 'default' && process.env.FIGMA_REST_TOKEN;
  const token = fromEnvironment || saved.accessToken;
  if (token && (typeof token !== 'string' || /[\r\n]/.test(token)))
    throw failure('REST_AUTH_INVALID', 'Invalid access token');
  return {
    ...saved,
    token,
    credentialFile,
    profile,
    type: fromEnvironment
      ? process.env.FIGMA_REST_TOKEN_TYPE || 'pat'
      : saved.type || 'pat',
    accountId:
      (profile === 'default'
        ? config.accountId
        : config.profiles?.[profile]?.accountId) ||
      saved.accountId ||
      null,
    source: fromEnvironment
      ? 'environment'
      : credentialFile
        ? 'private_file'
        : null,
  };
}
const verified = new Map();
const verifying = new Map();
async function verifiedCredentials({
  fetch: send = fetch,
  profile = 'default',
  request,
} = {}) {
  const auth = credentials(profile);
  if (request) assertAuthentication(request, auth);
  const key = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        auth.type,
        auth.token,
        auth.credentialFile,
        auth.accountId,
        profile,
      ]),
    )
    .digest('hex');
  if (verifying.has(key)) return verifying.get(key);
  const task = verifyCredentials(send, profile);
  verifying.set(key, task);
  try {
    return await task;
  } finally {
    if (verifying.get(key) === task) verifying.delete(key);
  }
}
async function verifyCredentials(send, profile) {
  let auth = credentials(profile);
  if (!auth.token)
    throw failure(
      'REST_AUTH_REQUIRED',
      'Figma ' +
        profile +
        ' API connection is not configured; this service needs its own authorized credential',
      { phase: 'preflight' },
    );
  if (
    ['oauth', 'org_oauth'].includes(auth.type) &&
    auth.expiresAt &&
    Date.now() + 30000 >= Date.parse(auth.expiresAt)
  ) {
    if (
      !auth.refreshToken ||
      !auth.clientId ||
      !auth.clientSecret ||
      !auth.credentialFile
    )
      throw failure(
        'REST_AUTH_EXPIRED',
        'OAuth refresh requires refreshToken, clientId and clientSecret in the private credential file',
        { phase: 'preflight' },
      );
    const response = await send('https://api.figma.com/v1/oauth/refresh', {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(auth.clientId + ':' + auth.clientSecret).toString(
            'base64',
          ),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ refresh_token: auth.refreshToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw failure(
        'REST_AUTH_EXPIRED',
        'Figma rejected OAuth refresh: HTTP ' + response.status,
        { phase: 'preflight' },
      );
    const value = await response.json();
    if (
      typeof value.access_token !== 'string' ||
      !Number.isFinite(value.expires_in)
    )
      throw failure('REST_AUTH_INVALID', 'Invalid OAuth refresh response', {
        phase: 'preflight',
      });
    const previous = privateJson(auth.credentialFile);
    writePrivateJson(auth.credentialFile, {
      ...previous,
      accessToken: value.access_token,
      refreshToken: value.refresh_token || previous.refreshToken,
      expiresAt: new Date(Date.now() + value.expires_in * 1000).toISOString(),
    });
    auth = credentials(profile);
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([auth.type, auth.token, auth.accountId, auth.tenantId]),
    )
    .digest('hex');
  let identity = verified.get(fingerprint);
  if (!identity || Date.now() - identity.checkedAt > 300000) {
    if (['plan', 'org_oauth', 'scim'].includes(auth.type)) {
      if (!auth.accountId)
        throw failure(
          'REST_AUTH_INVALID',
          'Plan, organization OAuth and SCIM credentials must declare their plan/organization accountId',
          { phase: 'preflight' },
        );
      if (auth.type === 'scim') {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(auth.tenantId || ''))
          throw failure(
            'REST_AUTH_INVALID',
            'SCIM credentials require tenantId',
            { phase: 'preflight' },
          );
        const response = await execute(
          prepare({
            endpoint: 'scimGetTenant',
            pathParams: { tenant_id: auth.tenantId },
          }),
          { fetch: send, auth },
        );
        if (!response.ok)
          throw failure(
            'REST_AUTH_REJECTED',
            'SCIM tenant verification failed: HTTP ' + response.httpStatus,
            { phase: 'preflight' },
          );
      }
      identity = {
        id: auth.accountId,
        checkedAt: Date.now(),
        verification:
          auth.type === 'scim' ? 'tenant_endpoint' : 'declared_organization',
      };
    } else {
      const response = await execute(prepare({ endpoint: 'getMe' }), {
        fetch: send,
        auth,
      });
      if (!response.ok || typeof response.body?.id !== 'string')
        throw failure(
          'REST_AUTH_REJECTED',
          'Figma rejected credential verification: HTTP ' + response.httpStatus,
          { phase: 'preflight' },
        );
      identity = { id: response.body.id, checkedAt: Date.now() };
    }
    verified.set(fingerprint, identity);
    if (verified.size > 20) verified.delete(verified.keys().next().value);
  }
  if (auth.accountId && auth.accountId !== identity.id)
    throw failure(
      'REST_ACCOUNT_MISMATCH',
      'REST token belongs to a different account',
      { phase: 'preflight' },
    );
  return {
    ...auth,
    accountId: identity.id,
    identityVerification: identity.verification || 'getMe',
  };
}
function authStatus(profile = 'default') {
  const auth = credentials(profile);
  return {
    profile,
    configured: !!auth.token,
    type: auth.token ? auth.type : null,
    accountId: auth.accountId,
    source: auth.source,
    expiresAt: auth.expiresAt || null,
    next: auth.token
      ? ['plan', 'org_oauth'].includes(auth.type)
        ? 'Organization identity is declared; validate authorization with an applicable read endpoint.'
        : auth.type === 'scim'
          ? 'Tenant identity is verified at the SCIM tenant endpoint.'
          : 'User identity is verified with getMe.'
      : 'No separate REST connection is configured. Native canvas work needs no API token; supported hosted features use the host’s existing Figma connection. Read figma_api(topic="cloud") and configure a private credential only if the requested direct REST endpoint needs it.',
  };
}
function configure({
  credentialFile,
  accountId,
  credentialProfile = 'default',
}) {
  if (!['default', 'org', 'scim'].includes(credentialProfile))
    throw failure('REST_AUTH_INVALID', 'Unknown credential profile');
  if (!credentialFile)
    throw failure('REST_AUTH_INVALID', 'credentialFile is required');
  const value = privateJson(credentialFile);
  if (
    !['pat', 'oauth', 'plan', 'org_oauth', 'scim'].includes(value.type) ||
    typeof value.accessToken !== 'string' ||
    !value.accessToken ||
    /[\r\n]/.test(value.accessToken)
  )
    throw failure(
      'REST_AUTH_INVALID',
      'Expected a private JSON credential with type and accessToken',
    );
  if (
    (credentialProfile === 'scim') !== (value.type === 'scim') ||
    (credentialProfile === 'org' && !['org_oauth', 'plan'].includes(value.type))
  )
    throw failure(
      'REST_AUTH_INVALID',
      'Credential type does not match its profile',
    );
  const config = fs.existsSync(configPath()) ? privateJson(configPath()) : {};
  const entry = {
    credentialFile,
    accountId: accountId || value.accountId || null,
  };
  writePrivateJson(
    configPath(),
    credentialProfile === 'default'
      ? { ...config, ...entry }
      : {
          ...config,
          profiles: { ...config.profiles, [credentialProfile]: entry },
        },
  );
  return authStatus(credentialProfile);
}
function resolve(ref) {
  if (!ref.startsWith('#/'))
    throw failure(
      'REST_SCHEMA_INVALID',
      'External schema references are not supported',
    );
  return ref
    .slice(2)
    .split('/')
    .reduce((v, k) => v?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
}
function validateValue(value, schema, where, depth = 0) {
  if (!schema || depth > 80) return;
  if (schema.$ref)
    return validateValue(value, resolve(schema.$ref), where, depth + 1);
  if (schema.nullable && value === null) return;
  if (schema.allOf)
    for (const s of schema.allOf) validateValue(value, s, where, depth + 1);
  const alternatives = schema.oneOf || schema.anyOf;
  if (alternatives) {
    let passed = 0;
    for (const s of alternatives)
      try {
        validateValue(value, s, where, depth + 1);
        passed++;
      } catch (error) {
        if (error.code !== 'REST_INPUT_INVALID') throw error;
      }
    if (!passed || (schema.oneOf && passed !== 1))
      throw failure(
        'REST_INPUT_INVALID',
        where + ' does not match its documented schema',
      );
  }
  if (
    schema.enum &&
    !schema.enum.some((x) => JSON.stringify(x) === JSON.stringify(value))
  )
    throw failure(
      'REST_INPUT_INVALID',
      where + ' must match the documented enum',
    );
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  const matches = (t) =>
    t === 'null'
      ? value === null
      : t === 'array'
        ? Array.isArray(value)
        : t === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : t === 'integer'
            ? Number.isSafeInteger(value)
            : t === 'number'
              ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === t;
  if (types.length && !types.some(matches))
    throw failure('REST_INPUT_INVALID', where + ' has an invalid type');
  if (
    typeof value === 'number' &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw failure(
      'REST_INPUT_INVALID',
      where + ' is outside the documented range',
    );
  if (
    typeof value === 'string' &&
    ((schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value)))
  )
    throw failure(
      'REST_INPUT_INVALID',
      where + ' does not match its documented constraints',
    );
  if (Array.isArray(value)) {
    if (
      (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)
    )
      throw failure('REST_INPUT_INVALID', where + ' has an invalid item count');
    for (let i = 0; i < value.length; i++)
      validateValue(value[i], schema.items, where + '[' + i + ']', depth + 1);
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        throw failure('REST_INPUT_INVALID', where + '.' + key + ' is required');
    for (const [key, entry] of Object.entries(value)) {
      if (
        schema.additionalProperties === false &&
        schema.properties &&
        !Object.hasOwn(schema.properties, key)
      )
        throw failure(
          'REST_INPUT_INVALID',
          where + '.' + key + ' is not a documented property',
        );
      validateValue(
        entry,
        schema.properties?.[key] ||
          (typeof schema.additionalProperties === 'object'
            ? schema.additionalProperties
            : null),
        where + '.' + key,
        depth + 1,
      );
    }
  }
}
function operation(endpoint) {
  const found = operations.find((op) => op.operationId === endpoint);
  if (!found)
    throw failure(
      'REST_OPERATION_UNKNOWN',
      'Unknown endpoint; list the pinned official operations first',
    );
  return found;
}
function describe(endpoint) {
  const op = operation(endpoint),
    schemas = {};
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const name = value.$ref;
      if (!Object.hasOwn(schemas, name)) {
        schemas[name] = resolve(name);
        collect(schemas[name]);
      }
    }
    for (const [key, v] of Object.entries(value))
      if (key !== '$ref') collect(v);
  }
  collect(op.parameters);
  collect(op.requestBody);
  collect(op.responses);
  return {
    operation: op,
    schemas,
    authentication: {
      ...spec.components.securitySchemes,
      ScimBearer: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Separate organization SCIM token; not a personal access token',
      },
    },
    source: op.source || provenance,
    validation:
      'Required fields, types, enum/range/array and composition checks; remaining semantic constraints are enforced by Figma.',
  };
}
function list({ query, offset = 0, limit = 100 } = {}) {
  const q = (query || '').toLowerCase();
  const all = operations.filter(
    (op) =>
      !q ||
      [op.operationId, op.summary, op.route, ...(op.tags || [])]
        .join(' ')
        .toLowerCase()
        .includes(q),
  );
  return {
    version: spec.info.version,
    families: {
      rest: operations.length - supplement.operations.length,
      discovery: 1,
      scim: 12,
    },
    total: all.length,
    operations: all.slice(offset, offset + limit).map((op) => ({
      endpoint: op.operationId,
      method: op.method,
      path: op.route,
      summary: op.summary,
      tags: op.tags,
      security: op.security,
      credentialProfile: op.credentialProfile || 'default',
    })),
    next: offset + limit < all.length ? offset + limit : null,
    source: provenance,
  };
}
function prepare(input) {
  const op = operation(input.endpoint),
    pathValues = input.pathParams || {},
    query = input.query || {};
  const names = new Set(
    op.parameters.filter((p) => p.in === 'path').map((p) => p.name),
  );
  if (Object.keys(pathValues).some((k) => !names.has(k)))
    throw failure('REST_INPUT_INVALID', 'Unknown path parameter');
  let route = op.route;
  for (const p of op.parameters) {
    const values =
      p.in === 'path' ? pathValues : p.in === 'query' ? query : null;
    if (!values) continue;
    const value = values[p.name];
    if (p.required && value === undefined)
      throw failure('REST_INPUT_INVALID', p.in + '.' + p.name + ' is required');
    if (value !== undefined)
      validateValue(value, p.schema, p.in + '.' + p.name);
    if (p.in === 'path' && value !== undefined) {
      if (
        typeof value !== 'string' ||
        value.includes('/') ||
        value.includes('\\') ||
        [...value].some((char) => char.charCodeAt(0) < 32) ||
        value === '.' ||
        value === '..'
      )
        throw failure('REST_INPUT_INVALID', 'Invalid path parameter');
      route = route.replace('{' + p.name + '}', encodeURIComponent(value));
    }
  }
  const known = new Map(
    op.parameters.filter((p) => p.in === 'query').map((p) => [p.name, p]),
  );
  if (Object.keys(query).some((k) => !known.has(k)))
    throw failure('REST_INPUT_INVALID', 'Unknown query parameter');
  const url = new URL(route, op.baseUrl || 'https://api.figma.com');
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        const p = known.get(key);
        if (p.explode === false) url.searchParams.set(key, value.join(','));
        else
          for (const item of value) url.searchParams.append(key, String(item));
      } else url.searchParams.set(key, String(value));
    }
  const requestBody = op.requestBody?.$ref
    ? resolve(op.requestBody.$ref)
    : op.requestBody;
  if (requestBody?.required && input.body === undefined)
    throw failure('REST_INPUT_INVALID', 'body is required');
  if (input.body !== undefined) {
    if (!requestBody)
      throw failure('REST_INPUT_INVALID', 'This endpoint has no request body');
    validateValue(
      input.body,
      requestBody.content?.['application/json']?.schema,
      'body',
    );
  }
  if (op.operationId === 'getDiscovery') {
    const start = Date.parse(query.start_date),
      end =
        query.end_date === undefined
          ? start + 3600000
          : Date.parse(query.end_date);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > Date.now() - 3600000 ||
      end <= start ||
      end - start > 86400000
    )
      throw failure(
        'REST_INPUT_INVALID',
        'Discovery requires an ISO date at least one hour in the past and a range up to 24 hours',
      );
  }
  const readOnly =
    op.readOnly ??
    (op.method === 'GET' || op.operationId === 'getDeveloperLogs');
  const fileKeys = [
    ...new Set(
      [
        pathValues.file_key,
        ...(input.fileKeys || []),
        ...(input.body?.dev_resources || []).map(
          (resource) => resource.file_key,
        ),
        input.body?.context === 'file' ? input.body.context_id : null,
        query.context === 'file' ? query.context_id : null,
      ].filter(Boolean),
    ),
  ].sort();
  if (
    fileKeys.some(
      (key) => typeof key !== 'string' || !/^[A-Za-z0-9]{6,100}$/.test(key),
    )
  )
    throw failure('REST_INPUT_INVALID', 'Invalid affected file key');
  if (!readOnly && !/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId || ''))
    throw failure(
      'REST_INPUT_INVALID',
      'A stable operationId is required for a cloud mutation',
    );
  return {
    endpoint: op.operationId,
    credentialProfile:
      input.credentialProfile || op.credentialProfile || 'default',
    tenantId: pathValues.tenant_id,
    method: op.method,
    url: url.href,
    body: input.body,
    readOnly,
    scope: op.security,
    fileKey: fileKeys.length === 1 ? fileKeys[0] : null,
    fileKeys,
    operationId: input.operationId || crypto.randomUUID(),
  };
}
function assertAuthentication(request, auth) {
  const declared = operation(request.endpoint);
  const scope = declared.security;
  const scheme = {
    pat: 'PersonalAccessToken',
    oauth: 'OAuth2',
    plan: 'PlanAccessToken',
    org_oauth: 'OrgOAuth2',
    scim: 'ScimBearer',
  }[auth.type];
  if (
    auth.token &&
    scope?.length &&
    !scope.some((entry) => Object.hasOwn(entry, scheme))
  )
    throw failure(
      'REST_AUTH_TYPE_REQUIRED',
      request.endpoint +
        ' requires ' +
        scope.map((entry) => Object.keys(entry).join('/')).join(' or ') +
        '; configured ' +
        auth.type +
        ' cannot authorize it',
      { phase: 'preflight' },
    );
  if (auth.type === 'scim' && request.tenantId !== auth.tenantId)
    throw failure(
      'REST_ACCOUNT_MISMATCH',
      'SCIM request tenant differs from configured tenant',
      { phase: 'preflight' },
    );
  const url = new URL(request.url);
  const routePattern = new RegExp(
    '^' +
      declared.route
        .split(/(\{[^}]+\})/g)
        .map((part) =>
          part.startsWith('{')
            ? '[^/]+'
            : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('') +
      '$',
  );
  if (
    url.origin !== (declared.baseUrl || 'https://api.figma.com') ||
    !routePattern.test(url.pathname) ||
    request.method !== declared.method ||
    url.username ||
    url.password
  )
    throw failure(
      'REST_URL_INVALID',
      'Only the documented official service origin/path is allowed',
      { phase: 'preflight' },
    );
}
async function execute(
  request,
  { fetch: send = fetch, auth = credentials() } = {},
) {
  if (!auth.token)
    throw failure(
      'REST_AUTH_REQUIRED',
      'Figma REST credentials have not been configured',
      { phase: 'preflight' },
    );
  assertAuthentication(request, auth);
  if (!['pat', 'oauth', 'plan', 'org_oauth', 'scim'].includes(auth.type))
    throw failure(
      'REST_AUTH_INVALID',
      'Expected pat, oauth, plan, org_oauth or scim authentication',
      { phase: 'preflight' },
    );
  if (auth.expiresAt && Date.now() >= Date.parse(auth.expiresAt))
    throw failure(
      'REST_AUTH_EXPIRED',
      'REST credential expired; refresh OAuth or replace the credential',
      { phase: 'preflight' },
    );
  const headers = {
    Accept: 'application/json',
    ...(['oauth', 'org_oauth', 'scim'].includes(auth.type)
      ? { Authorization: 'Bearer ' + auth.token }
      : { 'X-Figma-Token': auth.token }),
    ...(request.body !== undefined
      ? { 'Content-Type': 'application/json' }
      : {}),
  };
  let response;
  try {
    response = await send(request.url, {
      method: request.method,
      headers,
      body:
        request.body !== undefined ? JSON.stringify(request.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw failure(
      'REST_TRANSPORT_FAILED',
      'Figma REST transport failed: ' +
        (error.cause?.code || error.name || 'network'),
      { outcomeUnknown: !request.readOnly },
    );
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024)
        throw failure(
          'REST_RESPONSE_TOO_LARGE',
          'Response exceeds 32 MiB; request a smaller page or file depth',
        );
      chunks.push(chunk);
    }
  } catch (error) {
    throw failure(
      error.code || 'REST_RESPONSE_INTERRUPTED',
      error.code ? error.message : 'Figma REST response was interrupted',
      { outcomeUnknown: !request.readOnly },
    );
  }
  const text = Buffer.concat(chunks).toString();
  let body,
    invalidJson = false;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    invalidJson = response.ok;
    body = { text: text.slice(0, 8192), truncated: text.length > 8192 };
  }
  const resourceErrors =
    ['postDevResources', 'putDevResources'].includes(request.endpoint) &&
    Array.isArray(body?.errors)
      ? body.errors
      : [];
  const appliedResources = body?.links_created || body?.links_updated || [];
  return {
    endpoint: request.endpoint,
    httpStatus: response.status,
    ok:
      response.ok &&
      !invalidJson &&
      resourceErrors.length === 0 &&
      body?.error !== true,
    ...(invalidJson
      ? { semanticError: 'Figma returned an invalid JSON response' }
      : {}),
    ...(resourceErrors.length
      ? {
          semanticError:
            'Figma rejected ' + resourceErrors.length + ' dev resource(s)',
          partialApplication: appliedResources.length > 0,
        }
      : {}),
    body,
    rateLimit: {
      retryAfter: response.headers.get('retry-after'),
      type: response.headers.get('x-figma-rate-limit-type'),
      planTier: response.headers.get('x-figma-plan-tier'),
    },
    outcomeUnknown:
      !request.readOnly &&
      (response.status >= 500 ||
        response.status === 408 ||
        invalidJson ||
        (resourceErrors.length > 0 && appliedResources.length > 0)),
    pagination: body?.pagination || null,
  };
}
module.exports = {
  list,
  describe,
  prepare,
  execute,
  credentials,
  verifiedCredentials,
  authStatus,
  configure,
  validateValue,
  operations,
  provenance,
  assertAuthentication,
};
