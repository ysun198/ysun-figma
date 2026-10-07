const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const { readLedger } = require('../test-support/ledger.cjs');
const { fixture } = require('../test-support/figma.cjs');
const { createBridgeServer } = require('../scripts/bridge-server.cjs');
const { connectionPath, writePrivateJson } = require('../scripts/state.cjs');
const mcp = require('../build/plugin/scripts/mcp.cjs');

// Execute the shipped MCP, HTTP relay, browser UI and compiled native runtime.
// Only the Figma API/DOM boundaries are doubles; this is not a rendering test.
async function connected(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-execution-'));
  const before = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = directory;
  const bridge = createBridgeServer({
    port: 0,
    databasePath: path.join(directory, 'operations.sqlite'),
    catalogPath: path.join(directory, 'catalog.json'),
  });
  const { url } = await bridge.start();
  const connection = {
    url,
    token: bridge.token,
    protocolVersion: 3,
    pid: process.pid,
  };
  writePrivateJson(connectionPath(), connection);
  const f = fixture(),
    storage = new Map(),
    elements = new Map();
  let hidden = 0,
    ui;
  const delivered = [];
  const parent = {
    postMessage: (packet) => {
      delivered.push(packet.pluginMessage);
      void f.figma.ui.onmessage(packet.pluginMessage);
    },
  };
  Object.assign(f.figma, {
    showUI() {},
    on() {},
    notify() {},
    closePlugin() {},
    fileKey: 'FixtureFile12',
    clientStorage: {
      async getAsync(key) {
        return storage.get(key);
      },
      async setAsync(key, value) {
        storage.set(key, value);
      },
      async deleteAsync(key) {
        storage.delete(key);
      },
    },
    ui: {
      hide() {
        hidden++;
      },
      show() {},
      postMessage(message) {
        ui.onmessage({ source: parent, data: { pluginMessage: message } });
      },
    },
  });
  const native = vm.createContext({
    figma: f.figma,
    __html__: '',
    Uint8Array,
    console,
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../build/plugin/plugin-runtime.js'),
      'utf8',
    ),
    native,
  );
  ui = vm.createContext({
    parent,
    crypto: crypto.webcrypto,
    Uint8Array,
    fetch,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    document: {
      getElementById(id) {
        if (!elements.has(id))
          elements.set(id, { value: '', dataset: {}, addEventListener() {} });
        return elements.get(id);
      },
    },
  });
  vm.runInContext(
    fs
      .readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8')
      .replace("'http://localhost:38491'", JSON.stringify(url)),
    ui,
  );
  await new Promise((resolve) => setImmediate(resolve));
  elements.get('pair-code').value = bridge.createPairing().code;
  await ui.pair();
  const clientId = vm.runInContext('direct.clientId', ui);
  assert.equal(hidden, 1);
  assert.equal(storage.size, 1);
  t.after(async () => {
    ui.closePlugin();
    await bridge.stop();
    if (before === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = before;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...f,
    bridge,
    directory,
    delivered,
    connection,
    clientId,
    call: (name, args = {}) => mcp.callTool(name, { clientId, ...args }),
  };
}
test('shipped execution creates once, reads the same nodes and transfers exact binary assets and previews', async (t) => {
  const f = await connected(t);
  const source =
    'const node = figma.createFrame(); node.name = args.name; return node;';
  const input = {
    source,
    args: { name: 'Receipt-owned frame' },
    operationId: 'integration-create',
  };
  const created = await f.call('figma_run', input),
    nodeId = created.job.result.value.id,
    count = f.calls.creates;
  const repeated = await f.call('figma_run', input);
  assert.equal(repeated.job.result.value.id, nodeId);
  assert.equal(f.calls.creates, count);
  const inspected = await f.call('figma_inspect');
  assert.equal(inspected.job.result.value.children[0].id, nodeId);
  assert(
    f.delivered.find((message) => message.requestId === inspected.job.id).source
      .length < 100,
    'queries use the one compiled implementation',
  );
  assert.equal(f.calls.switches, 0);
  assert.equal(f.calls.commits, 1);

  const bytes = crypto.randomBytes(3 * 1024 * 1024),
    asset = path.join(f.directory, 'input.bin');
  fs.writeFileSync(asset, bytes);
  const transferred = await f.call('figma_run', {
    source:
      'bridge.exportFile("输出 参考.bin", bridge.assets["用户参考.bin"]); return {size: bridge.assets["用户参考.bin"].length};',
    assetPaths: { '用户参考.bin': asset },
    operationId: 'integration-binary',
  });
  assert.equal(transferred.job.result.value.size, bytes.length);
  const exported = await mcp.callTool('figma_export', {
    operationId: transferred.job.id,
    outputDirectory: path.join(f.directory, 'exports'),
  });
  assert.deepEqual(fs.readFileSync(exported.exportedFiles[0].path), bytes);
  assert(
    readLedger(path.join(f.directory, 'operations.sqlite')).storedBytes < 10000,
  );

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=',
    'base64',
  );
  f.nodes.find((node) => node.id === nodeId).exportAsync = async () =>
    new Uint8Array(png);
  const preview = await f.call('figma_run', {
    source:
      'return await bridge.screenshot(await figma.getNodeByIdAsync(args.nodeId));',
    args: { nodeId },
    readOnly: true,
    operationId: 'integration-preview',
  });
  assert.equal(preview[mcp.images][0].data, png.toString('base64'));
  assert.equal(preview.job.result.exports[0].mimeType, 'image/png');
  assert.deepEqual(f.figma.currentPage.selection, []);
});
test('a partial native write keeps its original receipt, permits inspection and blocks further writes until reconciled', async (t) => {
  const f = await connected(t);
  let receipt;
  await assert.rejects(
    f.call('figma_run', {
      source:
        'const n = figma.createFrame(); n.name = "Partial write"; console.log({createdId:n.id}); bridge.exportFile("进度.bin", new Uint8Array([0,255,9])); throw new Error("after mutation");',
      operationId: 'integration-partial',
    }),
    (error) => {
      receipt = error.receipt;
      return /outcome_unknown/.test(error.message);
    },
  );
  assert.equal(receipt.job.status, 'outcome_unknown');
  assert.match(receipt.job.result.logs[0].message, /createdId/);
  const progress = await mcp.callTool('figma_export', {
    operationId: receipt.job.id,
    outputDirectory: path.join(f.directory, 'partial-export'),
  });
  assert.deepEqual(
    fs.readFileSync(progress.exportedFiles[0].path),
    Buffer.from([0, 255, 9]),
  );
  const read = await f.call('figma_inspect'),
    node = read.job.result.value.children.find(
      (node) => node.name === 'Partial write',
    );
  assert(node);
  await assert.rejects(
    f.call('figma_run', {
      source: 'return figma.createFrame();',
      operationId: 'integration-blocked',
    }),
    (error) => {
      const value = mcp.toolError(error, {
        operationId: 'integration-blocked',
      });
      assert.equal(value.operationId, receipt.job.id);
      assert.equal(value.phase, 'preflight');
      assert.deepEqual(value.blockingOperationIds, [receipt.job.id]);
      assert.equal(value.safeToRetryWithoutCanvasRead, false);
      assert.match(value.next, /blocking operation/i);
      return /reconcil/.test(error.message);
    },
  );
  await mcp.callTool('figma_reconcile', {
    operationId: receipt.job.id,
    outcome: 'partially_applied',
    note: 'Read the original receipt and exact native node ' + node.id,
  });
  const cleaned = await f.call('figma_run', {
    source:
      'const n = await figma.getNodeByIdAsync(args.id); n.remove(); return {removed: args.id};',
    args: { id: node.id },
    operationId: 'integration-cleanup',
  });
  assert.equal(cleaned.job.status, 'succeeded');
  assert.equal(f.nodes.find((item) => item.id === node.id).removed, true);
});
test('a lost enqueue response is recovered through the same operation ID without a duplicate native write', async (t) => {
  const f = await connected(t);
  let drop = true;
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      f.connection.url + req.url,
      {
        method: req.method,
        headers: { ...req.headers, host: new URL(f.connection.url).host },
      },
      (reply) => {
        if (drop && req.method === 'POST' && req.url === '/v1/jobs') {
          drop = false;
          reply.resume();
          reply.once('end', () => res.destroy());
        } else {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        }
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  });
  writePrivateJson(connectionPath(), {
    ...f.connection,
    url: 'http://127.0.0.1:' + proxy.address().port,
  });
  const input = {
    source: 'return figma.createFrame();',
    operationId: 'integration-lost-reply',
  };
  await assert.rejects(f.call('figma_run', input), /fetch failed/);
  const original = await mcp.callTool('figma_job', {
    operationId: input.operationId,
    waitMs: 5000,
  });
  assert.equal(original.job.status, 'succeeded');
  const count = f.calls.creates,
    repeated = await f.call('figma_run', input);
  assert.equal(repeated.job.id, original.job.id);
  assert.equal(f.calls.creates, count);
});

