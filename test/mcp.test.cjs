const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
function isolatedRuntime(t, overrides) {
  const saved = new Map();
  for (const [name, patch] of Object.entries(overrides)) {
    const id = require.resolve('../src/host/' + name + '.cjs');
    const original = require(id);
    saved.set(id, require.cache[id]);
    require.cache[id] = {
      ...require.cache[id],
      exports: { ...original, ...patch },
    };
  }
  const id = require.resolve('../src/host/mcp.cjs');
  saved.set(id, require.cache[id]);
  delete require.cache[id];
  const runtime = require(id);
  t.after(() => {
    for (const [id, value] of saved)
      if (value) require.cache[id] = value;
      else delete require.cache[id];
  });
  return runtime;
}
test('stdio pressure preserves fragmented UTF-8 messages, IDs and error boundaries', async (t) => {
  const { PassThrough } = require('node:stream');
  const api = isolatedRuntime(t, {}),
    input = new PassThrough(),
    output = new PassThrough(),
    messages = [];
  output.on('data', (bytes) => messages.push(JSON.parse(bytes.toString())));
  api.serve(input, output);
  const packets = [
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'stress', version: '1' },
        capabilities: {},
      },
    },
    { method: 'notifications/initialized' },
    ...Array.from({ length: 500 }, (_, i) => ({
      id: i + 2,
      method: i % 5 ? 'tools/call' : 'ping',
      ...(i % 5
        ? {
            params: {
              name: 'figma_api',
              arguments: {
                query: i % 2 ? 'GridLayoutMixin' : '不存在',
                limit: 1,
              },
            },
          }
        : {}),
    })),
  ];
  const bytes = Buffer.from(
    packets.map((p) => JSON.stringify({ jsonrpc: '2.0', ...p })).join('\r\n') +
      '\n{broken json}\n',
  );
  for (let offset = 0; offset < bytes.length; offset += 37)
    input.write(bytes.subarray(offset, offset + 37));
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  const replies = messages.filter((m) => m.id !== null);
  assert.equal(replies.length, 501);
  assert.equal(new Set(replies.map((m) => m.id)).size, 501);
  assert.equal(messages.filter((m) => m.error?.code === -32700).length, 1);
  assert(replies.every((m) => m.result && !m.result.isError));
});
test('a closed stdio input aborts its pending transport work without a late response', async (t) => {
  const { PassThrough } = require('node:stream');
  let ready, forwarded;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const api = isolatedRuntime(t, {
    companion: { ensureCompanion: async () => ({}) },
    'bridge-client': {
      bridgeRequest: async (_connection, _route, { signal }) =>
        new Promise((resolve, reject) => {
          forwarded = signal;
          signal.addEventListener(
            'abort',
            () => reject(new Error('request aborted')),
            { once: true },
          );
          ready();
        }),
    },
  });
  const input = new PassThrough(),
    output = new PassThrough(),
    messages = [];
  output.on('data', (bytes) => messages.push(JSON.parse(bytes.toString())));
  api.serve(input, output);
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'stress', version: '1' },
        capabilities: {},
      },
    }) + '\n',
  );
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write(
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"figma_status"}}\n',
  );
  await started;
  input.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.aborted, true);
  assert.equal(
    messages.some((m) => m.id === 2),
    false,
  );
});
test('malformed tools/call envelopes are protocol errors rather than successful empty calls', async (t) => {
  const { PassThrough } = require('node:stream');
  const api = isolatedRuntime(t, {}),
    input = new PassThrough(),
    output = new PassThrough();
  const messages = [];
  output.on('data', (bytes) => messages.push(JSON.parse(bytes.toString())));
  api.serve(input, output);
  const send = (message) =>
    input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  send({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'fixture', version: '1' },
      capabilities: {},
    },
  });
  send({ method: 'notifications/initialized' });
  const invalid = [null, [], false, 'text', 42];
  invalid.forEach((value, i) =>
    send({
      id: i + 2,
      method: 'tools/call',
      params: { name: 'figma_api', arguments: value },
    }),
  );
  send({ id: 7, method: 'tools/call', params: { name: 'figma_api' } });
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  for (let id = 2; id <= 6; id++)
    assert.equal(messages.find((m) => m.id === id)?.error?.code, -32602);
  assert.equal(messages.find((m) => m.id === 7).result.isError, false);
});
test('submission rejects an instance changed while assets were being uploaded', async (t) => {
  const { createBridgeServer } = require('../src/host/bridge-server.cjs');
  const { BRIDGE_RUNTIME_VERSION } = require('../src/shared/core.js');
  const { bridgeRequest } = require('../src/host/bridge-client.cjs');
  const bridge = createBridgeServer({ port: 0 });
  const { url } = await bridge.start();
  t.after(() => bridge.stop());
  const connection = { url, token: bridge.token, protocolVersion: 3 };
  const paired = await bridgeRequest(connection, '/v1/pair', {
    method: 'POST',
    body: JSON.stringify({
      code: bridge.createPairing().code,
      clientId: 'asset-race-client',
      fileName: 'Original file',
      fileKey: 'OriginalFile12',
      documentId: 'a'.repeat(32),
      instanceId: 'instance-original',
      runtimeVersion: BRIDGE_RUNTIME_VERSION,
    }),
  });
  const api = isolatedRuntime(t, {
    companion: {
      ensureCompanion: async () => ({
        ...connection,
        status: await bridgeRequest(connection, '/v1/status?summary=1'),
      }),
    },
    'artifact-client': {
      uploadAssets: async () => {
        await bridgeRequest(
          { ...connection, token: paired.token },
          '/v1/clients/heartbeat',
          {
            method: 'POST',
            body: JSON.stringify({ instanceId: 'instance-reopened' }),
          },
        );
        return {};
      },
    },
  });
  await assert.rejects(
    api.callTool('figma_run', {
      fileKey: 'OriginalFile12',
      source: 'figma.createFrame();',
      operationId: 'asset-upload-target-race',
      waitMs: 0,
    }),
    (error) => {
      assert.equal(error.phase, 'preflight');
      assert.match(error.message, /target.*changed/i);
      const change = api.toolError(error).targetChange;
      assert.equal(change.expected.instanceId, 'instance-original');
      assert.equal(change.actual.instanceId, 'instance-reopened');
      return true;
    },
  );
  assert.equal(
    (await bridgeRequest(connection, '/v1/status?summary=1')).jobCount,
    0,
    'no operation may bind to the replacement instance',
  );
});
test('resource I/O failures remain valid JSON-RPC errors rather than leaking filesystem error codes', async (t) => {
  const { PassThrough } = require('node:stream');
  const api = isolatedRuntime(t, {
    app: {
      readResource() {
        throw Object.assign(new Error('resource unavailable'), {
          code: 'ENOENT',
        });
      },
    },
  });
  const input = new PassThrough(),
    output = new PassThrough();
  const messages = [];
  output.on('data', (value) => messages.push(JSON.parse(value.toString())));
  api.serve(input, output);
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }) + '\n',
  );
  input.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n',
  );
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: 'ui://figma-plugin/files' },
    }) + '\n',
  );
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[1].error.code, -32603);
  assert.equal(messages[1].error.message, 'resource unavailable');
});
test('native success retains its receipt and generated ID when preview delivery fails', async (t) => {
  const job = {
    id: 'generated-preview-id',
    status: 'succeeded',
    target: { clientId: 'client-fixture' },
    result: {
      value: { preview: {} },
      exports: [{ name: 'preview-node.png', mimeType: 'image/png', size: 1 }],
    },
  };
  const api = isolatedRuntime(t, {
    companion: {
      ensureCompanion: async () => ({
        status: { clients: [{ id: 'client-fixture', connected: true }] },
      }),
    },
    'bridge-client': {
      bridgeRequest: async (_connection, route) => {
        assert.equal(route, '/v1/jobs');
        return { job };
      },
    },
    'artifact-client': {
      uploadAssets: async () => ({}),
      readExport: async () => {
        throw new Error('export download failed: HTTP 503');
      },
    },
  });
  const error = await api.callTool('figma_screenshot', {}).then(
    () => assert.fail('expected delivery failure'),
    (error) => error,
  );
  const value = api.toolError(error);
  assert.equal(value.phase, 'delivery');
  assert.equal(value.operationId, job.id);
  assert.equal(value.receipt.job.status, 'succeeded');
  assert.equal(value.code, 'ARTIFACT_DELIVERY_FAILED');
  assert.match(value.next, /do not rerun/i);
});
test('an interrupted wait retains the accepted job, including a generated read operation ID', async (t) => {
  const job = {
    id: 'generated-read-id',
    status: 'running',
    target: { clientId: 'client-fixture' },
  };
  const api = isolatedRuntime(t, {
    companion: {
      ensureCompanion: async () => ({
        status: { clients: [{ id: 'client-fixture', connected: true }] },
      }),
    },
    'bridge-client': {
      bridgeRequest: async (_connection, route) => {
        if (route === '/v1/jobs') return { job };
        throw new Error('wait disconnected');
      },
    },
    'artifact-client': {
      uploadAssets: async () => ({}),
    },
  });
  const error = await api.callTool('figma_inspect', {}).then(
    () => assert.fail('expected wait failure'),
    (error) => error,
  );
  const value = api.toolError(error);
  assert.equal(value.operationId, job.id);
  assert.equal(value.receipt.job.status, 'running');
  assert.equal(value.phase, 'submitted');
});
test('receipt lookup failures preserve the original operation without claiming it was never submitted', async (t) => {
  const api = isolatedRuntime(t, {
    companion: { ensureCompanion: async () => ({}) },
    'bridge-client': {
      bridgeRequest: async () => {
        throw new Error('fetch failed');
      },
    },
  });
  const error = await api
    .callTool('figma_job', {
      operationId: 'existing-operation',
      includePreviews: false,
    })
    .then(
      () => assert.fail('expected lookup failure'),
      (error) => error,
    );
  const value = api.toolError(error);
  assert.equal(value.phase, 'receipt');
  assert.equal(value.operationId, 'existing-operation');
  assert.match(value.next, /original operation/);
  assert.notEqual(value.safeToRetryWithoutCanvasRead, true);
});
test('conflicting image fill options are rejected before upload or native submission', async (t) => {
  const api = isolatedRuntime(t, {
    companion: {
      ensureCompanion: async () => assert.fail('must reject before connection'),
    },
  });
  for (const input of [
    { fillIndex: 0 },
    { nodeId: '1:1', fillIndex: 0, replaceAllFills: true },
  ]) {
    const error = await api
      .callTool('figma_upload_assets', {
        operationId: 'invalid-fill-request',
        assetPaths: { 'image.png': 'unused' },
        ...input,
      })
      .then(
        () => assert.fail('expected preflight failure'),
        (error) => error,
      );
    const value = api.toolError(error, { operationId: 'invalid-fill-request' });
    assert.equal(value.phase, 'preflight');
    assert.equal(value.safeToRetryWithoutCanvasRead, true);
  }
});
test('file opening leaves duplicate native sessions for the agent to disambiguate', async (t) => {
  const clients = ['client-first', 'client-second'].map((id) => ({
    id,
    connected: true,
    fileKey: 'CloudFile1',
  }));
  const api = isolatedRuntime(t, {
    companion: { ensureCompanion: async () => ({}) },
    'bridge-client': {
      bridgeRequest: async (_connection, route) =>
        route === '/v1/catalog' ? { files: [], status: 'empty' } : { clients },
    },
  });
  const error = await api
    .callTool('figma_file', { action: 'open', fileKey: 'CloudFile1' })
    .then(
      () => assert.fail('must not pick a session'),
      (error) => error,
    );
  const value = api.toolError(error);
  assert.equal(value.code, 'FILE_AMBIGUOUS');
  assert.equal(value.clients.length, 2);
  const { fileList } = require('../src/host/app.cjs');
  const data = fileList(
    { clients },
    {
      files: [{ fileKey: 'CloudFile1', name: 'File' }],
      status: 'incomplete',
      error: 'folder_navigation_changed',
      coverage: [{ route: '/drafts', complete: true }],
    },
  );
  assert.equal(data.files[0].clientId, null);
  assert.equal(data.files[0].sessions.length, 2);
  assert.equal(data.catalog.error, 'folder_navigation_changed');
  assert.equal(data.catalog.coverage.length, 1);
});
test('stdio MCP negotiates, lists tools and reports invalid calls without stdout noise or startup dependencies', async (t) => {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, '../build/plugin/src/host/mcp.cjs')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill());
  let buffer = '',
    stderr = '';
  const pending = new Map();
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      assert.equal(message.jsonrpc, '2.0');
      const resolve = pending.get(message.id);
      assert(resolve);
      pending.delete(message.id);
      resolve(message);
    }
  });
  const call = (message) =>
    new Promise((resolve) => {
      pending.set(message.id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    });
  let result = await call({ id: 1, method: 'tools/list' });
  assert.equal(result.error.code, -32000);
  result = await call({
    id: 2,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
  assert.equal(result.result.protocolVersion, '2025-11-25');
  assert.deepEqual(result.result.capabilities, {
    tools: { listChanged: true },
    resources: { listChanged: true },
  });
  const serverIcons = result.result.serverInfo.icons;
  assert.equal(serverIcons.length, 1);
  const decoded = Buffer.from(
    serverIcons[0].src.split(',')[1],
    'base64',
  ).toString();
  assert.equal(
    decoded,
    fs.readFileSync(path.join(__dirname, '../assets/icon.svg'), 'utf8'),
  );
  assert.match(decoded, /@media\(prefers-color-scheme:dark\)/);
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  result = await call({ id: 3, method: 'tools/list' });
  assert.deepEqual(
    result.result.tools.map((tool) => tool.name).sort(),
    require('../src/host/mcp.cjs')
      .tools.map((tool) => tool.name)
      .sort(),
    'the built transport must expose the current source tool catalogue',
  );
  for (const name of ['figma_canvas', 'figma_watch']) {
    const tool = result.result.tools.find((tool) => tool.name === name);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.equal(tool.annotations.readOnlyHint, true);
  }
  assert(
    result.result.tools.every((tool) => tool.outputSchema?.type === 'object'),
  );
  assert.equal(
    result.result.tools.find((tool) => tool.name === 'figma_run').annotations
      .openWorldHint,
    true,
  );
  assert.equal(
    result.result.tools.find((tool) => tool.name === 'figma_run').annotations
      .readOnlyHint,
    false,
  );
  assert.equal(
    result.result.tools.find((tool) => tool.name === 'figma_download_assets')
      .annotations.readOnlyHint,
    false,
    'saving local assets is a write even though the Figma file remains unchanged',
  );
  result = await call({
    id: 4,
    method: 'tools/call',
    params: {
      name: 'figma_run',
      arguments: { operationId: 'original-operation' },
    },
  });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /source.*required/);
  assert.equal(result.result.structuredContent.phase, 'preflight');
  assert.match(result.result.structuredContent.next, /No native job/);
  result = await call({
    id: 5,
    method: 'tools/call',
    params: { name: 'unknown', arguments: {} },
  });
  assert.equal(result.error.code, -32602);
  result = await call({ id: 6, method: 'ping' });
  assert.deepEqual(result.result, {});
  assert.equal(stderr, '');
  const entry = await call({ id: 7, method: 'tools/list' });
  const browser = entry.result.tools.find((tool) => tool.name === 'figma_open');
  assert.deepEqual(browser._meta['openai/ui'].entrypoints, [
    { type: 'global' },
  ]);
  assert.deepEqual(browser.icons, serverIcons);
  result = await call({ id: 8, method: 'resources/list' });
  assert.equal(result.result.resources[0].uri, browser._meta.ui.resourceUri);
  assert.equal(browser._meta.ui.resourceUri, 'ui://figma-plugin/files');
  result = await call({
    id: 9,
    method: 'resources/read',
    params: { uri: browser._meta.ui.resourceUri },
  });
  assert.equal(result.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(result.result.contents[0].text, /aria-label="文件预览"/);
  assert.match(
    result.result.contents[0].text,
    /<input\b[^>]*\bid="search"[^>]*\btype="search"/,
  );
  assert.doesNotMatch(result.result.contents[0].text, /<textarea\b/);
  assert.deepEqual(result.result.contents[0]._meta.ui.csp, {
    connectDomains: [],
    resourceDomains: ['https://s3-alpha.figma.com'],
  });
  result = await call({
    id: 10,
    method: 'resources/read',
    params: { uri: 'file:///private-state' },
  });
  assert.equal(result.error.code, -32002);
  result = await call({
    id: 11,
    method: 'resources/read',
    params: { uri: 'ui://figma-plugin/unknown' },
  });
  assert.equal(result.error.code, -32002);
});
test('app file data excludes grants, disconnected files, operation receipts and filesystem state', () => {
  const { fileList } = require('../src/host/app.cjs');
  const state = {
    version: 'test',
    adminToken: 'private',
    jobs: [{ source: 'private script' }],
    clients: [
      {
        connected: true,
        id: 'file-client',
        fileKey: 'CloudFile1',
        fileName: 'Design',
        pageName: 'Page',
        pageId: '1:2',
        selection: ['3:4'],
        sessionToken: 'private',
        grantToken: 'private',
      },
      { connected: false, id: 'disconnected', fileName: 'Other' },
    ],
  };
  assert.equal(
    fileList(state).files.length,
    0,
    'sessions cannot masquerade as account files',
  );
  const value = fileList(state, {
    files: [{ fileKey: 'CloudFile1', name: 'Design' }],
    status: 'ready',
  });
  assert.equal(value.files.length, 1);
  assert.equal(value.files[0].clientId, 'file-client');
  assert.equal(value.files[0].connected, true);
  assert.equal(value.catalog.status, 'ready');
  assert.doesNotMatch(
    JSON.stringify(value),
    /private|sessionToken|grantToken|adminToken/,
  );
});
test('compatible native builds need no update or new pairing; explicit additional-file connection does', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os');
  const {
    createBridgeServer,
    PROTOCOL_VERSION,
  } = require('../src/host/bridge-server.cjs');
  const { BRIDGE_RUNTIME_VERSION } = require('../src/shared/core.js');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-connect-reuse-')),
    before = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = state;
  const bridge = createBridgeServer({ port: 0 });
  const { url } = await bridge.start();
  t.after(async () => {
    await bridge.stop();
    if (before === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = before;
    fs.rmSync(state, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(state, 'connection.json'),
    JSON.stringify({
      url,
      protocolVersion: PROTOCOL_VERSION,
      token: bridge.token,
    }),
  );
  const code = bridge.createPairing().code;
  const response = await fetch(url + '/v1/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId: 'connected-fixture',
      fileName: 'Design',
      runtimeVersion: BRIDGE_RUNTIME_VERSION,
      nativeBuild: 'a'.repeat(64),
    }),
  });
  assert.equal(response.status, 200);
  const { callTool } = require('../src/host/mcp.cjs');
  const reused = await callTool('figma_connect', {});
  assert.equal(reused.state, 'connected');
  assert.equal(reused.code, undefined);
  assert.equal(reused.files[0].needsPluginUpdate, false);
  const fresh = await callTool('figma_connect', { newFile: true });
  assert.equal(fresh.state, 'pairing_required');
  assert.equal(typeof fresh.code, 'string');
  const status = await callTool('figma_status', {});
  assert.equal(status.clients[0].needsPluginUpdate, false);
  assert.equal(status.clients[0].nativeBuild, 'a'.repeat(64));
});
test('tool errors give the view a recovery message while retaining original operation IDs for the agent', () => {
  const { toolError } = require('../src/host/mcp.cjs');
  assert.equal(
    toolError(new Error('No matching connected Figma file.')).code,
    'FIGMA_NOT_CONNECTED',
  );
  const value = toolError(
    new Error('unknown outcome requires reconciliation'),
    { operationId: 'original-write' },
  );
  assert.equal(value.code, 'OUTCOME_NEEDS_REVIEW');
  assert.equal(value.operationId, 'original-write');
  assert.match(value.next, /original operation ID/);
  const failure = new Error('outcome_unknown: execution started');
  failure.receipt = {
    job: { id: 'original-write', status: 'outcome_unknown' },
  };
  const unknown = toolError(failure, { operationId: 'original-write' });
  assert.equal(unknown.safeToRetryWithoutCanvasRead, false);
  assert.equal(unknown.receipt.job.id, 'original-write');
});
test('desktop launcher uses exact native URLs, also opens home, and surfaces failures', async () => {
  const { launchDesktop } = require('../src/host/desktop.cjs');
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
  };
  assert.equal(
    (
      await launchDesktop('CloudFile12', {
        execute: run,
        connect: async () => {},
        platform: 'darwin',
      })
    ).state,
    'opened',
  );
  assert.deepEqual(calls[0], [
    '/usr/bin/open',
    ['-a', 'Figma', 'figma://file/CloudFile12'],
    { timeout: 10000 },
  ]);
  await launchDesktop(undefined, {
    execute: run,
    connect: async () => {},
    platform: 'darwin',
  });
  assert.deepEqual(calls[1][1], ['-a', 'Figma']);
  await assert.rejects(
    launchDesktop('../../private', {
      execute: run,
      connect: async () => {},
      platform: 'darwin',
    }),
    /Invalid/,
  );
  await assert.rejects(
    launchDesktop(undefined, {
      execute: run,
      connect: async () => {},
      platform: 'linux',
    }),
    /requires macOS/,
  );
  await assert.rejects(
    launchDesktop(undefined, {
      execute: async () => {
        throw new Error('App not installed');
      },
      connect: async () => {},
      platform: 'darwin',
    }),
    /not installed/,
  );
});
test('Community research is read-only and routes without document status, pairing or edit jobs', async (t) => {
  const calls = [];
  const api = isolatedRuntime(t, {
    companion: { ensureCompanion: async () => ({}) },
    'bridge-client': {
      bridgeRequest: async (_connection, route, options) => {
        calls.push({ route, options });
        return {
          source: { kind: 'figma-community' },
          resource: { communityFileId: '1475930096803673913' },
          image: { data: 'aW1hZ2U=', mimeType: 'image/png' },
        };
      },
    },
  });
  const definition = api.tools.find((x) => x.name === 'figma_community');
  assert.equal(definition.annotations.readOnlyHint, true);
  const value = await api.callTool('figma_community', {
    action: 'preview',
    communityFileId: '1475930096803673913',
  });
  assert.deepEqual(
    calls.map((x) => x.route),
    ['/v1/community'],
  );
  assert.equal(value.image, undefined);
  assert.deepEqual(value[api.images], [
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
  ]);
  assert.doesNotMatch(JSON.stringify(value), /aW1hZ2U=/);
});
test('invalid Community requests fail before starting the companion', async (t) => {
  const api = isolatedRuntime(t, {
    companion: {
      ensureCompanion: async () => assert.fail('must reject before connection'),
    },
  });
  await assert.rejects(
    api.callTool('figma_community', {
      action: 'search',
      query: 'poster',
      communityFileId: '1475930096803673913',
    }),
  );
});

