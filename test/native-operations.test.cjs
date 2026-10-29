const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers/figma.cjs');
const navigateSource = "return await bridge.query('navigate', args);";
const jsonExportSource =
  "return await bridge.query('exportNode', {...args, format:'JSON_REST_V1'});";
const options = { readOnly: true, commitUndo: false };

test('native navigation selects the real page and nodes without content writes or Undo entries', async () => {
  const f = fixture(),
    page = f.figma.createPage(),
    node = f.figma.createFrame();
  page.appendChild(node);
  let fitted;
  f.figma.viewport = {
    center: { x: 12, y: 34 },
    zoom: 2,
    scrollAndZoomIntoView(nodes) {
      fitted = Array.from(nodes);
    },
  };
  const before = f.calls.creates;
  const result = await f.api.executeScript(
    navigateSource,
    {
      pageId: page.id,
      nodeIds: [node.id],
      zoomToFit: true,
    },
    {},
    options,
  );
  assert.equal(f.figma.currentPage, page);
  assert.deepEqual(Array.from(page.selection), [node]);
  assert.deepEqual(fitted, [node]);
  assert.equal(result.value.previousPageId, f.initial.id);
  assert.equal(result.value.page.id, page.id);
  assert.equal(result.value.viewport.zoom, 2);
  assert.equal(f.calls.creates, before);
  assert.equal(f.calls.commits, 0);
  await f.api.executeScript(navigateSource, { pageId: page.id }, {}, options);
  assert.equal(page.selection[0], node, 'omitting nodeIds preserves selection');
  await f.api.executeScript(
    navigateSource,
    { pageId: page.id, nodeIds: [] },
    {},
    options,
  );
  assert.equal(
    page.selection.length,
    0,
    'an explicit empty list clears selection',
  );
  await f.api.executeScript(
    navigateSource,
    { pageId: page.id, nodeId: node.id },
    {},
    options,
  );
  assert.equal(
    page.selection[0],
    node,
    'a node from the exact URL can be selected',
  );
});

test('native navigation rejects a missing page or a node on a different page', async () => {
  const f = fixture(),
    node = f.figma.createFrame(),
    other = f.figma.createPage();
  await assert.rejects(
    f.api.executeScript(navigateSource, { pageId: '99:99' }, {}, options),
    /not in this file/,
  );
  assert.equal(f.figma.currentPage, f.initial);
  await assert.rejects(
    f.api.executeScript(
      navigateSource,
      {
        pageId: other.id,
        nodeIds: [node.id],
      },
      {},
      options,
    ),
    /another page/,
  );
  assert.equal(other.selection.length, 0);
  assert.equal(f.calls.commits, 0);
});

test('native JSON export delivers exact UTF-8 bytes and never renames or mutates the node', async () => {
  const f = fixture(),
    node = f.figma.createFrame();
  node.name = '微缩 MacBook 💻';
  const native = {
    document: { id: node.id, name: node.name, characters: '中文\n"title"' },
  };
  node.exportAsync = async (settings) => {
    assert.equal(settings.format, 'JSON_REST_V1');
    return native;
  };
  const before = f.calls.creates;
  const result = await f.api.executeScript(
    jsonExportSource,
    { nodeId: node.id },
    {},
    options,
  );
  assert.equal(result.exports.length, 1);
  const exported = result.exports[0];
  assert.equal(exported.mimeType, 'application/json');
  assert.deepEqual(
    Buffer.from(exported.bytes),
    Buffer.from(JSON.stringify(native), 'utf8'),
  );
  assert.equal(result.value.bytes, exported.size);
  assert.equal(node.name, native.document.name);
  assert.equal(f.calls.creates, before);
  assert.equal(f.calls.commits, 0);
  f.initial.selection = [node];
  const selected = await f.api.executeScript(jsonExportSource, {}, {}, options);
  assert.equal(selected.value.nodeId, node.id);
});

test('JSON export requires one explicit or selected exportable node and preserves native failures', async () => {
  const f = fixture();
  await assert.rejects(
    f.api.executeScript(jsonExportSource, {}, {}, options),
    /Choose one exportable/,
  );
  const node = f.figma.createFrame();
  node.exportAsync = async () => {
    throw new Error('native export unavailable');
  };
  await assert.rejects(
    f.api.executeScript(jsonExportSource, { nodeId: node.id }, {}, options),
    /native export unavailable/,
  );
  assert.equal(f.calls.commits, 0);
});
test('unified export preserves REST-shaped page export while rejecting page image export', async () => {
  const f = fixture(),
    data = { document: { id: f.initial.id, type: 'CANVAS' } };
  f.initial.exportAsync = async (settings) => {
    assert.equal(settings.format, 'JSON_REST_V1');
    return data;
  };
  const exported = await f.api.executeScript(
    jsonExportSource,
    { nodeId: f.initial.id },
    {},
    options,
  );
  assert.equal(
    JSON.parse(Buffer.from(exported.exports[0].bytes)).document.id,
    f.initial.id,
  );
  await assert.rejects(
    f.api.executeScript(
      "return await bridge.query('exportNode',args);",
      { nodeId: f.initial.id, format: 'PNG' },
      {},
      options,
    ),
    /exportable node/,
  );
});
