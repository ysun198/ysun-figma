const assert = require('node:assert/strict');
const test = require('node:test');
const { createDesignQueries } = require('../src/design-queries.js');
const { parseFigmaUrl, resolveTarget } = require('../scripts/targets.cjs');
const { validate, tools } = require('../scripts/mcp.cjs');
const { fixture: nativeFixture } = require('../test-support/figma.cjs');
function fixture() {
  const nodes = new Map(),
    exports = [];
  let loads = 0;
  const add = (id, type, name, extra = {}) => {
    const node = { id, type, name, ...extra };
    nodes.set(id, node);
    return node;
  };
  const text = add('2:3', 'TEXT', 'Title', {
    characters: 'Hello',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 16,
    fills: Symbol('mixed'),
    boundVariables: {
      fontSize: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' },
    },
    getStyledTextSegments: () => [
      { start: 0, end: 5, characters: 'Hello', fontSize: 16 },
    ],
    getCSSAsync: async () => ({ 'font-size': '16px' }),
  });
  const component = add('2:4', 'COMPONENT', 'Button', {
    key: 'component-key',
    remote: false,
    variantProperties: { Size: 'Small' },
    componentPropertyDefinitions: {
      Label: { type: 'TEXT', defaultValue: 'Go' },
    },
  });
  const frame = add('2:2', 'FRAME', 'Card', {
    width: 8000,
    height: 2000,
    absoluteBoundingBox: { x: -100, y: 20, width: 8000, height: 2000 },
    layoutMode: 'VERTICAL',
    paddingTop: 16,
    children: [text, component],
    exportAsync: async (settings) => {
      exports.push(settings);
      return new Uint8Array([1, 2, 3]);
    },
  });
  const page = add('0:1', 'PAGE', 'Page', {
    children: [frame],
    selection: [],
    exportAsync: async (settings) => {
      exports.push(settings);
      return new Uint8Array([1, 2, 3]);
    },
    loadAsync: async () => {
      loads++;
    },
  });
  frame.parent = page;
  text.parent = frame;
  component.parent = frame;
  const figma = {
    root: { name: 'Fixture', children: [page] },
    fileKey: undefined,
    editorType: 'figma',
    currentPage: page,
    getNodeByIdAsync: async (id) => nodes.get(id),
    variables: {
      getLocalVariableCollectionsAsync: async () => [
        {
          id: 'collection',
          name: 'Theme',
          modes: [{ modeId: 'light', name: 'Light' }],
          variableIds: ['one', 'two'],
        },
      ],
      getLocalVariablesAsync: async () => [
        {
          id: 'one',
          name: 'Primary',
          resolvedType: 'COLOR',
          variableCollectionId: 'collection',
          valuesByMode: { light: { r: 1, g: 0, b: 0 } },
        },
        {
          id: 'two',
          name: 'Alias',
          resolvedType: 'COLOR',
          variableCollectionId: 'collection',
          valuesByMode: { light: { type: 'VARIABLE_ALIAS', id: 'one' } },
        },
      ],
    },
  };
  const files = [],
    queries = createDesignQueries(figma, {
      documentRevision: 5,
      exportFile: (name, bytes, mimeType) =>
        files.push({ name, bytes, mimeType }),
    });
  return {
    queries,
    figma,
    page,
    frame,
    files,
    exports,
    get loads() {
      return loads;
    },
  };
}
test('design context reads layouts, mixed paints, text runs and CSS with explicit depth and node bounds', async () => {
  const f = fixture(),
    original = JSON.stringify({ page: f.page.id, selection: f.page.selection });
  let context = await f.queries.context({
    nodeId: f.frame.id,
    depth: 1,
    maxNodes: 2,
  });
  assert.equal(context.nodes[0].layoutMode, 'VERTICAL');
  assert.equal(context.nodes[0].children[0].fills, 'mixed');
  assert.equal(
    context.nodes[0].children[0].textSegments[0].characters,
    'Hello',
  );
  assert.equal(context.nodes[0].children[0].css['font-size'], '16px');
  assert.equal(context.visited, 2);
  assert.equal(context.truncated, true);
  context = await f.queries.context({ nodeId: f.frame.id, depth: 0 });
  assert.equal(context.nodes[0].childrenTruncated, true);
  assert.equal(
    JSON.stringify({ page: f.page.id, selection: f.page.selection }),
    original,
  );
  assert.equal(f.loads, 0);
});
test('bounded literal search and component discovery inspect a chosen subtree without changing selection', async () => {
  const f = fixture();
  f.page.selection = [f.frame];
  const found = await f.queries.findNodes({
    query: 'title',
    types: ['TEXT'],
    maxVisited: 10,
  });
  assert.equal(found.nodes[0].id, '2:3');
  assert.equal(f.loads, 1);
  const limited = await f.queries.findNodes({ limit: 1 });
  assert.equal(limited.truncated, true);
  const components = await f.queries.components({ rootId: '2:2' });
  assert.equal(
    components.nodes[0].component.propertyOwner.componentPropertyDefinitions
      .Label.defaultValue,
    'Go',
  );
  assert.equal(components.nodes[0].key, 'component-key');
  assert.deepEqual(f.page.selection, [f.frame]);
});
test('variable pagination preserves values, modes and aliases', async () => {
  const f = fixture(),
    first = await f.queries.variables({ limit: 1 });
  assert.equal(first.nextOffset, 1);
  assert.equal(first.collections[0].modes[0].name, 'Light');
  const second = await f.queries.variables({ offset: 1, limit: 1 });
  assert.deepEqual(second.variables[0].valuesByMode.light, {
    type: 'VARIABLE_ALIAS',
    id: 'one',
  });
  assert.equal(second.nextOffset, null);
});
test('native preview caps raster dimensions and refuses ambiguous targets or page export', async () => {
  const f = fixture();
  await f.queries.screenshot({ nodeId: '2:2', maxDimension: 1600 });
  assert.equal(f.exports[0].constraint.value, 0.2);
  assert.equal(f.files[0].mimeType, 'image/png');
  assert.deepEqual([...f.files[0].bytes], [1, 2, 3]);
  await assert.rejects(f.queries.screenshot({}), /Choose one/);
  await assert.rejects(f.queries.screenshot({ nodeId: '0:1' }), /Choose one/);
  await assert.rejects(f.queries.context({ nodeId: '1:999' }), /not found/);
});
test('canvas renders the whole native page, including sections with null render bounds; preserves active page and selection', async () => {
  const f = fixture();
  f.page.selection = [f.frame];
  f.frame.type = 'SECTION';
  f.frame.absoluteRenderBounds = null;
  f.page.children.push({
    visible: false,
    absoluteBoundingBox: { x: 1e6, y: 0, width: 100, height: 100 },
  });
  const value = await f.queries.canvas({
    pageId: f.page.id,
    maxDimension: 2000,
  });
  assert.equal(value.scale, 0.25);
  assert.deepEqual(value.bounds, { x: -100, y: 20, width: 8000, height: 2000 });
  assert.equal(value.revision, 5);
  assert.equal(value.pages[0].id, f.page.id);
  assert.equal(f.files[0].name, 'preview-canvas.png');
  assert.deepEqual(f.exports[0], {
    format: 'PNG',
    constraint: { type: 'SCALE', value: 0.25 },
  });
  assert.deepEqual(f.page.selection, [f.frame]);
  assert.equal(f.figma.currentPage, f.page);
  assert.equal(f.loads, 1);
  await assert.rejects(
    f.queries.canvas({ pageId: f.frame.id }),
    /must identify a page/,
  );
});
test('empty canvas skips exports, and reading another page never activates it', async () => {
  const f = fixture();
  const active = f.figma.currentPage;
  f.page.children = [];
  const value = await f.queries.canvas();
  assert.equal(value.empty, true);
  assert.equal(f.exports.length, 0);
  const other = { ...f.page, id: '0:2', children: [f.frame] };
  f.figma.root.children.push(other);
  f.figma.getNodeByIdAsync = async () => other;
  const next = await f.queries.canvas({ pageId: '0:2' });
  assert.equal(next.page.id, '0:2');
  assert.equal(f.figma.currentPage, active);
});
test('canvas is an app-only read with exact client and file identity required', () => {
  const tool = tools.find((tool) => tool.name === 'figma_canvas');
  assert.deepEqual(tool._meta.ui.visibility, ['app']);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.throws(() => validate({}, tool.inputSchema), /required/);
  assert.throws(
    () => validate({ clientId: 'client-123' }, tool.inputSchema),
    /required/,
  );
  validate(
    { clientId: 'client-123', fileKey: 'Abc123456', pageId: '0:1' },
    tool.inputSchema,
  );
});
test('Figma URL targeting rejects unsafe URLs and refuses title guesses or cross-file links', () => {
  const url = 'https://www.figma.com/design/Abc123456/Example?node-id=2-3';
  assert.deepEqual(parseFigmaUrl(url), { fileKey: 'Abc123456', nodeId: '2:3' });
  assert.equal(
    parseFigmaUrl('https://figma.com/design/Abc123456/branch/Branch123/Title')
      .fileKey,
    'Branch123',
  );
  assert.deepEqual(
    parseFigmaUrl('https://figma.com/design/Abc123456/branch?node-id=2-3'),
    { fileKey: 'Abc123456', nodeId: '2:3' },
    'a filename is not a branch route',
  );
  assert.equal(
    parseFigmaUrl('https://figma.com/design/branch/Normal').fileKey,
    'branch',
    'a key is not a branch route',
  );
  for (const bad of [
    'http://figma.com/design/Abc123456',
    'https://figma.com.evil.test/design/Abc123456',
    'https://user:pass@figma.com/design/Abc123456',
    'https://figma.com/design/Abc123456?node-id=2-3&node-id=4-5',
  ])
    assert.throws(() => parseFigmaUrl(bad));
  const client = { id: 'client-123', fileName: 'Example', connected: true };
  assert.throws(
    () => resolveTarget({ figmaUrl: url }, [client]),
    /No matching/,
  );
  assert.throws(
    () => resolveTarget({ figmaUrl: url, clientId: client.id }, [client]),
    /No matching/,
  );
  assert.throws(
    () =>
      resolveTarget({ figmaUrl: url, clientId: client.id }, [
        { ...client, fileKey: 'Other123' },
      ]),
    /No matching/,
  );
  assert.throws(
    () =>
      resolveTarget({ fileName: 'Example' }, [
        client,
        { ...client, id: 'client-456' },
      ]),
    /Several/,
  );
  assert.throws(
    () =>
      resolveTarget({ figmaUrl: url, nodeId: '4:5', clientId: client.id }, [
        client,
      ]),
    /choose the URL/,
  );
  assert.equal(
    resolveTarget({ figmaUrl: url }, [{ ...client, fileKey: 'Abc123456' }])
      .targeting.fileKeyVerified,
    true,
  );
});
test('bare verified file keys select and report the exact file among concurrent clients', () => {
  const a = {
    id: 'client-123',
    fileName: 'Same name',
    connected: true,
    fileKey: 'Abc123456',
  };
  const b = {
    id: 'client-456',
    fileName: 'Same name',
    connected: true,
    fileKey: 'Other123',
  };
  const result = resolveTarget({ fileKey: b.fileKey }, [a, b]);
  assert.equal(result.clientId, b.id);
  assert.equal(result.targeting.fileKeyVerified, true);
  assert.equal(result.targeting.targetedBy, 'fileKey');
  assert.equal(
    resolveTarget({ clientId: b.id, fileKey: b.fileKey }, [a, b]).targeting
      .fileKeyVerified,
    true,
  );
  assert.throws(
    () => resolveTarget({ clientId: a.id, fileKey: b.fileKey }, [a, b]),
    /No matching/,
  );
  assert.equal(
    resolveTarget({ clientId: a.id }, [a, b]).targeting.fileKeyVerified,
    false,
  );
});
test('tool schemas reject oversized and duplicate node lists, out-of-range depths and incompatible types', () => {
  const schema = tools.find(
    (t) => t.name === 'figma_design_context',
  ).inputSchema;
  for (const args of [
    { depth: 7 },
    { nodeIds: ['2:3', '2:3'] },
    { nodeIds: ['bad'] },
    { nodeIds: [] },
    { maxNodes: 0 },
    { includeCSS: 'yes' },
  ])
    assert.throws(() => validate(args, schema));
  validate({ nodeIds: ['2:3'], depth: 0, includeCSS: false }, schema);
});
test('trusted read failures do not make a fictitious uncertain write or commit Undo', async () => {
  const f = nativeFixture(),
    creates = f.calls.creates;
  await assert.rejects(
    f.api.executeScript(
      'throw new Error("missing node");',
      {},
      {},
      { readOnly: true, commitUndo: false },
    ),
    (e) => e.outcomeUnknown === false && /missing node/.test(e.message),
  );
  assert.equal(f.calls.creates, creates);
  assert.equal(f.calls.commits, 0);
});
