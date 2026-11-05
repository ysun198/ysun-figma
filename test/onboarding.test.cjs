const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('a fresh standalone package loads its setup guide and prepares native connection without Desktop or cloud credentials', async (t) => {
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'figma-onboarding-')),
  );
  const state = path.join(temp, 'private state'),
    bundle = path.join(temp, '独立安装 package'),
    extracted = path.join(bundle, 'plugin');
  const previous = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = state;
  await require('../scripts/build-codex.cjs').buildCodexBundle(bundle);
  const catalog = JSON.parse(
    fs.readFileSync(path.join(bundle, '.agents/plugins/marketplace.json')),
  );
  assert.equal(path.resolve(bundle, catalog.plugins[0].source.path), extracted);
  assert.equal(fs.existsSync(state), false);
  assert.equal(fs.existsSync(path.join(extracted, 'node_modules')), false);
  const child = spawn(
    '/bin/sh',
    [path.join(extracted, 'scripts/launch-mcp.sh')],
    {
      env: {
        ...process.env,
        FIGMA_PLUGIN_NODE: process.execPath,
        FIGMA_PLUGIN_DISABLE_UPDATES: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let buffer = '',
    stderr = '',
    id = 0,
    bridge;
  const pending = new Map();
  function fail(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.once('exit', () => fail(new Error('fresh MCP closed: ' + stderr)));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      let response;
      try {
        response = JSON.parse(buffer.slice(0, end));
      } catch (error) {
        fail(error);
        return;
      }
      buffer = buffer.slice(end + 1);
      const item = pending.get(response.id);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(response.id);
        item.resolve(response);
      }
    }
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('fresh MCP timeout: ' + method + ' ' + stderr));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) +
          '\n',
      );
    });
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    await bridge?.stop();
    if (previous === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const init = await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'first-install', version: '1' },
  });
  assert.equal(
    init.result.serverInfo.version,
    require('../package.json').version,
  );
  child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n',
  );
  const tools = await call('tools/list');
  assert(!tools.error, JSON.stringify(tools.error));
  assert(tools.result.tools.some((t) => t.name === 'figma_file'));
  const reference = await call('tools/call', {
    name: 'figma_api',
    arguments: { workflow: 'setup' },
  });
  assert.equal(reference.result.isError, false);
  const guide = reference.result.structuredContent.workflow;
  const { currentPath, verify } = require('../src/host/installation.cjs');
  assert.equal(
    guide.path,
    path.join(currentPath(), 'skills/ysun-figma-setup/SKILL.md'),
  );
  assert.equal(guide.text, fs.readFileSync(guide.path, 'utf8'));
  assert.equal(fs.existsSync(path.join(state, 'connection.json')), false);
  assert.equal(fs.existsSync(path.join(state, 'desktop')), false);
  const {
    createBridgeServer,
    PROTOCOL_VERSION,
  } = require('../src/host/bridge-server.cjs');
  bridge = createBridgeServer({
    port: 0,
    databasePath: path.join(state, 'operations.sqlite'),
  });
  const connection = await bridge.start();
  require('../src/host/state.cjs').writePrivateJson(
    path.join(state, 'connection.json'),
    { ...connection, token: bridge.token, protocolVersion: PROTOCOL_VERSION },
  );
  const prepared = await call('tools/call', {
    name: 'figma_connect',
    arguments: {},
  });
  assert.equal(prepared.result.isError, false);
  const result = prepared.result.structuredContent;
  assert.equal(result.state, 'connection_required');
  assert.equal(result.code, undefined);
  assert.equal(fs.existsSync(result.manifestPath), true);
  const status = await call('tools/call', {
    name: 'figma_status',
    arguments: {},
  });
  assert.equal(status.result.structuredContent.jobCount, 0);
  assert.equal(status.result.structuredContent.clients.length, 0);
  assert.equal(fs.existsSync(path.join(state, 'desktop')), false);
  assert.equal(fs.existsSync(path.join(state, 'rest/credential.json')), false);
  assert.equal(
    verify(currentPath()).version,
    require('../package.json').version,
  );
  assert.equal(stderr, '');
});
