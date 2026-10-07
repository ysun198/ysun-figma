const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { readLedger } = require('./helpers/ledger.cjs');
const vm = require('node:vm');
const { BRIDGE_RUNTIME_VERSION } = require('../src/shared/core.js');
const {
  createBridgeServer,
  SESSION_TTL_MS,
  CLIENT_LEASE_MS,
} = require('../src/host/bridge-server.cjs');
const {
  saveExports,
  uploadAssets,
} = require('../src/host/artifact-client.cjs');
const { targetIdentity } = require('../src/host/targets.cjs');
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-upgrade-'));
  const databasePath = path.join(directory, 'operations.sqlite');
  let bridge = createBridgeServer({ port: 0, databasePath, ...options }),
    address = await bridge.start();
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const call = async (route, body, secret = bridge.token, method) => {
    const response = await fetch(address.url + route, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  };
  const pair = async (
    clientId = 'upgrade-client-1',
    documentId = 'a'.repeat(32),
  ) => {
    const { body } = await call('/v1/pairings', {});
    const result = await call('/v1/pair', {
      code: body.code,
      clientId,
      documentId,
      fileName: 'Test',
      pageName: 'Page',
      runtimeVersion: BRIDGE_RUNTIME_VERSION,
      instanceId: 'instance-1',
    });
    assert.equal(result.status, 200);
    return { ...result.body, id: clientId, documentId };
  };
  return {
    directory,
    databasePath,
    call,
    pair,
    get bridge() {
      return bridge;
    },
    get connection() {
      return { url: address.url, protocolVersion: 3, token: bridge.token };
    },
    async restart() {
      await bridge.stop();
      bridge = createBridgeServer({ port: 0, databasePath, ...options });
      address = await bridge.start();
    },
  };
}
const resumeBody = (c) => ({
  clientId: c.id,
  grantToken: c.grantToken,
  documentId: c.documentId,
  fileName: 'Test',
  runtimeVersion: BRIDGE_RUNTIME_VERSION,
  instanceId: 'instance-1',
});
test('update admission waits for queued and running edits, then rejects new jobs before submission', async (t) => {
  const f = await fixture(t),
    client = await f.pair();
  const target = targetIdentity(client.client);
  const submit = (id) =>
    f.call('/v1/jobs', { operationId: id, target, source: 'return 1;' });
  assert.equal((await submit('update-admission-1')).status, 202);
  assert.equal((await f.call('/v1/maintenance', {})).status, 409);
  const claimed = await f.call('/v1/jobs/next', null, client.token);
  assert.equal(claimed.body.job.id, 'update-admission-1');
  assert.equal((await f.call('/v1/maintenance', {})).status, 409);
  assert.equal(
    (
      await f.call(
        '/v1/jobs/update-admission-1/result',
        { clientId: client.id, status: 'succeeded', result: { value: 1 } },
        client.token,
      )
    ).status,
    200,
  );
  assert.equal((await f.call('/v1/maintenance', {}, 'wrong')).status, 401);
  assert.equal((await f.call('/v1/maintenance', {})).status, 200);
  assert.equal((await submit('update-admission-2')).status, 503);
  assert.equal((await f.call('/v1/jobs/update-admission-2')).status, 404);
});
test('saved authorization restores after restart and token expiry, and revocation survives another restart', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }),
    c = await f.pair();
  const authorization = fs.readFileSync(
    path.join(f.directory, 'authorizations.json'),
    'utf8',
  );
  assert(
    !authorization.includes(c.grantToken),
    'only a grant hash is stored by the companion',
  );
  now += SESSION_TTL_MS + 1;
  assert.equal(
    (await f.call('/v1/clients/heartbeat', {}, c.token)).status,
    401,
  );
  let restored = await f.call('/v1/resume', resumeBody(c), '');
  assert.equal(restored.status, 200);
  await f.restart();
  restored = await f.call('/v1/resume', resumeBody(c), '');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.client.id, c.id);
  assert.equal(
    (await f.call(`/v1/clients/${c.id}`, null, restored.body.token, 'DELETE'))
      .status,
    200,
  );
  await f.restart();
  assert.equal((await f.call('/v1/resume', resumeBody(c), '')).status, 401);
});
test('two windows cannot take over the same saved authorization; clean close permits reopening', async (t) => {
  const f = await fixture(t),
    c = await f.pair();
  assert.equal(
    (
      await f.call(
        '/v1/resume',
        { ...resumeBody(c), instanceId: 'instance-2' },
        '',
      )
    ).status,
    409,
  );
  await f.call('/v1/clients/suspend', {}, c.token);
  assert.equal(
    (
      await f.call(
        '/v1/resume',
        { ...resumeBody(c), instanceId: 'instance-2' },
        '',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        '/v1/resume',
        { ...resumeBody(c), documentId: 'b'.repeat(32) },
        '',
      )
    ).status,
    403,
  );
});
test('restored authorization reports the live runtime instead of stale saved metadata', async (t) => {
  const f = await fixture(t),
    c = await f.pair(),
    file = path.join(f.directory, 'authorizations.json');
  const saved = JSON.parse(fs.readFileSync(file));
  saved.grants[0].client.runtimeVersion = 11;
  fs.writeFileSync(file, JSON.stringify(saved));
  await f.restart();
  const restored = await f.call('/v1/resume', resumeBody(c), '');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.client.runtimeVersion, BRIDGE_RUNTIME_VERSION);
  assert.equal(
    (await f.call('/v1/status?summary=1')).body.clients[0].runtimeVersion,
    BRIDGE_RUNTIME_VERSION,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(file)).grants[0].client.runtimeVersion,
    BRIDGE_RUNTIME_VERSION,
  );
});
test('heartbeat publishes current page, selection and renamed file without a native write', async (t) => {
  const f = await fixture(t),
    c = await f.pair();
  await f.call(
    '/v1/clients/heartbeat',
    {
      fileName: 'Renamed',
      pageName: 'New page',
      pageId: '2:3',
      selection: ['2:4'],
    },
    c.token,
  );
  const status = (await f.call('/v1/status?summary=1')).body;
  assert.equal(status.clients[0].fileName, 'Renamed');
  assert.equal(status.clients[0].pageId, '2:3');
  assert.deepEqual(status.clients[0].selection, ['2:4']);
  assert.equal(status.jobCount, 0);
});
test('closing a plugin cancels undelivered work and a new window cannot inherit queued operations', async (t) => {
  const f = await fixture(t),
    c = await f.pair();
  const request = {
    kind: 'exec',
    source: 'figma.createFrame();',
    operationId: 'old-window-operation',
    target: targetIdentity(c.client),
  };
  await f.call('/v1/jobs', request);
  await f.call('/v1/clients/suspend', {}, c.token);
  const resumed = await f.call(
    '/v1/resume',
    { ...resumeBody(c), instanceId: 'instance-2' },
    '',
  );
  assert.equal(resumed.status, 200);
  assert.equal(
    (await f.call('/v1/jobs/old-window-operation')).body.job.status,
    'failed',
  );
  assert.equal(
    (await f.call('/v1/jobs/old-window-operation')).body.job.startedAt,
    null,
  );
  assert.equal(
    (
      await f.call('/v1/jobs', {
        ...request,
        target: targetIdentity(resumed.body.client),
        operationId: 'new-window-operation',
      })
    ).status,
    202,
  );
});
test('interrupted trusted reads fail without blocking the next write', async (t) => {
  const f = await fixture(t),
    c = await f.pair();
  await f.call('/v1/jobs', {
    kind: 'exec',
    source: 'return figma.currentPage.id;',
    operationId: 'interrupted-read',
    target: targetIdentity(c.client),
    options: { readOnly: true, commitUndo: false },
  });
  await f.call('/v1/jobs/next', null, c.token);
  await f.restart();
  await f.call('/v1/resume', resumeBody(c), '');
  assert.equal(
    (await f.call('/v1/jobs/interrupted-read')).body.job.status,
    'failed',
  );
  assert.equal(
    (
      await f.call('/v1/jobs', {
        kind: 'exec',
        source: 'figma.createFrame();',
        operationId: 'write-after-read',
        target: targetIdentity(c.client),
      })
    ).status,
    202,
  );
});
test('forced native Cancel followed by a new instance retires stale reads without replaying queued work', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }),
    c = await f.pair();
  await f.call('/v1/jobs', {
    kind: 'exec',
    source: 'return figma.currentPage.id;',
    operationId: 'native-cancel-read',
    target: targetIdentity(c.client),
    options: { readOnly: true, commitUndo: false },
  });
  await f.call('/v1/jobs/next', null, c.token);
  await f.call('/v1/jobs', {
    kind: 'exec',
    source: 'figma.createFrame();',
    operationId: 'old-queued-write',
    target: targetIdentity(c.client),
  });
  now += CLIENT_LEASE_MS + 1;
  const resumed = await f.call(
    '/v1/resume',
    { ...resumeBody(c), instanceId: 'instance-2' },
    '',
  );
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.recovery.active, []);
  assert.equal(
    (await f.call('/v1/jobs/native-cancel-read')).body.job.status,
    'failed',
  );
  const queued = (await f.call('/v1/jobs/old-queued-write')).body.job;
  assert.equal(queued.status, 'failed');
  assert.equal(queued.startedAt, null);
  assert.equal(
    (
      await f.call('/v1/jobs', {
        kind: 'exec',
        source: 'figma.createFrame();',
        operationId: 'new-instance-write',
        target: targetIdentity(resumed.body.client),
      })
    ).status,
    202,
  );
});
test('replacement of an expired instance preserves uncertain writes for reconciliation', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }),
    c = await f.pair();
  await f.call('/v1/jobs', {
    kind: 'exec',
    source: 'figma.createFrame();',
    operationId: 'native-cancel-write',
    target: targetIdentity(c.client),
  });
  await f.call('/v1/jobs/next', null, c.token);
  now += CLIENT_LEASE_MS + 1;
  const resumed = await f.call(
    '/v1/resume',
    { ...resumeBody(c), instanceId: 'instance-2' },
    '',
  );
  assert.deepEqual(resumed.body.recovery.unresolved, ['native-cancel-write']);
  assert.equal(
    (await f.call('/v1/jobs/native-cancel-write')).body.job.status,
    'outcome_unknown',
  );
  assert.equal(
    (
      await f.call('/v1/jobs', {
        kind: 'exec',
        source: 'figma.createFrame();',
        operationId: 'must-not-replay',
        target: targetIdentity(resumed.body.client),
      })
    ).status,
    409,
  );
});
test('operation IDs remain deduplicated after capacity eviction, retention and restart', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }),
    c = await f.pair();
  const request = {
    kind: 'exec',
    operationId: 'persistent-operation',
    source: 'return 1;',
    target: targetIdentity(c.client),
  };
  await f.call('/v1/jobs', request);
  await f.call('/v1/jobs/next', null, c.token);
  await f.call(
    '/v1/jobs/persistent-operation/result',
    { clientId: c.id, ok: true, result: { value: 1 } },
    c.token,
  );
  for (let i = 0; i < 200; i++)
    assert.equal(
      (
        await f.call('/v1/jobs', {
          ...request,
          operationId: 'capacity-operation-' + i,
        })
      ).status,
      202,
    );
  let old = (await f.call('/v1/jobs/persistent-operation')).body.job;
  assert.equal(old.archived, true);
  assert.equal(old.status, 'succeeded');
  assert.equal((await f.call('/v1/jobs', request)).status, 200);
  now += 8 * 24 * 60 * 60 * 1000;
  await f.restart();
  old = (await f.call('/v1/jobs', request)).body.job;
  assert.equal(old.archived, true);
  assert.equal(old.status, 'succeeded');
  assert.equal(
    (await f.call('/v1/jobs', { ...request, source: 'return 2;' })).status,
    409,
  );
});
test('reconnecting cannot bypass an uncertain write; inspection and explicit reconciliation can proceed', async (t) => {
  const f = await fixture(t),
    c = await f.pair();
  const request = {
    kind: 'exec',
    source: 'figma.createFrame();',
    operationId: 'uncertain-operation',
    target: targetIdentity(c.client),
  };
  await f.call('/v1/jobs', request);
  await f.call('/v1/jobs/next', null, c.token);
  await f.restart();
  const restored = await f.call('/v1/resume', resumeBody(c), '');
  assert.deepEqual(restored.body.recovery.unresolved, [request.operationId]);
  assert.equal(
    (await f.call('/v1/jobs', { ...request, operationId: 'another-write' }))
      .status,
    409,
  );
  const read = {
    ...request,
    source: 'return figma.currentPage.children.map(n => n.id);',
    operationId: 'inspect-uncertain',
    options: { readOnly: true, commitUndo: false },
  };
  assert.equal((await f.call('/v1/jobs', read)).status, 202);
  const claim = await f.call('/v1/jobs/next', null, restored.body.token);
  assert.equal(claim.body.job.id, read.operationId);
  await f.call(
    '/v1/jobs/inspect-uncertain/result',
    { clientId: c.id, ok: true, result: { value: [] } },
    restored.body.token,
  );
  assert.equal(
    (
      await f.call('/v1/jobs/uncertain-operation/reconcile', {
        outcome: 'not_applied',
        note: 'Inspected the original canvas and node IDs.',
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.call('/v1/jobs', { ...request, operationId: 'another-write' }))
      .status,
    202,
  );
});
test('large binary inputs and exports round-trip privately without putting bytes in the ledger', async (t) => {
  const f = await fixture(t),
    c = await f.pair();
  const bytes = crypto.randomBytes(3 * 1024 * 1024),
    input = path.join(f.directory, 'input.bin');
  fs.writeFileSync(input, bytes);
  const assets = await uploadAssets(f.connection, { image: input });
  assert.deepEqual(
    await uploadAssets(f.connection, { image: input }),
    assets,
    'retry payloads use the same content address',
  );
  await f.call('/v1/jobs', {
    kind: 'exec',
    source: 'return 1;',
    operationId: 'binary-operation',
    target: targetIdentity(c.client),
    assets,
  });
  await f.call('/v1/jobs/next', null, c.token);
  const assetResponse = await fetch(
    f.connection.url + '/v1/jobs/binary-operation/assets/image',
    { headers: { Authorization: 'Bearer ' + c.token } },
  );
  assert.equal(assetResponse.status, 200);
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), bytes);
  const upload = await fetch(
    f.connection.url + '/v1/jobs/binary-operation/exports/image.bin',
    {
      method: 'POST',
      body: bytes,
      headers: { Authorization: 'Bearer ' + c.token },
    },
  );
  const exported = await upload.json();
  assert.equal(upload.status, 200);
  const result = await f.call(
    '/v1/jobs/binary-operation/result',
    {
      clientId: c.id,
      ok: true,
      result: {
        exports: [{ ...exported, mimeType: 'application/octet-stream' }],
      },
    },
    c.token,
  );
  assert.equal(result.status, 200);
  const saved = await saveExports(
    f.connection,
    result.body.job,
    path.join(f.directory, 'out'),
  );
  assert.deepEqual(fs.readFileSync(saved[0].path), bytes);
  await assert.rejects(
    saveExports(f.connection, result.body.job, path.join(f.directory, 'out')),
    /already exists/,
  );
  assert(readLedger(f.databasePath).storedBytes < 10000);
  assert(!JSON.stringify(readLedger(f.databasePath)).includes('base64'));
});
function ui() {
  const messages = [],
    elements = new Map();
  const parent = { postMessage: (value) => messages.push(value.pluginMessage) };
  const context = vm.createContext({
    parent,
    AbortController,
    AbortSignal,
    crypto: { getRandomValues: (b) => crypto.randomFillSync(b) },
    document: {
      getElementById(id) {
        if (!elements.has(id))
          elements.set(id, {
            value: '',
            dataset: {},
            listeners: {},
            addEventListener(event, fn) {
              this.listeners[event] = fn;
            },
          });
        return elements.get(id);
      },
    },
    addEventListener() {},
    setInterval() {},
    clearInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: async () => ({ ok: true, status: 204 }),
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/figma/ui.js'), 'utf8'),
    context,
  );
  return { context, messages, elements, parent };
}
test('Close stays guarded during asset transfer and failed downloads never launch native code', async () => {
  const f = ui();
  let failDownload;
  f.context.fetch = (url) =>
    url.includes('/assets/')
      ? new Promise((resolve) => {
          failDownload = () => resolve({ ok: false, status: 404 });
        })
      : Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ accepted: true }),
        });
  const completed = f.context.execute({
    id: 'loading-operation',
    kind: 'exec',
    options: {},
    assets: { image: { assetId: 'asset-123' } },
  });
  f.elements.get('close').listeners.click();
  assert.equal(f.elements.get('close').disabled, true);
  assert.equal(
    f.messages.some((message) => message.type === 'CLOSE'),
    false,
  );
  assert.equal(
    f.messages.some((message) => message.type === 'RUN_JOB'),
    false,
  );
  failDownload();
  await completed;
  assert.equal(
    f.messages.some((message) => message.type === 'RUN_JOB'),
    false,
  );
  assert.equal(f.elements.get('close').disabled, false);
});
test('both UI and native host refuse closing before a result receipt is delivered', async () => {
  const f = ui();
  f.context.execute({ id: 'pending-operation', kind: 'exec', options: {} });
  f.elements.get('close').listeners.click();
  assert.equal(f.elements.get('close').disabled, true);
  assert.equal(f.elements.get('disconnect').disabled, true);
  assert.equal(
    f.messages.some((m) => m.type === 'CLOSE'),
    false,
  );
  let closed = 0,
    release;
  const figma = {
    root: { name: 'Test', getPluginData: () => '' },
    currentPage: { id: '0:1', name: 'Page', selection: [] },
    showUI() {},
    on() {},
    ui: { postMessage() {} },
    closePlugin() {
      closed++;
    },
    notify() {},
  };
  const host = vm.createContext({
    figma,
    __html__: '',
    BRIDGE_RUNTIME_VERSION,
    BRIDGE_PROTOCOL_VERSION: 3,
    executeScript: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    formatBridgeError: (e) => e.message,
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../src/figma/native-runtime.js'),
      'utf8',
    ),
    host,
  );
  const operation = figma.ui.onmessage({ type: 'RUN_JOB', kind: 'exec' });
  await figma.ui.onmessage({ type: 'CLOSE' });
  assert.equal(closed, 0);
  release({ value: 1 });
  await operation;
  await figma.ui.onmessage({ type: 'CLOSE' });
  assert.equal(closed, 0);
  await figma.ui.onmessage({ type: 'RECEIPT_DELIVERED' });
  await figma.ui.onmessage({ type: 'CLOSE' });
  assert.equal(closed, 1);
});
test('native writes refresh the design revision even when dynamic-page documentchange is unavailable', async () => {
  const packets = [];
  const figma = {
    root: { name: 'Test', getPluginData: () => '' },
    currentPage: { id: '0:1', name: 'Page', selection: [] },
    showUI() {},
    on(type) {
      if (type === 'documentchange') throw new Error('Pages are not loaded');
    },
    ui: {
      postMessage(v) {
        packets.push(v);
      },
    },
  };
  const host = vm.createContext({
    figma,
    __html__: '',
    BRIDGE_RUNTIME_VERSION,
    BRIDGE_PROTOCOL_VERSION: 3,
    async executeScript(source) {
      if (source === 'partial') throw new Error('partial write');
      return { value: 1 };
    },
    formatBridgeError: (e) => e.message,
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../src/figma/native-runtime.js'),
      'utf8',
    ),
    host,
  );
  await figma.ui.onmessage({
    type: 'RUN_JOB',
    kind: 'exec',
    source: 'read',
    options: { readOnly: true },
  });
  assert.equal(packets.at(-1).context.documentRevision, 0);
  await figma.ui.onmessage({ type: 'RECEIPT_DELIVERED' });
  await figma.ui.onmessage({
    type: 'RUN_JOB',
    kind: 'exec',
    source: 'write',
    options: {},
  });
  assert.equal(packets.at(-1).context.documentRevision, 1);
  await figma.ui.onmessage({ type: 'RECEIPT_DELIVERED' });
  await figma.ui.onmessage({
    type: 'RUN_JOB',
    kind: 'exec',
    source: 'partial',
    options: {},
  });
  assert.equal(packets.at(-1).type, 'ERROR');
  assert.equal(packets.at(-1).context.documentRevision, 2);
});
test('re-pairing restarts polling after the previous poll settles', async () => {
  const f = ui();
  let release,
    polls = 0;
  f.context.fetch = async (url) => {
    if (url.endsWith('/v1/pair'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: 3,
          token: 'renewed',
          recovery: { active: [], unresolved: [] },
        }),
      };
    polls++;
    if (polls === 1)
      return new Promise((resolve) => {
        release = () => resolve({ status: 204 });
      });
    vm.runInContext('direct.enabled=false', f.context);
    return { status: 204 };
  };
  vm.runInContext(
    'direct.context={fileName:"Test",protocolVersion:3};',
    f.context,
  );
  const original = f.context.run();
  f.context.pause('Old session ended.');
  f.elements.get('pair-code').value = 'fresh-code';
  await f.context.pair();
  release();
  await original;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 2);
  f.context.onmessage({
    source: f.parent,
    data: {
      pluginMessage: {
        type: 'CONTEXT',
        fileName: 'Renamed',
        pageName: 'New page',
        selection: ['2:3'],
      },
    },
  });
  assert.equal(f.elements.get('target-file').textContent, 'Renamed');
  assert.match(f.elements.get('target-page').textContent, /已选 1 项/);
});
test('manual page edits invalidate previews in dynamic mode without loading unrelated pages', async () => {
  const events = new Map(),
    packets = [],
    pageEvents = new Map();
  let loads = 0;
  const page = {
    id: '1:2',
    name: 'Page',
    selection: [],
    children: [],
    async loadAsync() {
      loads++;
    },
    on(type, callback) {
      pageEvents.set(type, callback);
    },
  };
  const figma = {
    root: { name: 'Test', children: [page], getPluginData: () => '' },
    currentPage: page,
    showUI() {},
    on(type, callback) {
      events.set(type, callback);
    },
    ui: {
      postMessage(message) {
        packets.push(message);
      },
    },
  };
  const context = vm.createContext({
    figma,
    __html__: '',
    BRIDGE_RUNTIME_VERSION,
    BRIDGE_PROTOCOL_VERSION: 3,
    executeScript: async () => ({ value: 42 }),
    formatBridgeError: (error) => error.message,
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../src/figma/native-runtime.js'),
      'utf8',
    ),
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  assert(pageEvents.has('nodechange'));
  assert.equal(events.has('documentchange'), false);
  pageEvents.get('nodechange')({
    documentChanges: [{ type: 'PROPERTY_CHANGE', properties: ['fills'] }],
  });
  assert.equal(packets.at(-1).type, 'CONTEXT');
  assert.equal(packets.at(-1).documentRevision, 1);
  events.get('currentpagechange')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
});
test('job observation skips existing root arrays and registers newly loaded empty pages', async () => {
  const packets = [],
    subscriptions = new Map();
  let hiddenLoaded = false,
    activeReads = 0,
    hiddenReads = 0,
    hiddenLoads = 0;
  const active = {
    id: '1:1',
    name: 'Active',
    selection: [],
    get children() {
      activeReads++;
      return [];
    },
    async loadAsync() {},
    on(type, callback) {
      subscriptions.set(this.id, callback);
    },
  };
  const hidden = {
    id: '1:2',
    name: 'Hidden',
    get children() {
      hiddenReads++;
      if (!hiddenLoaded) throw new Error('page is not loaded');
      return [];
    },
    async loadAsync() {
      hiddenLoads++;
    },
    on(type, callback) {
      subscriptions.set(this.id, callback);
    },
  };
  const figma = {
    root: { name: 'Test', children: [active, hidden], getPluginData: () => '' },
    currentPage: active,
    showUI() {},
    on() {},
    ui: { postMessage: (message) => packets.push(message) },
  };
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../src/figma/native-runtime.js'),
      'utf8',
    ),
    vm.createContext({
      figma,
      __html__: '',
      BRIDGE_RUNTIME_VERSION,
      BRIDGE_PROTOCOL_VERSION: 3,
      executeScript: async () => ({ value: 42 }),
      formatBridgeError: (error) => error.message,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  async function read() {
    await figma.ui.onmessage({ type: 'RECEIPT_DELIVERED' });
    await figma.ui.onmessage({
      type: 'RUN_JOB',
      kind: 'exec',
      source: 'read',
      options: { readOnly: true },
    });
  }
  await read();
  assert.equal(hiddenLoads, 0, 'unrelated pages remain lazy');
  hiddenLoaded = true;
  await read();
  assert(
    subscriptions.has(hidden.id),
    'empty loaded pages also invalidate previews',
  );
  const reads = hiddenReads;
  await read();
  assert.equal(activeReads, 0, 'observed roots are never re-enumerated');
  assert.equal(hiddenReads, reads, 'new observations are reused');
  assert.equal(hiddenLoads, 1);
  subscriptions.get(hidden.id)({});
  assert.equal(packets.at(-1).type, 'CONTEXT');
  assert.equal(packets.at(-1).documentRevision, 1);
  assert.equal(figma.currentPage, active);
});
