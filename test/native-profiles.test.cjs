const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {
  widgetCode,
  prepareWidget,
  extraProfilesInstalled,
  installExtraProfiles,
} = require('../src/host/native-profiles.cjs');

test('persistent Widget render definitions execute in Figma, retain state, and survive installation updates', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ysun-widget-'));
  const before = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = directory;
  t.after(() => {
    if (before === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = before;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const modulePath = path.join(directory, 'render.js');
  fs.writeFileSync(
    modulePath,
    "return function(){const [value]=widget.useSyncedState('label','saved');return widget.h(widget.Text,{},value);};",
  );
  const built = require('../scripts/build.cjs').output;
  installExtraProfiles(built);
  const devFiles = ['manifest.json', 'code.js', 'ui.html'].map((f) =>
    path.join(directory, 'dev', f),
  );
  const beforeStats = devFiles.map(
    (f) => fs.statSync(f, { bigint: true }).ctimeNs,
  );
  const result = prepareWidget(
    modulePath,
    require('../scripts/build.cjs').output,
  );
  assert.deepEqual(
    devFiles.map((f) => fs.statSync(f, { bigint: true }).ctimeNs),
    beforeStats,
    'Preparing Widget must not trigger a Dev plugin reload',
  );
  installExtraProfiles(built);
  assert.deepEqual(
    devFiles.map((f) => fs.statSync(f, { bigint: true }).ctimeNs),
    beforeStats,
    'An unchanged install must leave Dev files untouched',
  );
  assert.match(result.definitionSha256, /^[a-f0-9]{64}$/);
  assert(extraProfilesInstalled(require('../scripts/build.cjs').output));
  assert.equal(
    fs.statSync(path.join(directory, 'widget/definition.js')).mode & 0o777,
    0o600,
  );
  const code = fs.readFileSync(path.join(directory, 'widget/code.js'), 'utf8');
  let render;
  const widget = {
    register: (fn) => {
      render = fn;
    },
    useEffect() {},
    useSyncedState: () => ['persisted'],
    h: (component, props, ...children) => ({ component, props, children }),
    Text: 'Text',
  };
  vm.runInNewContext(code, {
    figma: { widget, editorType: 'figma', mode: 'default' },
  });
  assert.deepEqual(Array.from(render().children), ['persisted']);
  assert.throws(
    () =>
      widgetCode(
        'const YSUN_WIDGET_RENDER = null; // YSUN_WIDGET_DEFINITION',
        'return function(',
      ),
    SyntaxError,
  );
  assert.throws(() => widgetCode('wrong base', 'return ()=>null;'), /marker/);
});

test('Widget effects open one bridge and one retained task despite repeated renders', () => {
  let component,
    starts = 0,
    tasks = 0;
  const effects = [];
  const widget = {
    register: (fn) => {
      component = fn;
    },
    useEffect: (fn) => effects.push(fn),
    useSyncedState: (_key, value) => [value, () => {}],
    h: () => ({}),
    waitForTask: () => tasks++,
    AutoLayout: 'AutoLayout',
    Text: 'Text',
  };
  const context = vm.createContext({
    figma: { widget },
    startNativePlugin: () => starts++,
  });
  vm.runInContext(
    fs.readFileSync(
      path.resolve(__dirname, '../src/figma/widget-runtime.js'),
      'utf8',
    ) + '\nstartWidgetPlugin();',
    context,
  );
  component();
  component();
  effects.forEach((fn) => fn());
  assert.equal(starts, 1);
  assert.equal(tasks, 1);
});

test('codegen uses the actual generate callback, remains read-only, and supports concurrent CSS/JSON requests without UI', async () => {
  let handler;
  const context = vm.createContext({
    figma: {
      codegen: {
        on: (event, fn) => {
          assert.equal(event, 'generate');
          handler = fn;
        },
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(
      path.resolve(__dirname, '../src/figma/dev-runtime.js'),
      'utf8',
    ) + '\nstartCodegenPlugin();',
    context,
  );
  const node = {
    id: '1:2',
    name: 'QA',
    type: 'FRAME',
    width: 100,
    height: 50,
    getCSSAsync: async () => ({ display: 'flex', width: '100px' }),
  };
  const [css, json] = await Promise.all([
    handler({ node, language: 'css' }),
    handler({ node, language: 'json' }),
  ]);
  assert.equal(css[0].language, 'CSS');
  assert.match(css[0].code, /display: flex;/);
  assert.equal(JSON.parse(json[0].code).width, 100);
});

test('Widget bridge identity uses widgetId when the public Plugin API omits pluginId', async () => {
  const messages = [];
  const figma = {
    widgetId: '1700202761156255033',
    root: { name: 'QA', getPluginData: () => '' },
    currentPage: { id: '0:1', name: 'Page', selection: [], on() {} },
    ui: { postMessage: (message) => messages.push(message) },
    showUI() {},
    on() {},
  };
  const context = vm.createContext({
    figma,
    __html__: '',
    BRIDGE_RUNTIME_VERSION: 33,
    BRIDGE_PROTOCOL_VERSION: 3,
  });
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/figma/native-runtime.js'),
    'utf8',
  );
  vm.runInContext(
    source.slice(0, source.lastIndexOf("if (typeof figma !== 'undefined')")) +
      String.fromCharCode(10) +
      'startNativePlugin();',
    context,
  );
  await figma.ui.onmessage({ type: 'UI_READY' });
  assert.equal(messages.at(-1).pluginId, '1700202761156255033');
});
