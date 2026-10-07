const assert = require('node:assert/strict');
const fs = require('node:fs');
process.env.FIGMA_PLUGIN_DISABLE_UPDATES = '1';
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const test = require('node:test');

test('parallel Codex refreshes initialize every transport with the real bundled-sized runtime', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-refresh-')),
    state = path.join(temp, 'state'),
    source = require('../scripts/build.cjs').output,
    previousState = process.env.FIGMA_PLUGIN_STATE_DIR,
    previousRuntime = process.env.FIGMA_PLUGIN_BUNDLED_NODE;
  let runtime = process.execPath;
  if (
    process.platform === 'darwin' &&
    execFileSync('/usr/bin/lipo', ['-archs', runtime], { encoding: 'utf8' })
      .trim()
      .split(/\s+/).length > 1
  ) {
    // Distribution ships one architecture, not a universal developer binary.
    // Keep the real executable and integrity checks without doubling every read.
    runtime = path.join(temp, 'node');
    execFileSync('/usr/bin/lipo', [
      process.execPath,
      '-thin',
      process.arch === 'x64' ? 'x86_64' : process.arch,
      '-output',
      runtime,
    ]);
    fs.chmodSync(runtime, 0o700);
  }
  process.env.FIGMA_PLUGIN_STATE_DIR = state;
  process.env.FIGMA_PLUGIN_BUNDLED_NODE = runtime;
  const children = [];
  t.after(async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            child.once('exit', resolve);
            child.kill();
          }),
      ),
    );
    if (previousState === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = previousState;
    if (previousRuntime === undefined)
      delete process.env.FIGMA_PLUGIN_BUNDLED_NODE;
    else process.env.FIGMA_PLUGIN_BUNDLED_NODE = previousRuntime;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const {
    prepareManagedCompanion,
    verify,
    currentPath,
  } = require('../scripts/installation.cjs');
  await prepareManagedCompanion(source);
  const original = verify(currentPath()),
    env = { ...process.env };
  const start = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        runtime,
        [path.join(source, 'scripts/launch-mcp.cjs')],
        {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let buffer = '',
        stderr = '';
      const timeout = setTimeout(
        () => reject(new Error('refresh initialize timed out: ' + stderr)),
        10000,
      );
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(
          new Error(stderr || 'refresh closed before initialize: ' + code),
        );
      });
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          assert.equal(
            response.result.serverInfo.version,
            require('../package.json').version,
          );
          assert.equal(stderr, '');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'parallel-refresh-test', version: '1' },
          },
        }) + '\n',
      );
    });
  await Promise.all(Array.from({ length: 12 }, start));
  assert.deepEqual(verify(currentPath()), original);
  assert.deepEqual(fs.readdirSync(path.join(state, 'companion')), ['current']);
});