test('API discovery works without Figma and rejects invalid topic/query inputs before connection', async (t) => {
  const api = isolatedRuntime(t, {
    companion: {
      ensureCompanion: async () =>
        assert.fail('offline discovery must not start the companion'),
    },
  });
  const result = await api.callTool('figma_api', {
    query: 'GridLayoutMixin',
    limit: 1,
  });
  assert.equal(result.excerpts[0].owner, 'GridLayoutMixin');
  assert.equal(
    api.tools.find((tool) => tool.name === 'figma_api').annotations
      .readOnlyHint,
    true,
  );
  await assert.rejects(
    api.callTool('figma_api', { query: 'FrameNode', topic: 'layout' }),
    /Choose/,
  );
  await assert.rejects(
    api.callTool('figma_api', { query: 'FrameNode', limit: 9 }),
    /invalid/,
  );
  for (const key of ['constructor', 'toString', '__proto__'])
    await assert.rejects(
      api.callTool('figma_api', { [key]: 'unexpected' }),
      /unexpected|invalid/,
    );
});

test('navigation and JSON exports use the existing exact-target receipt channel without design writes', async (t) => {
  const submissions = [];
  const api = isolatedRuntime(t, {
    companion: {
      ensureCompanion: async () => ({
        status: {
          clients: [
            {
              id: 'client-fixture',
              connected: true,
              fileKey: 'OriginalFile12',
              instanceId: 'original-instance',
            },
          ],
        },
      }),
    },
    'bridge-client': {
      bridgeRequest: async (_connection, route, options) => {
        assert.equal(route, '/v1/jobs');
        const submission = JSON.parse(options.body);
        submissions.push(submission);
        return {
          job: {
            id: submission.operationId,
            status: 'succeeded',
            target: submission.target,
            result: { value: {}, exports: [] },
          },
        };
      },
    },
    'artifact-client': { uploadAssets: async () => ({}) },
  });
  const navigation = await api.callTool('figma_navigate', {
    fileKey: 'OriginalFile12',
    operationId: 'native-navigate-01',
    pageId: '0:1',
    nodeIds: ['3:3'],
    zoomToFit: true,
  });
  assert.equal(navigation.job.id, 'native-navigate-01');
  assert.equal(submissions[0].target.instanceId, 'original-instance');
  assert.equal(submissions[0].args.pageId, '0:1');
  assert.deepEqual(submissions[0].args.nodeIds, ['3:3']);
  assert.equal(submissions[0].options.readOnly, true);
  assert.equal(submissions[0].options.commitUndo, false);
  await api.callTool('figma_navigate', {
    figmaUrl: 'https://www.figma.com/design/OriginalFile12/Test?node-id=3-3',
    operationId: 'native-navigate-url',
    pageId: '0:1',
  });
  assert.equal(submissions[1].args.nodeId, '3:3');
  await assert.rejects(
    api.callTool('figma_navigate', {
      figmaUrl: 'https://www.figma.com/design/OriginalFile12/Test?node-id=3-3',
      operationId: 'native-navigate-conflict',
      pageId: '0:1',
      nodeIds: ['3:4'],
    }),
    /choose.*URL node/,
  );
  assert.equal(submissions.length, 2);
  await api.callTool('figma_export_node', {
    fileKey: 'OriginalFile12',
    nodeId: '3:3',
    format: 'JSON_REST_V1',
  });
  const json = submissions[2];
  assert.equal(json.args.nodeId, '3:3');
  assert.equal(json.options.readOnly, true);
  assert.equal(json.options.commitUndo, false);
  assert.match(json.source, /bridge.query\('exportNode'/);
  assert.equal(json.args.format, 'JSON_REST_V1');
});
