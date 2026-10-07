const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
function isolatedRuntime(t, overrides) {
  const saved = new Map();
  for (const [name, patch] of Object.entries(overrides)) {
    const id = require.resolve('../scripts/' + name + '.cjs');
    const original = require(id);
    saved.set(id, require.cache[id]);
    require.cache[id] = {
      ...require.cache[id],
      exports: { ...original, ...patch },
    };
  }
  const id = require.resolve('../scripts/mcp.cjs');
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
test('submission rejects an instance changed while assets were being uploaded', async (t) => {
  const { createBridgeServer } = require('../scripts/bridge-server.cjs');
  const { BRIDGE_RUNTIME_VERSION } = require('../src/core.js');
  const { bridgeRequest } = require('../scripts/bridge-client.cjs');
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
    companion: { ensureCompanion: async () => connection },
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
    companion: { ensureCompanion: async () => ({}) },
    'bridge-client': {
      bridgeRequest: async (_connection, route) =>
        route === '/v1/jobs'
          ? { job }
          : { clients: [{ id: 'client-fixture', connected: true }] },
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
    companion: { ensureCompanion: async () => ({}) },
    'bridge-client': {
      bridgeRequest: async (_connection, route) => {
        if (route.startsWith('/v1/status'))
          return { clients: [{ id: 'client-fixture', connected: true }] };
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
  const { fileList } = require('../scripts/app.cjs');
  const data = fileList(
    { clients },
    {
      files: [{ fileKey: 'CloudFile1', name: 'File' }],
      status: 'incomplete',
      browserSpace: 12,
      error: 'folder_navigation_changed',
      coverage: [{ route: '/drafts', complete: true }],
    },
  );
  assert.equal(data.files[0].clientId, null);
  assert.equal(data.files[0].sessions.length, 2);
  assert.equal(data.catalog.error, 'folder_navigation_changed');
  assert.equal(data.catalog.browserSpace, 12);
  assert.equal(data.catalog.coverage.length, 1);
});
test('stdio MCP negotiates, lists tools and reports invalid calls without stdout noise or startup dependencies', async (t) => {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, '../build/plugin/scripts/mcp.cjs')],
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
  assert.equal(result.result.tools.length, 22);
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
  const { fileList } = require('../scripts/app.cjs');
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
  } = require('../scripts/bridge-server.cjs');
  const { BRIDGE_RUNTIME_VERSION } = require('../src/core.js');
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
  const { callTool } = require('../scripts/mcp.cjs');
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
  const { toolError } = require('../scripts/mcp.cjs');
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
  const { launchDesktop } = require('../scripts/mcp.cjs');
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
  };
  assert.equal(
    (await launchDesktop('CloudFile12', run, 'darwin')).state,
    'opened',
  );
  assert.deepEqual(calls[0], [
    'open',
    ['-a', 'Figma', 'figma://file/CloudFile12'],
    { timeout: 10000 },
  ]);
  await launchDesktop(undefined, run, 'darwin');
  assert.deepEqual(calls[1][1], ['-a', 'Figma']);
  await assert.rejects(
    launchDesktop('../../private', run, 'darwin'),
    /Invalid/,
  );
  await assert.rejects(
    launchDesktop(undefined, run, 'linux'),
    /requires macOS/,
  );
  await assert.rejects(
    launchDesktop(
      undefined,
      async () => {
        throw new Error('App not installed');
      },
      'darwin',
    ),
    /not installed/,
  );
});