test('a running managed MCP survives host cache deletion and serves activated UI without a new conversation', async (t) => {
  const root = require('../scripts/build.cjs').output,
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-managed-cache-'));
  const state = path.join(temp, 'state'),
    cache = path.join(temp, 'host-cache');
  const previous = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = state;
  const {
    publicEntries,
    prepareManagedCompanion,
  } = require('../scripts/installation.cjs');
  function copyPackage(destination, version) {
    for (const file of publicEntries(root)) {
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    if (version) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(destination, 'package.json')),
      );
      pkg.version = version;
      fs.writeFileSync(
        path.join(destination, 'package.json'),
        JSON.stringify(pkg),
      );
      fs.appendFileSync(
        path.join(destination, 'app.html'),
        '\n<!-- activated-ui:' + version + ' -->',
      );
    }
  }
  const older = require('../package.json').version.split('.').map(Number);
  if (older[2]) older[2]--;
  else if (older[1]) older[1]--;
  else older[0]--;
  copyPackage(cache, older.join('.'));
  await prepareManagedCompanion(cache);
  const {
    createBridgeServer,
    PROTOCOL_VERSION,
  } = require('../scripts/bridge-server.cjs');
  const server = createBridgeServer({ port: 0 });
  const connection = await server.start();
  fs.writeFileSync(
    path.join(state, 'connection.json'),
    JSON.stringify({
      ...connection,
      token: server.token,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  const paired = await fetch(connection.url + '/v1/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: server.createPairing().code,
      clientId: 'cache-native-fixture',
      fileName: 'Design',
      runtimeVersion: require('../src/core.js').BRIDGE_RUNTIME_VERSION,
      nativeBuild: 'a'.repeat(64),
    }),
  });
  assert.equal(paired.status, 200);
  const env = { ...process.env };
  delete env.FIGMA_PLUGIN_BUNDLED_NODE;
  const child = spawn(
    process.execPath,
    [path.join(cache, 'scripts/launch-mcp.cjs')],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let buffer = '',
    stderr = '';
  const pending = new Map(),
    notifications = [];
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id === undefined) {
        notifications.push(message.method);
        continue;
      }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  t.after(async () => {
    const closed = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await closed;
    await server.stop();
    if (previous === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id,
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                'MCP timeout ' + requestId + ' in ' + method + ': ' + stderr,
              ),
            ),
          10000,
        );
      pending.set(requestId, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) +
          '\n',
      );
    });
  assert(
    !(
      await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'cache-lifecycle-test', version: '1' },
      })
    ).error,
  );
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const uri = (await call('resources/list')).result.resources[0].uri;
  const initialStatus = await call('tools/call', {
    name: 'figma_status',
    arguments: {},
  });
  assert.equal(initialStatus.result.isError, false);
  assert.equal(
    initialStatus.result.structuredContent.clients[0].needsPluginUpdate,
    false,
  );
  fs.rmSync(cache, { recursive: true });
  const status = await call('tools/call', {
    name: 'figma_status',
    arguments: {},
  });
  assert.equal(status.result.isError, false);
  assert.equal(
    status.result.structuredContent.version,
    require('../package.json').version,
  );
  const newer = path.join(temp, 'new-source'),
    parts = require('../package.json').version.split('.').map(Number);
  parts[2]++;
  copyPackage(newer, parts.join('.'));
  fs.unlinkSync(path.join(state, 'connection.json')); // The fixture bridge is in-process, outside the managed lifecycle.
  await prepareManagedCompanion(newer);
  fs.writeFileSync(
    path.join(state, 'connection.json'),
    JSON.stringify({
      ...connection,
      token: server.token,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  const promotedUri = (await call('resources/list')).result.resources[0].uri;
  assert.equal(promotedUri, uri);
  assert.deepEqual(notifications, [
    'notifications/tools/list_changed',
    'notifications/resources/list_changed',
  ]);
  const tools = await call('tools/list');
  assert.equal(
    tools.result.tools.find((tool) => tool.name === 'figma_open')._meta.ui
      .resourceUri,
    promotedUri,
  );
  const resource = await call('resources/read', { uri });
  assert(
    resource.result.contents[0].text.includes(
      'activated-ui:' + parts.join('.'),
    ),
  );
  assert.equal(
    (await call('tools/call', { name: 'figma_status', arguments: {} })).result
      .isError,
    false,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(state, 'plugin/plugin-runtime.js')),
    fs.readFileSync(path.join(root, 'plugin-runtime.js')),
  );
  assert.equal(stderr, '');
  assert.equal(child.exitCode, null);
});

test('a stale host package starts the verified current MCP without downgrading code or runtime', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-stale-launch-')),
    state = path.join(temp, 'state');
  const previous = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = state;
  const root = require('../scripts/build.cjs').output,
    cached = path.join(temp, 'cached'),
    newer = path.join(temp, 'newer');
  fs.cpSync(root, cached, { recursive: true });
  fs.cpSync(root, newer, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(newer, 'package.json'))),
    parts = pkg.version.split('.').map(Number);
  parts[2]++;
  pkg.version = parts.join('.');
  fs.writeFileSync(path.join(newer, 'package.json'), JSON.stringify(pkg));
  const {
    prepareManagedCompanion,
    verify,
    currentPath,
  } = require('../scripts/installation.cjs');
  await prepareManagedCompanion(newer);
  const before = verify(currentPath());
  const env = { ...process.env };
  delete env.FIGMA_PLUGIN_BUNDLED_NODE;
  const child = spawn(
    process.execPath,
    [path.join(cached, 'scripts/launch-mcp.cjs')],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '',
    buffer = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await closed;
    }
    if (previous === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const reply = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error('stale transport initialize timed out: ' + stderr)),
      10000,
    );
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        clearTimeout(timeout);
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(stderr || 'stale transport closed before initialize'));
    });
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stale-host-test', version: '1' },
      },
    }) + '\n',
  );
  assert.equal((await reply).result.serverInfo.version, pkg.version);
  assert.deepEqual(verify(currentPath()), before);
  assert.deepEqual(fs.readdirSync(path.join(state, 'companion')), ['current']);
  assert.equal(stderr, '');
});
