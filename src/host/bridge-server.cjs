#!/usr/bin/env node
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  bridgeStateDirectory,
  connectionPath,
  writePrivateJson,
} = require('./state.cjs');
const {
  BRIDGE_RUNTIME_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  formatBridgeError,
} = require('../shared/core.js');
const { createArtifacts, validName } = require('./artifacts.cjs');
const { resolveTarget, targetIdentity } = require('./targets.cjs');
const {
  createExecution,
  MAX_RUN_MS,
  TERMINAL_STATES,
  resolved,
  digest,
} = require('./execution.cjs');
const { fileList } = require('./app.cjs');
const PROTOCOL_VERSION = BRIDGE_PROTOCOL_VERSION;
const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PACKAGE_VERSION = require('../../package.json').version;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 38491;
const CLIENT_LEASE_MS = 45_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  'null',
  'https://figma.com',
  'https://www.figma.com',
]);
const NO_VALUE = Symbol('no-value');
function safeEqual(a, b) {
  const x = Buffer.from(a || ''),
    y = Buffer.from(b || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function problem(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
function publicClient(client, now) {
  const {
    id,
    instanceId,
    fileName,
    fileKey,
    editorType,
    pageName,
    pageId,
    selection,
    documentId,
    pluginId,
    runtimeVersion,
    nativeBuild,
    documentRevision,
    startedAt,
    lastSeenAt,
    expiresAt,
  } = client;
  return {
    id,
    instanceId,
    fileName,
    fileKey,
    editorType,
    pageName,
    pageId,
    selection,
    documentId,
    pluginId,
    runtimeVersion,
    nativeBuild,
    documentRevision,
    startedAt,
    lastSeenAt,
    expiresAt,
    needsPluginUpdate: runtimeVersion !== BRIDGE_RUNTIME_VERSION,
    connected:
      !client.suspended &&
      now - lastSeenAt <= CLIENT_LEASE_MS &&
      now < expiresAt,
  };
}
function summarizeStatus(
  state,
  { scope = 'connected', clientId, fileKey } = {},
) {
  if (!['connected', 'all'].includes(scope))
    throw new Error('status scope must be connected or all');
  if (scope === 'all' && (clientId || fileKey))
    throw new Error('choose all history or one connected file');
  const selected =
    clientId || fileKey
      ? resolveTarget({ clientId, fileKey }, state.clients).clientId
      : null;
  const visible = new Set(
    state.clients
      .filter(
        (client) => client.connected && (!selected || client.id === selected),
      )
      .map((client) => client.id),
  );
  const jobCounts = {};
  for (const job of state.jobs)
    jobCounts[job.status] = (jobCounts[job.status] || 0) + 1;
  const unresolved = state.jobs.filter((j) => !resolved(j));
  const jobs = unresolved
    .filter((j) => scope === 'all' || visible.has(j.target?.clientId))
    .map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      target: j.target,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      reconciledAt: j.reconciledAt,
      error: typeof j.error === 'string' ? j.error.slice(0, 280) : j.error,
      errorTruncated: typeof j.error === 'string' && j.error.length > 280,
    }));
  return {
    protocolVersion: state.protocolVersion,
    version: state.version,
    runtimeVersion: state.runtimeVersion,
    clients: selected
      ? state.clients.filter((client) => client.id === selected)
      : state.clients,
    jobCount: state.jobs.length,
    jobCounts,
    unresolvedJobCount: unresolved.length,
    jobsScope: { scope, ...(selected ? { clientId: selected } : {}) },
    jobsTruncated: jobs.length < state.jobs.length,
    jobs,
  };
}
function createBridgeServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  if (host !== DEFAULT_HOST)
    throw new Error('the bridge must bind to IPv4 loopback');
  const port = options.port === undefined ? DEFAULT_PORT : options.port;
  const token = options.token || crypto.randomBytes(32).toString('base64url');
  const now = options.now || Date.now;
  const clients = new Map(),
    sessions = new Map(),
    pairings = new Map(),
    grants = new Map();
  let execution;
  const catalog = require('./catalog.cjs').createCatalog(options.catalogPath);
  let catalogWorker = null;
  const grantPath =
    options.databasePath &&
    path.join(path.dirname(options.databasePath), 'authorizations.json');
  const artifactDirectory =
    options.artifactDirectory ||
    (options.databasePath
      ? path.join(path.dirname(options.databasePath), 'artifacts')
      : require('node:os').tmpdir() +
        '/figma-artifacts-' +
        crypto.randomUUID());
  const artifacts = createArtifacts(artifactDirectory);
  const saveGrants = () => {
    if (grantPath)
      writePrivateJson(grantPath, {
        protocolVersion: PROTOCOL_VERSION,
        grants: [...grants.values()],
      });
  };
  function metadata(client, body) {
    if (
      typeof body.nativeBuild === 'string' &&
      /^[a-f0-9]{64}$/.test(body.nativeBuild)
    )
      client.nativeBuild = body.nativeBuild;
    if (
      Number.isSafeInteger(body.documentRevision) &&
      body.documentRevision >= 0
    )
      client.documentRevision = body.documentRevision;
    for (const key of ['fileName', 'pageName', 'pageId', 'instanceId'])
      if (
        typeof body[key] === 'string' &&
        body[key].trim() &&
        body[key].length <= 1000
      )
        client[key] = body[key].trim();
    if (
      typeof body.fileKey === 'string' &&
      (!body.fileKey || /^[A-Za-z0-9]{6,100}$/.test(body.fileKey))
    )
      client.fileKey = body.fileKey;
    if (['figma', 'figjam', 'slides'].includes(body.editorType))
      client.editorType = body.editorType;
    if (Array.isArray(body.selection))
      client.selection = body.selection
        .filter((id) => typeof id === 'string' && id.length <= 100)
        .slice(0, 100);
  }
  function authorize(client, grantToken) {
    for (const [secret, session] of sessions)
      if (session.clientId === client.id) sessions.delete(secret);
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    client.expiresAt = now() + SESSION_TTL_MS;
    client.lastSeenAt = now();
    client.suspended = false;
    clients.set(client.id, client);
    sessions.set(sessionToken, {
      clientId: client.id,
      expiresAt: client.expiresAt,
    });
    notifyChange();
    return {
      protocolVersion: PROTOCOL_VERSION,
      token: sessionToken,
      ...(grantToken ? { grantToken } : {}),
      client: publicClient(client, now()),
      expiresAt: client.expiresAt,
      recovery: execution.recovery(client.id),
    };
  }
  const changes = new EventEmitter();
  changes.setMaxListeners(100);
  let changePending = false;
  function notifyChange() {
    if (changePending) return;
    changePending = true;
    queueMicrotask(() => {
      changePending = false;
      changes.emit('change');
    });
  }
  let pairingFailures = { count: 0, since: now() };
  function restoreGrants() {
    if (grantPath && fs.existsSync(grantPath)) {
      const stored = JSON.parse(fs.readFileSync(grantPath, 'utf8'));
      if (
        stored.protocolVersion !== PROTOCOL_VERSION ||
        !Array.isArray(stored.grants)
      )
        throw new Error('unsupported authorization store');
      for (const grant of stored.grants)
        if (grant.expiresAt > now()) grants.set(grant.client.id, grant);
    }
  }
  let lastAssetCleanup = 0;
  const activeClients = () =>
    [...clients.values()].filter(
      (client) => publicClient(client, now()).connected,
    );
  function createPairing() {
    cleanup();
    if (pairings.size >= 10)
      throw problem(429, 'too many pending pairing codes');
    const code = crypto.randomBytes(16).toString('hex'),
      expiresAt = now() + PAIRING_TTL_MS;
    pairings.set(code, expiresAt);
    return { code, expiresAt };
  }
  function cleanup() {
    if (now() - lastAssetCleanup >= 60000) {
      lastAssetCleanup = now();
      artifacts.cleanupAssets(now(), execution.assetIds());
    }
    for (const [secret, session] of sessions)
      if (now() >= session.expiresAt) sessions.delete(secret);
    for (const [code, expiry] of pairings)
      if (now() >= expiry) pairings.delete(code);
    execution.cleanup(clients);
    for (const [id, client] of clients)
      if (now() >= client.expiresAt) clients.delete(id);
  }

  function waitForValue(read, timeoutMs, res) {
    const initial = read();
    if (initial !== NO_VALUE) return Promise.resolve(initial);
    return new Promise((resolve, reject) => {
      let complete = false;
      const finish = (value, error) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        changes.off('change', check);
        res.off('close', disconnected);
        if (error) reject(error);
        else resolve(value);
      };
      const check = () => {
        try {
          const value = read();
          if (value !== NO_VALUE) finish(value);
        } catch (error) {
          finish(null, error);
        }
      };
      const disconnected = () => finish(NO_VALUE);
      const timer = setTimeout(() => finish(NO_VALUE), timeoutMs);
      res.on('close', disconnected);
      changes.on('change', check);
      check();
    });
  }
  function send(res, status, body) {
    if (res.destroyed) return;
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }
  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES)
        throw problem(413, 'request body exceeds 5 MB');
      chunks.push(chunk);
    }
    try {
      const value = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : {};
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      return value;
    } catch {
      throw problem(400, 'expected a JSON object');
    }
  }
  function claimNextJob(client) {
    if (
      clients.get(client.id) !== client ||
      !publicClient(client, now()).connected
    )
      return NO_VALUE;
    return (
      execution.claim(targetIdentity(catalog.decorate([client])[0])) || NO_VALUE
    );
  }

  let ready = false,
    maintenance = false;
  async function handle(req, res) {
    if (!ready) throw problem(503, 'relay initialization has not completed');
    const boundPort = server.address().port;
    if (
      ![`${host}:${boundPort}`, `localhost:${boundPort}`].includes(
        req.headers.host,
      )
    )
      throw problem(403, 'host is not allowed');
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin))
      throw problem(403, 'origin is not allowed');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type',
      );
      if (req.headers['access-control-request-private-network'] === 'true')
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') return send(res, 204);
    cleanup();
    if (!req.url.startsWith('/') || req.url.startsWith('//'))
      throw problem(400, 'invalid request target');
    const url = new URL(req.url, `http://${host}:${boundPort}`);
    if (req.method === 'POST' && url.pathname === '/v1/pair') {
      const body = await readJson(req);
      if (now() - pairingFailures.since > 60000)
        pairingFailures = { count: 0, since: now() };
      if (pairingFailures.count >= 20)
        throw problem(429, 'too many pairing attempts; retry after one minute');
      if (body.runtimeVersion !== BRIDGE_RUNTIME_VERSION)
        throw problem(
          409,
          `plugin runtime is outdated; expected ${BRIDGE_RUNTIME_VERSION}`,
        );
      if (
        !/^[A-Za-z0-9_-]{8,100}$/.test(body.clientId || '') ||
        typeof body.fileName !== 'string' ||
        !body.fileName.trim()
      )
        throw problem(400, 'clientId and fileName are required');
      const expiry = pairings.get(body.code);
      if (!expiry || now() >= expiry) {
        pairingFailures.count++;
        throw problem(401, 'invalid or expired pairing code');
      }
      pairings.delete(body.code);
      const grantToken = crypto.randomBytes(32).toString('base64url');
      const client = {
        id: body.clientId,
        fileName: body.fileName.trim(),
        pageName: String(body.pageName || ''),
        pluginId: String(body.pluginId || ''),
        runtimeVersion: BRIDGE_RUNTIME_VERSION,
        startedAt: now(),
        lastSeenAt: now(),
        expiresAt: now() + SESSION_TTL_MS,
      };
      if (
        typeof body.documentId === 'string' &&
        /^[a-f0-9]{32}$/.test(body.documentId)
      )
        client.documentId = body.documentId;
      metadata(client, body);
      grants.set(client.id, {
        hash: crypto.createHash('sha256').update(grantToken).digest('hex'),
        client: { ...client },
        expiresAt: now() + GRANT_TTL_MS,
      });
      saveGrants();
      return send(res, 200, authorize(client, grantToken));
    }
    if (req.method === 'POST' && url.pathname === '/v1/resume') {
      const body = await readJson(req),
        grant = grants.get(body.clientId);
      if (body.runtimeVersion !== BRIDGE_RUNTIME_VERSION)
        throw problem(409, 'update the plugin before reconnecting');
      const hash = crypto
        .createHash('sha256')
        .update(String(body.grantToken || ''))
        .digest('hex');
      if (!grant || grant.expiresAt <= now() || !safeEqual(hash, grant.hash))
        throw problem(
          401,
          'authorization was revoked or expired; enter a new pairing code',
        );
      if (
        grant.client.documentId &&
        body.documentId !== grant.client.documentId
      )
        throw problem(403, 'authorization belongs to another document');
      const existing = clients.get(body.clientId);
      if (
        existing &&
        publicClient(existing, now()).connected &&
        body.instanceId &&
        existing.instanceId &&
        existing.instanceId !== body.instanceId
      )
        throw problem(
          409,
          'this document is already connected in another plugin window; close that window first',
        );
      const client = existing || { ...grant.client };
      if (
        existing &&
        body.instanceId &&
        existing.instanceId &&
        body.instanceId !== existing.instanceId
      ) {
        // A forced native Cancel may destroy the iframe without beforeunload.
        // Reopening must not inherit that instance's claimed or queued jobs.
        execution.endInstance(
          existing.id,
          'the original plugin instance ended; inspect any uncertain write',
        );
      }
      client.runtimeVersion = BRIDGE_RUNTIME_VERSION;
      metadata(client, body);
      grant.client = { ...client };
      grant.expiresAt = now() + GRANT_TTL_MS;
      saveGrants();
      return send(res, 200, authorize(client));
    }

    const authorization = req.headers.authorization || '';
    const supplied = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    const admin = safeEqual(supplied, token);
    const session = sessions.get(supplied);
    if (!admin && (!session || now() >= session.expiresAt))
      throw problem(401, 'invalid or expired bridge session');
    const requireAdmin = () => {
      if (!admin)
        throw problem(403, 'this operation requires the local MCP credential');
    };
    const requireClient = (id) => {
      if (!session || (id && id !== session.clientId))
        throw problem(403, 'this operation belongs to another client');
      return clients.get(session.clientId);
    };
    if (req.method === 'POST' && url.pathname === '/v1/pairings') {
      requireAdmin();
      return send(res, 201, createPairing());
    }
    if (req.method === 'POST' && url.pathname === '/v1/clients/suspend') {
      const client = requireClient();
      client.suspended = true;
      client.lastSeenAt = now() - CLIENT_LEASE_MS - 1;
      execution.endInstance(
        client.id,
        'plugin closed before its receipt was delivered; inspect the original operation',
      );
      notifyChange();
      return send(res, 200, { suspended: true });
    }
    if (req.method === 'POST' && url.pathname === '/v1/clients/heartbeat') {
      const client = requireClient();
      if (!client) throw problem(401, 'client must pair again');
      client.lastSeenAt = now();
      metadata(client, await readJson(req));
      notifyChange();
      // State comes from the canonical ledger, scoped to this paired client.
      // A poll is a claim: losing its reply may leave an unknown native action.
      return send(res, 200, {
        client: publicClient(client, now()),
        recovery: execution.recovery(client.id),
      });
    }

    const revoke = url.pathname.match(/^\/v1\/clients\/([^/]+)$/);
    if (revoke && req.method === 'DELETE') {
      if (!admin) requireClient(revoke[1]);
      clients.delete(revoke[1]);
      grants.delete(revoke[1]);
      saveGrants();
      for (const [secret, value] of sessions)
        if (value.clientId === revoke[1]) sessions.delete(secret);
      cleanup();
      notifyChange();
      return send(res, 200, { revoked: revoke[1] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/maintenance') {
      requireAdmin();
      // Admission and the ledger check share the server's synchronous turn.
      // Never let an edit enter between the updater's idle check and stop.
      if (
        execution
          .list()
          .some((job) => ['queued', 'running'].includes(job.status))
      )
        throw problem(409, 'Finish pending operations before updating');
      maintenance = true;
      return send(res, 200, { idle: true });
    }
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      requireAdmin();
      const state = {
        version: PACKAGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: BRIDGE_RUNTIME_VERSION,
        clients: catalog.decorate(
          activeClients().map((client) => publicClient(client, now())),
        ),
        jobs: execution
          .list()
          .map((job) =>
            url.searchParams.get('summary') === '1'
              ? job
              : execution.get(job.id),
          ),
      };
      if (url.searchParams.get('summary') !== '1') return send(res, 200, state);
      try {
        return send(
          res,
          200,
          summarizeStatus(
            state,
            Object.fromEntries(
              ['scope', 'clientId', 'fileKey']
                .filter((key) => url.searchParams.has(key))
                .map((key) => [key, url.searchParams.get(key)]),
            ),
          ),
        );
      } catch (error) {
        throw problem(400, formatBridgeError(error));
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/app') {
      requireAdmin();
      const cursor = url.searchParams.get('cursor'),
        waitMs = Number(url.searchParams.get('waitMs') || 0);
      if (
        (cursor && !/^sha256:[a-f0-9]{64}$/.test(cursor)) ||
        !Number.isInteger(waitMs) ||
        waitMs < 0 ||
        waitMs > 25000
      )
        throw problem(400, 'invalid workbench cursor or wait');
      const snapshot = () => {
        const data = fileList(
          {
            version: PACKAGE_VERSION,
            clients: catalog.decorate(
              activeClients().map((client) => publicClient(client, now())),
            ),
            jobs: execution.list(),
          },
          catalog.view(),
        );
        return { ...data, cursor: digest(data) };
      };
      // Presence leases can expire without another event. Wake at that boundary
      // as well as on the same connection, catalog and receipt events as jobs.
      const timeout = activeClients().reduce(
        (remaining, client) =>
          Math.min(
            remaining,
            client.lastSeenAt + CLIENT_LEASE_MS + 1 - now(),
            client.expiresAt - now(),
          ),
        waitMs,
      );
      const value = await waitForValue(
        () => {
          const data = snapshot();
          return data.cursor === cursor ? NO_VALUE : data;
        },
        timeout,
        res,
      );
      return send(res, 200, value === NO_VALUE ? snapshot() : value);
    }
    if (req.method === 'POST' && url.pathname === '/v1/desktop') {
      requireAdmin();
      const { fileKey } = await readJson(req);
      return send(
        res,
        200,
        await require('./desktop.cjs').launchDesktop(fileKey),
      );
    }
    if (url.pathname === '/v1/catalog') {
      requireAdmin();
      if (req.method === 'GET') return send(res, 200, catalog.view());
      if (req.method === 'POST') {
        try {
          const value = catalog.update(await readJson(req));
          notifyChange();
          return send(res, 200, value);
        } catch (error) {
          throw problem(400, formatBridgeError(error));
        }
      }
    }
    if (req.method === 'POST' && url.pathname === '/v1/catalog/bind') {
      requireAdmin();
      try {
        const value = catalog.bind(
          await readJson(req),
          activeClients().map((client) => publicClient(client, now())),
        );
        notifyChange();
        return send(res, 200, value);
      } catch (error) {
        throw problem(400, formatBridgeError(error));
      }
    }
    if (req.method === 'POST' && url.pathname === '/v1/catalog/sync') {
      requireAdmin();
      const { force } = await readJson(req),
        state = catalog.view();
      if (
        catalogWorker ||
        (!force &&
          Date.now() - Date.parse(state.lastAttemptAt || state.syncedAt) <
            (state.status === 'ready' ? 5 * 60 * 1000 : 30000))
      )
        return send(res, 200, state);
      catalog.update({ status: 'syncing' });
      notifyChange();
      const environment = {
        ...process.env,
        ...(options.catalogPath
          ? { FIGMA_PLUGIN_STATE_DIR: path.dirname(options.catalogPath) }
          : {}),
      };
      const worker = require('node:child_process').spawn(
        '/bin/sh',
        [
          path.join(__dirname, '../../scripts/run-node.sh'),
          path.join(__dirname, 'catalog-sync.cjs'),
        ],
        {
          cwd: path.join(__dirname, '../..'),
          env: environment,
          stdio: 'ignore',
        },
      );
      catalogWorker = worker;
      const ended = () => {
        if (catalogWorker === worker) {
          catalogWorker = null;
          if (catalog.view().status === 'syncing')
            catalog.update({
              status: 'incomplete',
              error: 'account_sync_interrupted',
            });
          notifyChange();
        }
      };
      worker.once('error', ended);
      worker.once('exit', ended);
      worker.unref();
      return send(res, 200, catalog.view());
    }
    const assetUpload = url.pathname.match(
      /^\/v1\/assets\/([A-Za-z0-9_-]{8,100})$/,
    );
    if (req.method === 'POST' && assetUpload) {
      requireAdmin();
      return send(res, 201, {
        assetId: assetUpload[1],
        ...(await artifacts.save('assets', assetUpload[1], req)),
      });
    }
    const binary = url.pathname.match(
      /^\/v1\/jobs\/([A-Za-z0-9_-]{8,100})\/(exports|assets)\/([^/]+)$/,
    );
    if (binary) {
      const job = execution.get(binary[1], { payload: true, result: false }),
        name = decodeURIComponent(binary[3]);
      if (!job || job.archived || !validName(name))
        throw problem(404, 'job or artifact was not found');
      if (req.method === 'POST' && binary[2] === 'exports') {
        const client = requireClient();
        if (job.clientId !== client.id)
          throw problem(403, 'artifact belongs to another client');
        return send(res, 200, await artifacts.save(job.id, name, req));
      }
      if (req.method === 'GET' && binary[2] === 'assets') {
        const client = requireClient();
        if (job.clientId !== client.id)
          throw problem(403, 'asset belongs to another client');
        const asset = job.assets && job.assets[name];
        if (!asset || typeof asset !== 'object')
          throw problem(404, 'asset was not found');
        return artifacts.send('assets', asset.assetId, res);
      }
      if (req.method === 'GET' && binary[2] === 'exports') {
        requireAdmin();
        return artifacts.send(job.id, name, res);
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/jobs/next') {
      const client = requireClient(url.searchParams.get('clientId'));
      client.lastSeenAt = now();
      const waitMs = Math.max(
        0,
        Math.min(25000, Number(url.searchParams.get('wait') || 0) || 0),
      );
      const job = await waitForValue(
        () => {
          if (sessions.get(supplied) !== session)
            throw problem(401, 'session was rotated');
          return claimNextJob(client);
        },
        waitMs,
        res,
      );
      client.lastSeenAt = now();
      return job === NO_VALUE ? send(res, 204) : send(res, 200, { job });
    }
    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      requireAdmin();
      const body = await readJson(req);
      if (maintenance)
        throw problem(
          503,
          'The companion is activating an update; no operation was submitted',
        );
      const kind = body.kind || 'exec';
      if (kind !== 'exec')
        throw problem(400, 'only native exec jobs are supported');
      let source, args, assets;
      try {
        source = body.source;
        args = body.args === undefined ? {} : body.args;
        assets = body.assets || {};
        if (
          typeof source !== 'string' ||
          !source.trim() ||
          Buffer.byteLength(source) > 1024 * 1024
        )
          throw new Error('script source must be nonempty and at most 1 MiB');
        if (
          !assets ||
          typeof assets !== 'object' ||
          Array.isArray(assets) ||
          Object.entries(assets).some(
            ([name, data]) =>
              !validName(name) ||
              !data ||
              typeof data !== 'object' ||
              !/^[A-Za-z0-9_-]{8,100}$/.test(data.assetId || '') ||
              artifacts.describe('assets', data.assetId).sha256 !== data.sha256,
          )
        )
          throw new Error(
            'assets must map simple names to uploaded byte receipts',
          );
        const inputBytes = Object.values(assets).reduce(
          (sum, asset) =>
            sum + artifacts.describe('assets', asset.assetId).size,
          0,
        );
        if (inputBytes > 32 * 1024 * 1024)
          throw new Error('assets exceed 32 MiB total');
      } catch (error) {
        throw problem(400, formatBridgeError(error));
      }
      const id = body.operationId;
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(id))
        throw problem(400, 'invalid operationId');
      if (
        !body.target ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(body.target.clientId || '') ||
        !['fileKey', 'documentId', 'instanceId', 'editorType'].every((key) =>
          Object.hasOwn(body.target, key),
        )
      )
        throw problem(400, 'resolve an exact target before submission');
      const expected = targetIdentity({
        ...body.target,
        id: body.target.clientId,
      });
      const { job, created } = execution.submit(
        {
          id,
          source,
          args,
          assets,
          target: expected,
          options: body.options,
          expiresInMs: body.expiresInMs,
        },
        catalog.decorate(
          activeClients().map((client) => publicClient(client, now())),
        ),
      );
      return send(res, created ? 202 : 200, { job });
    }
    const resultMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/result$/);
    if (req.method === 'POST' && resultMatch) {
      const body = await readJson(req);
      const client = requireClient(body.clientId);
      const job = execution.complete(resultMatch[1], client.id, body);
      if (body.context) metadata(client, body.context);
      // Context and durable receipt are visible in the same host snapshot.
      notifyChange();
      return send(res, 200, { job });
    }
    const resolveMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/reconcile$/);
    if (req.method === 'POST' && resolveMatch) {
      requireAdmin();
      const job = execution.reconcile(resolveMatch[1], await readJson(req));
      return send(res, 200, { job });
    }
    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      requireAdmin();
      const job = execution.get(jobMatch[1]);
      if (!job) throw problem(404, 'job was not found');
      const waitMs = Math.max(
        0,
        Math.min(30000, Number(url.searchParams.get('wait') || 0) || 0),
      );
      if (waitMs && !TERMINAL_STATES.has(job.status))
        await waitForValue(
          () =>
            TERMINAL_STATES.has(execution.get(job.id, { result: false }).status)
              ? true
              : NO_VALUE,
          waitMs,
          res,
        );
      return send(res, 200, { job: execution.get(job.id) });
    }
    throw problem(404, 'route was not found');
  }
  const server = http.createServer((req, res) =>
    handle(req, res).catch((error) => {
      if (res.headersSent) res.destroy();
      else
        send(res, error.statusCode || 500, {
          error: formatBridgeError(error),
          ...Object.fromEntries(
            ['clients', 'expected', 'actual', 'blockingOperationIds']
              .filter((key) => error[key] !== undefined)
              .map((key) => [key, error[key]]),
          ),
        });
    }),
  );
  server.requestTimeout = 30000;
  let cleanupTimer;
  return {
    token,
    clients,
    createPairing,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      // Bind first: a second process failing EADDRINUSE must never rewrite a
      // running owner's receipt journal or run its retention timer.
      try {
        execution = createExecution({
          databasePath: options.databasePath,
          now,
          onChange: notifyChange,
          onError: options.onError,
          artifacts,
        });
        restoreGrants();
        ready = true;
      } catch (error) {
        execution?.close();
        execution = null;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        throw error;
      }
      cleanupTimer = setInterval(() => {
        try {
          cleanup();
        } catch (error) {
          if (options.onError) options.onError(error);
        }
      }, 1000);
      cleanupTimer.unref();
      return {
        host,
        port: server.address().port,
        url: `http://${host}:${server.address().port}`,
      };
    },
    async stop() {
      ready = false;
      clearInterval(cleanupTimer);
      if (catalogWorker) {
        const worker = catalogWorker;
        worker.kill('SIGTERM');
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            worker.kill('SIGKILL');
            resolve();
          }, 1500);
          worker.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (!options.databasePath && !options.artifactDirectory)
        fs.rmSync(artifactDirectory, { recursive: true, force: true });
      execution?.close();
      execution = null;
      changes.removeAllListeners();
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
async function runStandalone() {
  const bridge = createBridgeServer({
    databasePath: path.join(bridgeStateDirectory(), 'operations.sqlite'),
    catalogPath: path.join(bridgeStateDirectory(), 'catalog.json'),
    onError: (error) =>
      process.stderr.write(`Ledger error: ${formatBridgeError(error)}\n`),
  });
  const address = await bridge.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (
      fs.existsSync(connectionPath()) &&
      JSON.parse(fs.readFileSync(connectionPath(), 'utf8')).pid === process.pid
    )
      fs.unlinkSync(connectionPath());
    await bridge.stop();
  };
  try {
    writePrivateJson(connectionPath(), {
      protocolVersion: PROTOCOL_VERSION,
      url: address.url,
      token: bridge.token,
      pid: process.pid,
      startedAt: Date.now(),
    });
  } catch (error) {
    await stop();
    throw error;
  }
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
}
if (require.main === module)
  runStandalone().catch((error) => {
    process.stderr.write(formatBridgeError(error) + '\n');
    process.exitCode = 1;
  });
module.exports = {
  CLIENT_LEASE_MS,
  SESSION_TTL_MS,
  PAIRING_TTL_MS,
  GRANT_TTL_MS,
  MAX_RUN_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  connectionPath,
  createBridgeServer,
  summarizeStatus,
  runStandalone,
};
