const assert = require('node:assert/strict');
const test = require('node:test');
const { createDesignQueries } = require('../src/figma/design-queries.js');
const { fixture } = require('./helpers/figma.cjs');

function graph() {
  const nodes = new Map(),
    files = [],
    renderSettings = [],
    loads = [];
  const add = (id, type, name, extra = {}) => {
    const node = { id, type, name, ...extra };
    nodes.set(id, node);
    return node;
  };
  const first = add('1:1', 'PAGE', 'First', {
    children: [],
    selection: [],
    loadAsync: async () => loads.push('1:1'),
  });
  const second = add('1:2', 'PAGE', 'Second', {
    children: [],
    selection: [],
    loadAsync: async () => loads.push('1:2'),
  });
  const frame = add('2:1', 'FRAME', 'Panel', {
    width: 8000,
    height: 2000,
    children: [],
    parent: first,
    exportAsync: async (settings) => {
      renderSettings.push(settings);
      return new Uint8Array([137, 80, 78, 71]);
    },
  });
  first.children.push(frame);
  const color = {
    id: 'color',
    name: 'color/accent',
    variableCollectionId: 'theme',
    resolvedType: 'COLOR',
    valuesByMode: { light: { r: 1, g: 0, b: 0 } },
  };
  const alias = {
    id: 'alias',
    name: 'color/action',
    variableCollectionId: 'theme',
    resolvedType: 'COLOR',
    valuesByMode: { light: { type: 'VARIABLE_ALIAS', id: 'color' } },
  };
  const style = {
    id: 'style',
    name: 'Body',
    type: 'TEXT',
    fontName: { family: 'Inter', style: 'Regular' },
    boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'alias' } },
  };
  const figma = {
    root: { name: 'Fixture', children: [first, second] },
    currentPage: first,
    editorType: 'figma',
    getNodeByIdAsync: async (id) => nodes.get(id),
    getStyleByIdAsync: async () => style,
    variables: {
      getVariableByIdAsync: async (id) =>
        id === 'color' ? color : id === 'alias' ? alias : null,
      getVariableCollectionByIdAsync: async () => ({
        id: 'theme',
        name: 'Theme',
        modes: [{ modeId: 'light', name: 'Light' }],
      }),
      getLocalVariablesAsync: async () => [color, alias],
      getLocalVariableCollectionsAsync: async () => [
        {
          id: 'theme',
          name: 'Theme',
          modes: [{ modeId: 'light', name: 'Light' }],
        },
      ],
    },
    getLocalTextStylesAsync: async () => [style],
  };
  const bridge = {
    documentId: 'document-one',
    documentRevision: 4,
    exportFile: (name, bytes, mimeType) =>
      files.push({ name, bytes, mimeType }),
  };
  return {
    add,
    nodes,
    files,
    renderSettings,
    loads,
    first,
    second,
    frame,
    figma,
    bridge,
    queries: createDesignQueries(figma, bridge),
  };
}
test('component search reports field truncation separately from traversal and returns getter failures', async () => {
  const f = graph(),
    component = f.add('3:1', 'COMPONENT', 'Many properties', {
      componentPropertyDefinitions: Object.fromEntries(
        Array.from({ length: 105 }, (_, i) => [
          'Label' + i,
          { type: 'TEXT', defaultValue: 'text' },
        ]),
      ),
    });
  f.frame.children.push(component);
  const result = await f.queries.components({});
  assert.equal(result.traversalTruncated, false);
  assert.equal(result.truncated, true);
  assert.equal(result.sparse, true);
  assert(result.issues.some((issue) => issue.reason === 'object truncated'));
  Object.defineProperty(component, 'description', {
    get() {
      throw new Error('cloud unavailable');
    },
  });
  const failed = await f.queries.components({});
  assert(failed.issues.some((issue) => issue.field === 'description'));
});
test('design-system component scope follows the declared page default and explicit file traversal', async () => {
  const f = graph();
  for (const page of [f.first, f.second])
    page.children.push(
      f.add(page.id === '1:1' ? '3:1' : '3:2', 'COMPONENT', 'Button', {
        componentPropertyDefinitions: {},
      }),
    );
  const query = { queries: [{ entity: 'component', query: 'Button' }] };
  assert.equal(
    (await f.queries.designSystem(query)).results[0].nodes.length,
    1,
  );
  assert.equal(
    (await f.queries.designSystem({ ...query, scope: 'file' })).results[0].nodes
      .length,
    2,
  );
});