test('asset preflight rejects traversal before any upload or native job and permits a corrected same-ID request', async (t) => {
  const f = await connected(t),
    filename = path.join(f.directory, '参考.bin');
  fs.writeFileSync(filename, Buffer.from([0, 255]));
  const input = {
    source: 'return bridge.assets["参考.bin"].length;',
    operationId: 'preflight-same-id',
    assetPaths: { '参考.bin': filename, 'bad/name': filename },
  };
  await assert.rejects(f.call('figma_run', input), (error) => {
    const e = mcp.toolError(error, input);
    assert.equal(e.phase, 'preflight');
    assert.match(e.error, /bad\/name/);
    assert.match(e.next, /No native job/);
    assert.equal(e.safeToRetryWithoutCanvasRead, true);
    return true;
  });
  assert.equal((await mcp.callTool('figma_status', {})).jobCount, 0);
  assert.equal(
    fs.existsSync(path.join(f.directory, 'artifacts/assets')),
    false,
  );
  const result = await f.call('figma_run', {
    ...input,
    assetPaths: { '参考.bin': filename },
  });
  assert.equal(result.job.result.value, 2);
});
test('shipped asset import and lightweight URL inspection share one native result and reject ignored replacement dimensions before upload', async (t) => {
  const f = await connected(t),
    svg = path.join(f.directory, 'arrow.svg');
  fs.writeFileSync(svg, '<svg width="20" height="21"/>');
  const create = f.figma.createNodeFromSvg;
  f.figma.createNodeFromSvg = () => {
    const node = create();
    node.resize(20, 21);
    return node;
  };
  const imported = await f.call('figma_upload_assets', {
    operationId: 'import-svg-contract',
    assetPaths: { 'arrow.svg': svg },
    width: 16,
    height: 16,
  });
  const asset = imported.job.result.value.assets[0];
  assert.equal(asset.assetName, 'arrow.svg');
  assert.deepEqual([asset.width, asset.height], [16, 16]);
  const read = await mcp.callTool('figma_inspect', {
    figmaUrl:
      'https://www.figma.com/design/FixtureFile12/File?node-id=' +
      asset.nodeId.replace(':', '-'),
  });
  assert.equal(read.job.result.value.nodes[0].id, asset.nodeId);
  assert.equal(read.job.result.value.nodes[0].width, 16);
  assert.equal(read.job.result.value.nodes[0].parent.id, f.initial.id);
  assert.equal(f.calls.commits, 1);
  assert.equal(f.calls.switches, 0);
  assert.deepEqual(f.initial.selection, []);
  const jobs = (await mcp.callTool('figma_status', {})).jobCount,
    assets = fs.readdirSync(path.join(f.directory, 'artifacts/assets'));
  await assert.rejects(
    f.call('figma_upload_assets', {
      operationId: 'invalid-fill-bounds',
      nodeId: asset.nodeId,
      width: 16,
      assetPaths: { 'image.png': '/missing/image.png' },
    }),
    (error) =>
      error.phase === 'preflight' && /preserves node/.test(error.message),
  );
  assert.equal((await mcp.callTool('figma_status', {})).jobCount, jobs);
  assert.deepEqual(
    fs.readdirSync(path.join(f.directory, 'artifacts/assets')),
    assets,
  );
  const status = await mcp.callTool('figma_status', {
    fileKey: 'FixtureFile12',
  });
  assert.equal(status.clients[0].id, f.clientId);
  assert.deepEqual(status.jobs, []);
  await assert.rejects(
    mcp.callTool('figma_status', { scope: 'all', clientId: f.clientId }),
    /choose all history/,
  );
});