test('context resolves run-level styles and variable aliases and obtains a bounded preview', async () => {
  const f = graph();
  const text = f.add('3:1', 'TEXT', 'Mixed', {
    characters: 'Hello',
    fills: Symbol('mixed'),
    getStyledTextSegments: () => [
      {
        characters: 'Hello',
        textStyleId: 'style',
        fills: [{ type: 'IMAGE', imageHash: 'original' }],
      },
    ],
  });
  f.frame.children.push(text);
  const value = await f.queries.context({ nodeId: f.frame.id });
  assert.equal(value.resources.styles[0].id, 'style');
  assert.deepEqual(
    value.resources.variables.map((v) => v.id),
    ['alias', 'color'],
  );
  assert.equal(value.resources.collections[0].id, 'theme');
  assert.deepEqual(value.assets, [{ imageHash: 'original', nodeIds: ['3:1'] }]);
  assert.equal(value.preview.settings.constraint.value, 0.2);
  assert.equal(value.sparse, false);
  assert.equal(f.figma.currentPage, f.first);
  assert.deepEqual(f.first.selection, []);
});
test('component discovery reads variant properties on their owner, avoiding an invalid variant getter', async () => {
  const f = graph(),
    set = f.add('3:1', 'COMPONENT_SET', 'Button', {
      key: 'set-key',
      componentPropertyDefinitions: {
        State: { type: 'VARIANT', defaultValue: 'Default' },
      },
    });
  const variant = f.add('3:2', 'COMPONENT', 'State=Default', {
    parent: set,
    key: 'variant-key',
  });
  Object.defineProperty(variant, 'componentPropertyDefinitions', {
    get() {
      throw new Error('not on variants');
    },
  });
  const instance = f.add('3:3', 'INSTANCE', 'Button instance', {
    getMainComponentAsync: async () => variant,
  });
  f.frame.children.push(variant, instance);
  const value = await f.queries.context({
    nodeId: f.frame.id,
    includeScreenshot: false,
  });
  assert.equal(value.issues.length, 0);
  for (const child of value.nodes[0].children)
    assert.equal(child.component.propertyOwner.id, set.id);
  assert.equal(
    value.nodes[0].children[1].component.propertyOwner
      .componentPropertyDefinitions.State.type,
    'VARIANT',
  );
});
test('editor context preserves diagram relationships and slide transitions without implicit non-Design CSS calls', async () => {
  const f = graph();
  f.figma.editorType = 'figjam';
  const shape = f.add('3:1', 'SHAPE_WITH_TEXT', 'Step', {
    shapeType: 'ROUNDED_RECTANGLE',
    text: {
      characters: 'Read',
      fontName: { family: 'Inter', style: 'Medium' },
      getStyledTextSegments: () => [
        { characters: 'Read', textStyleId: 'style' },
      ],
    },
    getCSSAsync: async () => {
      throw new Error('unable to generate code');
    },
  });
  const connector = f.add('3:2', 'CONNECTOR', 'Link', {
    connectorLineType: 'ELBOWED',
    connectorStart: { endpointNodeId: '3:1', magnet: 'RIGHT' },
    connectorEnd: { endpointNodeId: '3:4', magnet: 'LEFT' },
  });
  const slide = f.add('3:4', 'SLIDE', 'Slide', {
    isSkippedSlide: false,
    getSlideTransition: () => ({ style: 'DISSOLVE', duration: 0.4 }),
  });
  f.frame.children.push(shape, connector, slide);
  const result = await f.queries.context({
    nodeId: f.frame.id,
    includeScreenshot: false,
  });
  assert.equal(result.sparse, false);
  assert.equal(result.nodes[0].children[0].shapeType, 'ROUNDED_RECTANGLE');
  assert.equal(result.resources.styles[0].id, 'style');
  assert.equal(result.nodes[0].children[1].connectorEnd.endpointNodeId, '3:4');
  assert.equal(result.nodes[0].children[2].slideTransition.duration, 0.4);
  const explicit = await f.queries.context({
    nodeId: shape.id,
    includeCSS: true,
    includeScreenshot: false,
  });
  assert(explicit.issues.some((issue) => issue.field === 'css'));
});
test('file-wide cursor covers both pages exactly once and expires on a document or query change', async () => {
  const f = graph();
  f.second.children.push(
    f.add('3:1', 'TEXT', 'Other title', { parent: f.second }),
  );
  let cursor,
    ids = [];
  do {
    const result = await f.queries.findNodes({
      scope: 'file',
      limit: 1,
      cursor,
    });
    ids.push(...result.nodes.map((n) => n.id));
    cursor = result.cursor;
  } while (cursor);
  assert.deepEqual(ids, ['1:1', '2:1', '1:2', '3:1']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(f.figma.currentPage, f.first);
  assert.deepEqual(f.first.selection, []);
  const start = await f.queries.findNodes({ scope: 'file', limit: 1 });
  await assert.rejects(
    f.queries.findNodes({
      scope: 'file',
      query: 'different',
      cursor: start.cursor,
    }),
    /expired/,
  );
  f.bridge.documentRevision++;
  await assert.rejects(
    f.queries.findNodes({ scope: 'file', cursor: start.cursor }),
    /expired/,
  );
});
test('immutable native errors retain their message and query diagnostics', async () => {
  const f = graph();
  const nativeError = Object.freeze(
    new Error('native cloud connection failed'),
  );
  f.figma.getNodeByIdAsync = async () => {
    throw nativeError;
  };
  await assert.rejects(f.queries.findNodes({ rootId: f.frame.id }), (error) => {
    assert.notEqual(error, nativeError);
    assert.equal(error.message, nativeError.message);
    assert.equal(error.queryDiagnostics.nativeReads.getNodeByIdAsync.calls, 1);
    assert.equal(Object.hasOwn(nativeError, 'queryDiagnostics'), false);
    return true;
  });
});
test('wide native child getters are read once and continuation resolves only visited nodes', async () => {
  const f = graph();
  const children = Array.from({ length: 10000 }, (_, i) =>
    f.add('3:' + i, 'RECTANGLE', 'Stress ' + i, { parent: f.frame }),
  );
  let childReads = 0;
  const lookups = [];
  Object.defineProperty(f.frame, 'children', {
    get() {
      childReads++;
      return children.slice();
    },
  });
  f.figma.getNodeByIdAsync = async (id) => {
    lookups.push(id);
    return f.nodes.get(id);
  };
  const args = { rootId: f.frame.id, types: ['RECTANGLE'], limit: 500 };
  const first = await f.queries.findNodes(args);
  assert.equal(first.nodes.length, 500);
  assert.equal(childReads, 1);
  assert(first.cursor);
  lookups.length = 0;
  const next = await f.queries.findNodes({ ...args, cursor: first.cursor });
  assert.equal(next.nodes.length, 500);
  assert.equal(lookups.length, 501, 'root plus the requested page only');
  assert.equal(next.nodes[0].id, children[500].id);
  assert.equal(next.nodes.at(-1).id, children[999].id);
  assert.equal(childReads, 1, 'the already expanded root stays expanded');
  await assert.rejects(
    f.queries.findNodes({
      ...args,
      cursor: JSON.stringify({ ...JSON.parse(first.cursor), pending: [null] }),
    }),
    /expired/,
  );
  childReads = 0;
  const context = await f.queries.context({
    nodeId: f.frame.id,
    depth: 1,
    maxNodes: 6,
    includeScreenshot: false,
    includeCSS: false,
    resolveReferences: false,
  });
  assert.equal(childReads, 1);
  assert.equal(context.nodes[0].childCount, children.length);
  assert.equal(context.nodes[0].children.length, 5);
  assert(context.sparse);
});
test('truncated context, unavailable reference and failed preview remain visibly incomplete', async () => {
  const f = graph();
  f.frame.fills = [
    {
      type: 'SOLID',
      boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'missing' } },
    },
  ];
  f.frame.exportAsync = async () => {
    throw new Error('export unavailable');
  };
  const value = await f.queries.context({ nodeId: f.frame.id });
  assert.equal(value.sparse, true);
  assert.equal(value.preview, null);
  assert(value.issues.some((issue) => issue.field === 'variable'));
  assert(value.issues.some((issue) => issue.field === 'preview'));
  f.frame.name = 'x'.repeat(9000);
  // Native names remain identities; actual projected text/arrays carry truncation information.
  f.frame.characters = 'x'.repeat(9000);
  const text = await f.queries.context({
    nodeId: f.frame.id,
    includeScreenshot: false,
  });
  assert.equal(text.nodes[0].characters.length, 8192);
  assert(text.issues.some((issue) => issue.field === 'serialization'));
});
test('local reference resolution uses native file values without cloud-dependent ID lookups', async () => {
  const f = graph();
  f.frame.boundVariables = { color: { type: 'VARIABLE_ALIAS', id: 'alias' } };
  f.figma.variables.getVariableByIdAsync = async () =>
    assert.fail('local variables must not use cloud lookup');
  f.figma.variables.getVariableCollectionByIdAsync = async () =>
    assert.fail('local collections must not use cloud lookup');
  const result = await f.queries.context({
    nodeId: f.frame.id,
    includeScreenshot: false,
  });
  assert.equal(result.sparse, false);
  assert.deepEqual(result.resources.variables.map((v) => v.id).sort(), [
    'alias',
    'color',
  ]);
  assert.equal(result.resources.collections[0].name, 'Theme');
  assert.equal(result.nativeReads.getLocalVariablesAsync.calls, 1);
  assert.equal(result.nativeReads.getVariableByIdAsync, undefined);
});
test('references outside the local index still use exact native lookups', async () => {
  const f = graph(),
    lookups = [];
  f.frame.boundVariables = {
    color: { type: 'VARIABLE_ALIAS', id: 'remote-variable' },
  };
  f.figma.variables.getVariableByIdAsync = async (id) => {
    lookups.push(id);
    return {
      id,
      remote: true,
      variableCollectionId: 'remote-collection',
      valuesByMode: { light: { type: 'VARIABLE_ALIAS', id: 'color' } },
    };
  };
  const result = await f.queries.context({
    nodeId: f.frame.id,
    includeScreenshot: false,
  });
  assert.equal(result.sparse, false);
  assert.deepEqual(lookups, ['remote-variable']);
  assert.equal(
    result.resources.variables.find((v) => v.id === 'remote-variable').remote,
    true,
  );
  assert(result.resources.variables.some((v) => v.id === 'color'));
  assert.equal(result.nativeReads.getVariableByIdAsync.calls, 1);
});
test('asset downloads preserve explicit native settings and deduplicate original bytes across nodes', async () => {
  const f = graph(),
    source = new Uint8Array([137, 80, 78, 71, 0, 255]),
    other = f.add('3:1', 'RECTANGLE', 'Image', {
      fills: [{ type: 'IMAGE', imageHash: 'same' }],
    });
  f.frame.fills = [{ type: 'IMAGE', imageHash: 'same' }];
  f.frame.children.push(other);
  f.frame.exportSettings = [
    { format: 'SVG', svgOutlineText: false, suffix: '-editable' },
  ];
  f.figma.getImageByHash = () => ({ getBytesAsync: async () => source });
  const value = await f.queries.downloadAssets({ nodeId: f.frame.id });
  assert.equal(value.sources.length, 1);
  assert.equal(value.rawImagesTruncated, false);
  assert.deepEqual(f.renderSettings[0], f.frame.exportSettings[0]);
  assert.deepEqual(f.files[1].bytes, source);
  assert.equal(value.nativeReads.exportAsync.calls, 1);
  assert.equal(value.nativeReads.getBytesAsync.calls, 1);
  assert.equal(value.nativeReads.getBytesAsync.slowestTarget, 'same');
  f.figma.getImageByHash = () => ({
    getBytesAsync: async () => {
      throw new Error('native source unavailable');
    },
  });
  await assert.rejects(
    f.queries.downloadAssets({ nodeId: f.frame.id, includeRender: false }),
    (error) =>
      error.message === 'native source unavailable' &&
      error.queryDiagnostics.nativeReads.getBytesAsync.calls === 1 &&
      error.queryDiagnostics.nativeReads.getBytesAsync.slowestTarget === 'same',
  );
  delete f.frame.exportSettings;
  await f.queries.downloadAssets({ nodeId: f.frame.id, includeRaw: false });
  assert.equal(f.renderSettings[1].constraint.value, 4096 / 8000);
});
test('explicit render overrides native settings and vector subtrees export without boolean-child duplication', async () => {
  const f = graph(),
    boolean = f.add('4:1', 'BOOLEAN_OPERATION', 'Union', {
      parent: f.frame,
      children: [],
      exportAsync: async () => new Uint8Array([60, 115, 118, 103]),
    });
  const path = f.add('4:2', 'VECTOR', 'Path', {
    parent: boolean,
    exportAsync: async () => {
      throw new Error('should not export separately');
    },
  });
  boolean.children.push(path);
  f.frame.children.push(boolean);
  f.frame.exportSettings = [{ format: 'SVG' }];
  const result = await f.queries.downloadAssets({
    nodeId: f.frame.id,
    format: 'PNG',
    scale: 0.1,
    includeRaw: false,
  });
  assert.equal(f.renderSettings[0].format, 'PNG');
  assert.equal(f.renderSettings[0].constraint.value, 0.1);
  assert.equal(result.vectorAssets.length, 1);
  assert.equal(result.vectorAssets[0].nodeId, boolean.id);
  assert.equal(result.vectorsTruncated, false);
  assert.equal(result.nativeReads.exportAsync.calls, 2);
});
test('design-system search discloses unavailable enabled libraries and constrains cursor continuation', async () => {
  const f = graph();
  f.figma.teamLibrary = {
    getAvailableLibraryVariableCollectionsAsync: async () => {
      throw new Error('not enabled');
    },
  };
  const value = await f.queries.designSystem({
    rootId: f.frame.id,
    includeLibraries: true,
    queries: [
      { entity: 'variable', query: 'action' },
      { entity: 'style', query: 'Body' },
    ],
  });
  assert.equal(value.results[0].items[0].id, 'alias');
  assert.equal(value.results[1].items[0].id, 'style');
  assert.match(value.scope, /enabled variable libraries/);
  assert.match(value.issues[0].error, /not enabled/);
  assert.equal(value.nativeReads.getLocalVariablesAsync.calls, 1);
  assert.equal(value.nativeReads.getLocalTextStylesAsync.calls, 1);
  assert.equal(
    value.nativeReads.getAvailableLibraryVariableCollectionsAsync.calls,
    1,
  );
  await assert.rejects(
    f.queries.designSystem({
      cursor: '{}',
      queries: [{ entity: 'style', query: '' }],
    }),
    /original component query/,
  );
});
test('motion projects loaded handles without resolving instance sublayers or component metadata', async () => {
  const f = graph();
  const child = f.add('I3:1;4:1', 'TEXT', 'Instance text', {
    manualKeyframeTracks: { OPACITY: { keyframes: [{ timelinePosition: 0 }] } },
  });
  const instance = f.add('3:1', 'INSTANCE', 'Button', {
    children: [child],
    getMainComponentAsync: async () =>
      assert.fail('unrequested component metadata'),
  });
  f.frame.children.push(instance);
  const resolved = [];
  f.figma.getNodeByIdAsync = async (id) => {
    resolved.push(id);
    assert.equal(id, f.frame.id, 'only the root requires ID resolution');
    return f.frame;
  };
  f.figma.motion = { figmaAnimationStyles: () => [] };
  const result = await f.queries.motion({ nodeId: f.frame.id });
  assert.deepEqual(resolved, [f.frame.id]);
  assert.deepEqual(
    result.nodes.map((node) => node.id),
    [child.id],
  );
  assert.deepEqual(
    result.nodes[0].manualKeyframeTracks,
    child.manualKeyframeTracks,
  );
  assert.equal(result.sparse, false);
});
test('motion reads actual typed tracks and checks video frame/fps requirements before export', async () => {
  const f = graph();
  f.frame.manualKeyframeTracks = [
    {
      property: 'opacity',
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
    },
  ];
  f.figma.motion = {
    figmaAnimationStyles: () => [{ id: 'native', name: 'Fade' }],
  };
  const value = await f.queries.motion({ nodeId: f.frame.id });
  assert.deepEqual(
    value.nodes[0].manualKeyframeTracks,
    f.frame.manualKeyframeTracks,
  );
  await assert.rejects(
    f.queries.exportNode({ nodeId: f.frame.id, format: 'MP4', fps: 8 }),
    /fps/,
  );
  await f.queries.exportNode({
    nodeId: f.frame.id,
    format: 'MP4',
    fps: 24,
    maxDimension: 640,
  });
  assert.deepEqual(f.renderSettings[0], {
    format: 'MP4',
    fps: 24,
    constraint: { type: 'WIDTH', value: 640 },
    quality: 'MEDIUM',
  });
  f.frame.parent = { type: 'FRAME' };
  await assert.rejects(
    f.queries.exportNode({ nodeId: f.frame.id, format: 'MP4' }),
    /top-level/,
  );
});
test('asset imports preflight editor capability and never create nodes for unsupported FigJam image APIs', async () => {
  const f = graph();
  f.figma.editorType = 'figjam';
  f.bridge.assets = { 'image.png': new Uint8Array([1]) };
  await assert.rejects(
    f.queries.importAssets({ assetNames: ['image.png'] }),
    /not available in this editor/,
  );
  assert.equal(f.first.children.length, 1);
  f.figma.editorType = 'slides';
  await assert.rejects(
    f.queries.importAssets({ assetNames: ['image.png'] }),
    /destination slide/,
  );
});
test('lightweight node inspection returns native bounds and parents without reading vector paths, CSS or renders', async () => {
  const f = graph();
  for (const key of ['vectorPaths', 'fills', 'getCSSAsync', 'exportAsync'])
    Object.defineProperty(f.frame, key, {
      get() {
        throw new Error('heavy read ' + key);
      },
    });
  const value = await f.queries.inspect({ nodeIds: [f.frame.id, f.second.id] });
  assert.deepEqual(value.nodes, [
    {
      id: f.frame.id,
      type: 'FRAME',
      name: 'Panel',
      width: 8000,
      height: 2000,
      parent: { id: f.first.id, type: 'PAGE', name: 'First' },
    },
    { id: f.second.id, type: 'PAGE', name: 'Second', parent: null },
  ]);
  assert.equal(f.loads.length, 0);
  assert.equal(f.files.length, 0);
  assert.equal(f.figma.currentPage, f.first);
  assert.deepEqual(f.first.selection, []);
});
test('asset receipts map each SVG and raster to actual bounds with explicit and intrinsic aspect-ratio sizing', async () => {
  const f = fixture(),
    createSvg = f.figma.createNodeFromSvg;
  f.figma.createNodeFromSvg = () => {
    const node = createSvg();
    node.resize(20, 21);
    return node;
  };
  f.figma.createImage = () => ({
    hash: 'native-image-hash',
    getSizeAsync: async () => ({ width: 80, height: 40 }),
  });
  const assets = {
    'arrow.svg': new Uint8Array(Buffer.from('<svg/>')),
    'image.png': new Uint8Array([1]),
  };
  for (const [args, svgSize, imageSize] of [
    [{}, [20, 21], [80, 40]],
    [{ width: 16, height: 16 }, [16, 16], [16, 16]],
    [{ width: 40 }, [40, 42], [40, 20]],
    [{ height: 42 }, [40, 42], [84, 42]],
  ]) {
    const receipt = await f.api.executeScript(
      "return await bridge.query('importAssets',args);",
      { ...args, assetNames: Object.keys(assets) },
      assets,
      { commitUndo: false },
    );
    const value = JSON.parse(JSON.stringify(receipt.value));
    assert.deepEqual(
      value.assets.map((asset) => [asset.width, asset.height]),
      [svgSize, imageSize],
    );
    assert.deepEqual(
      value.assets.map((asset) => asset.assetName),
      Object.keys(assets),
    );
    for (const asset of value.assets) {
      const node = await f.figma.getNodeByIdAsync(asset.nodeId);
      assert.equal(node.name, asset.assetName);
      assert.equal(node.parent, f.initial);
      assert.equal(asset.type, node.type);
      assert.equal(asset.action, 'created');
    }
    assert.equal(value.assets[1].imageHash, 'native-image-hash');
    assert.equal(receipt.logs.length, 2);
  }
  const node = f.figma.createRectangle();
  node.resize(123, 45);
  node.x = 17;
  node.y = 19;
  const replaced = await f.api.executeScript(
    "return await bridge.query('importAssets',args);",
    { assetNames: ['image.png'], nodeId: node.id },
    assets,
    { commitUndo: false },
  );
  assert.deepEqual(
    [
      replaced.value.assets[0].width,
      replaced.value.assets[0].height,
      node.x,
      node.y,
    ],
    [123, 45, 17, 19],
  );
  assert.equal(replaced.value.assets[0].action, 'image_fill_replaced');
  const before = f.calls.creates;
  await assert.rejects(
    f.api.executeScript(
      "return await bridge.query('importAssets',args);",
      { assetNames: ['image.png'], nodeId: node.id, width: 16 },
      assets,
    ),
    /preserves node/,
  );
  assert.equal(f.calls.creates, before);
  assert.equal(f.calls.commits, 0);
  assert.deepEqual(f.initial.selection, []);
  assert.equal(f.calls.switches, 0);
});
test('asset import failure preserves the created ID before a later native resize rejects', async () => {
  const f = fixture(),
    create = f.figma.createNodeFromSvg;
  f.figma.createNodeFromSvg = () => {
    const node = create();
    node.resize = () => {
      throw new Error('native resize rejected');
    };
    return node;
  };
  await assert.rejects(
    f.api.executeScript(
      "return await bridge.query('importAssets',args);",
      { assetNames: ['arrow.svg'], width: 16, height: 16 },
      { 'arrow.svg': new Uint8Array(Buffer.from('<svg/>')) },
    ),
    (error) => {
      assert.equal(error.outcomeUnknown, true);
      const log = JSON.parse(error.receipt.logs[0].message);
      assert.equal(log.assetName, 'arrow.svg');
      assert.equal(log.action, 'created');
      assert(f.nodes.some((node) => node.id === log.nodeId && !node.removed));
      return /native resize rejected/.test(error.message);
    },
  );
  assert.equal(f.calls.commits, 0);
});
test('runtime helper loads every mixed font, decodes UTF-8 and resizes before sizing-mode assignment', async () => {
  const f = fixture(),
    order = [];
  f.figma.mixed = Symbol('mixed');
  f.figma.currentPage.selection = [
    {
      type: 'TEXT',
      characters: 'Text',
      fontName: f.figma.mixed,
      getStyledTextSegments: () => [{ fontName: f.figma.mixed }],
      getRangeAllFontNames: () => [
        { family: 'Inter', style: 'Regular' },
        { family: 'Inter', style: 'Bold', variationSettings: { wght: 700 } },
        { family: 'Inter', style: 'Regular' },
      ],
    },
  ];
  f.figma.createFrame = () => ({
    type: 'FRAME',
    width: 100,
    height: 100,
    resize(w, h) {
      order.push('resize');
      this.width = w;
      this.height = h;
    },
    set layoutMode(v) {
      order.push('layout:' + v);
    },
    set layoutSizingHorizontal(v) {
      order.push('sizing:' + v);
    },
  });
  const result = await f.api.executeScript(
    'await bridge.loadFonts(figma.currentPage.selection[0]); const n=bridge.autoLayout("VERTICAL",{width:240,height:80,layoutSizingHorizontal:"HUG"}); return {text:bridge.assetText("vector.svg"),width:n.width,revision:bridge.documentRevision};',
    {},
    { 'vector.svg': new Uint8Array(Buffer.from('<svg>中文</svg>')) },
    { documentRevision: 17 },
  );
  assert.equal(f.calls.fonts.length, 2);
  assert.equal(result.value.text, '<svg>中文</svg>');
  assert.equal(result.value.revision, 17);
  assert.deepEqual(order, ['layout:VERTICAL', 'resize', 'sizing:HUG']);
});
test('capability report reflects the live editor, rather than treating cloud tools as native entitlements', async () => {
  const f = graph();
  f.figma.listAvailableShaders = async () => [];
  f.figma.motion = { figmaAnimationStyles: () => [{ id: 'fade' }] };
  const value = await f.queries.capabilities();
  assert.equal(value.api.createSticky, false);
  assert.deepEqual(value.shaderLibrary, []);
  assert.equal(value.localMonthlyQuota, null);
  assert.match(value.note, /not proof of plan entitlement/);
});
test('capability checks use the exact node or remain unknown, and can query additional native methods', async () => {
  const f = graph();
  f.frame.applyManualKeyframeTrack = () => {};
  const methods = [
    'node.applyManualKeyframeTrack',
    'figma.variables.getLocalVariablesAsync',
  ];
  const unknown = await f.queries.capabilities({ methods });
  assert.equal(unknown.api['node.applyManualKeyframeTrack'], null);
  assert.equal(unknown.targetNode, null);
  const explicit = await f.queries.capabilities({
    nodeId: f.frame.id,
    methods,
  });
  assert.equal(explicit.targetNode.id, f.frame.id);
  assert.equal(explicit.api['node.applyManualKeyframeTrack'], true);
  assert.equal(explicit.api['variables.getLocalVariablesAsync'], true);
  f.first.selection = [f.frame];
  assert.equal(
    (await f.queries.capabilities({ methods })).targetNode.id,
    f.frame.id,
  );
});
test('targeted capability checks do not enumerate unrelated motion or shader libraries', async () => {
  const f = graph();
  f.figma.motion = {
    figmaAnimationStyles: () => assert.fail('unrequested motion enumeration'),
  };
  f.figma.listAvailableShaders = () =>
    assert.fail('unrequested shader enumeration');
  const result = await f.queries.capabilities({
    methods: ['figma.getNodeByIdAsync'],
  });
  assert.deepEqual(result.api, { getNodeByIdAsync: true });
  assert.equal(result.motionStyles, null);
  assert.equal(result.shaderLibrary, null);
});
test('SVG exports respect explicit text/ID options and otherwise leave native settings intact', async () => {
  const f = graph();
  await f.queries.exportNode({ nodeId: f.frame.id, format: 'SVG' });
  assert.deepEqual(f.renderSettings[0], { format: 'SVG' });
  await f.queries.exportNode({
    nodeId: f.frame.id,
    format: 'SVG',
    svgOutlineText: false,
    svgIdAttribute: true,
  });
  assert.deepEqual(f.renderSettings[1], {
    format: 'SVG',
    svgOutlineText: false,
    svgIdAttribute: true,
  });
  f.frame.exportSettings = [{ format: 'SVG', svgOutlineText: true }];
  await f.queries.downloadAssets({
    nodeId: f.frame.id,
    includeRaw: false,
    includeVectors: false,
    svgOutlineText: false,
  });
  assert.equal(f.renderSettings[2].svgOutlineText, false);
  assert.equal(f.frame.exportSettings[0].svgOutlineText, true);
});
test('raster replacement preserves other paints and crop, and rejects ambiguity before native changes', async () => {
  const f = fixture();
  f.figma.createImage = () => ({ hash: 'new-image' });
  const node = f.figma.createRectangle(),
    solid = { type: 'SOLID', color: { r: 1, g: 0, b: 0 } },
    image = {
      type: 'IMAGE',
      imageHash: 'old',
      scaleMode: 'CROP',
      imageTransform: [
        [1, 0, 0.2],
        [0, 1, 0.3],
      ],
      opacity: 0.7,
    };
  node.fills = [solid, image];
  const args = { nodeId: node.id, assetNames: ['新图.png'] },
    assets = { '新图.png': new Uint8Array([1]) };
  await f.api.executeScript(
    "return await bridge.query('importAssets',args);",
    args,
    assets,
    { commitUndo: false },
  );
  assert.equal(node.fills[0], solid);
  assert.deepEqual(JSON.parse(JSON.stringify(node.fills[1])), {
    ...image,
    imageHash: 'new-image',
  });
  node.fills = [image, { ...image, imageHash: 'second' }];
  await assert.rejects(
    f.api.executeScript(
      "return await bridge.query('importAssets',args);",
      args,
      assets,
      { readOnly: true, commitUndo: false },
    ),
    /Choose fillIndex/,
  );
  assert.deepEqual(node.fills, [image, { ...image, imageHash: 'second' }]);
  await f.api.executeScript(
    "return await bridge.query('importAssets',args);",
    { ...args, fillIndex: 1 },
    assets,
    { commitUndo: false },
  );
  assert.equal(node.fills[0].imageHash, 'old');
  assert.equal(node.fills[1].imageHash, 'new-image');
  await f.api.executeScript(
    "return await bridge.query('importAssets',args);",
    { ...args, replaceAllFills: true, scaleMode: 'FIT' },
    assets,
    { commitUndo: false },
  );
  assert.equal(node.fills.length, 1);
  assert.equal(node.fills[0].scaleMode, 'FIT');
});
test('native read failures preserve method, exact target and timing in the execution receipt', async () => {
  const f = fixture();
  f.figma.getNodeByIdAsync = async () => {
    throw new Error('Unable to establish connection to Figma');
  };
  await assert.rejects(
    f.api.executeScript(
      "return await bridge.query('inspect',args);",
      { nodeId: '1:999' },
      {},
      { readOnly: true, commitUndo: false },
    ),
    (error) => {
      const timing =
        error.receipt.queryDiagnostics.nativeReads.getNodeByIdAsync;
      assert.equal(timing.calls, 1);
      assert.equal(timing.slowestTarget, '1:999');
      assert.match(error.receipt.logs[0].message, /getNodeByIdAsync/);
      return /Unable to establish/.test(error.message);
    },
  );
});
