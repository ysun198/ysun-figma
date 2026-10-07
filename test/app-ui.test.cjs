const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const uiSource = require('esbuild').buildSync({
  stdin: {
    contents:
      fs.readFileSync(path.join(__dirname, '../src/app-ui.js'), 'utf8') +
      '\nglobalThis.uiTest = { refresh, render, openFile, applyHostContext, visibleFiles, watch };',
    resolveDir: path.join(__dirname, '../src'),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  external: ['@modelcontextprotocol/ext-apps'],
}).outputFiles[0].text;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const file = (fileKey, extra = {}) => ({
  id: fileKey,
  fileKey,
  name: fileKey,
  url: `https://www.figma.com/design/${fileKey}`,
  connected: false,
  thumbnailUrl: 'https://s3-alpha.figma.com/thumbnails/cover',
  ...extra,
});
const result = (value) => ({ structuredContent: value, content: [] });
function fixture(handle, initialView, initialSort, updateContext) {
  const elements = new Map(),
    calls = [],
    contexts = [],
    messages = [],
    storage = new Map(initialView ? [['ysun-figma-view', initialView]] : []);
  const timers = new Map();
  let timerId = 0;
  if (initialSort)
    storage.set('ysun-figma-list-sort', JSON.stringify(initialSort));
  const attach = (el, connected) => {
    el.isConnected = connected;
    if (!connected && document.activeElement === el)
      document.activeElement = null;
    for (const child of el.children) attach(child, connected);
  };
  function element(localName) {
    return {
      localName,
      dataset: {},
      style: {},
      listeners: {},
      attributes: {},
      children: [],
      hidden: true,
      disabled: false,
      isConnected: false,
      scrollTop: 0,
      value: '',
      naturalWidth: 800,
      naturalHeight: 600,
      async decode() {},
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 640, height: 480 };
      },
      addEventListener(name, fn) {
        this.listeners[name] = fn;
      },
      setPointerCapture(id) {
        this.pointer = id;
      },
      hasPointerCapture(id) {
        return this.pointer === id;
      },
      releasePointerCapture() {
        this.pointer = undefined;
        this.onlostpointercapture();
      },
      removeAttribute(name) {
        delete this[name];
        delete this.attributes[name];
      },
      focus() {
        this.focused = true;
        document.activeElement = this;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      replaceChildren(...children) {
        for (const child of this.children) attach(child, false);
        this.children = children;
        for (const child of children) attach(child, this.isConnected);
      },
      append(...children) {
        this.children.push(...children);
        for (const child of children) attach(child, this.isConnected);
      },
    };
  }
  class App {
    constructor() {
      fixture.app = this;
    }
    async connect() {}
    async readServerResource(params) {
      assert.equal(params.uri, 'ui://figma-plugin/files');
      return this.resource;
    }
    async close() {
      this.closed = true;
    }
    getHostContext() {
      return {};
    }
    getHostCapabilities() {
      return { updateModelContext: true };
    }
    addEventListener() {}
    async updateModelContext(v) {
      contexts.push(v.structuredContent);
      if (updateContext) return updateContext(v);
    }
    async sendMessage(v) {
      messages.push(v);
      return {};
    }
    async callServerTool(v) {
      calls.push(v);
      return handle(v);
    }
  }
  const styles = new Map();
  const document = {
    open() {
      this.opened = true;
    },
    write(html) {
      this.written = html;
    },
    close() {
      this.closed = true;
    },
    listeners: {},
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
    documentElement: {
      style: { setProperty: (key, value) => styles.set(key, value) },
    },
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) {
        const el = element();
        el.isConnected = true;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement: element,
  };
  document.getElementById('notice');
  const ctx = vm.createContext({
    APP_VERSION: 'test',
    require(name) {
      assert.equal(name, '@modelcontextprotocol/ext-apps');
      return { App, applyDocumentTheme() {}, applyHostStyleVariables() {} };
    },
    document,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle() {
      return { paddingLeft: '16px' };
    },
    setInterval() {},
    setTimeout(fn, ms) {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
  });
  vm.runInContext(uiSource, ctx);
  return {
    ctx: ctx.uiTest,
    app: fixture.app,
    elements,
    calls,
    contexts,
    messages,
    storage,
    timers,
    styles,
    document,
    cards: () => elements.get('gallery').children,
    image: () => elements.get('canvas-image'),
  };
}
test('catalog recovery reports facts without impersonating a user or starting an agent task', async () => {
  const f = fixture(async () =>
    result({
      files: [],
      catalog: {
        status: 'login_required',
        browserSpace: 12,
        error: 'login_required',
      },
    }),
  );
  await tick();
  await f.ctx.refresh();
  assert.equal(f.messages.length, 0);
  assert.equal(f.contexts.at(-1).catalog.status, 'login_required');
});
test('an already open workbench requests the current HTML and reconnects without a user reload', async () => {
  const f = fixture(async () => result({ files: [file('FileAlpha')] }));
  await tick();
  f.elements.get('search').value = 'alpha';
  f.elements.get('search').oninput();
  f.app.resource = {
    contents: [
      {
        uri: 'ui://figma-plugin/files',
        text: '<!doctype html><title>new workbench</title>',
      },
    ],
  };
  f.ctx.render({ version: '1.1.0', files: [file('FileAlpha')] });
  await tick();
  assert(f.app.closed);
  assert(f.document.opened && f.document.closed);
  assert.match(f.document.written, /new workbench/);
  assert.equal(f.ctx.visibleFiles().length, 1);
  assert.equal(f.calls.length, 1, 'updating UI never submits a native edit');
});
test('a failed context delivery retries the unchanged context on the next poll', async () => {
  let attempts = 0;
  const f = fixture(
    async () =>
      result({ files: [file('CloudFile1')], catalog: { status: 'ready' } }),
    undefined,
    undefined,
    async () => {
      if (++attempts === 1) throw new Error('host unavailable');
    },
  );
  await tick();
  await f.ctx.refresh();
  await tick();
  assert.equal(attempts, 2);
  await f.ctx.refresh();
  await tick();
  assert.equal(attempts, 2);
});
test('file changes during context delivery send the latest context after the host acknowledges', async () => {
  let release;
  const f = fixture(
    async () => result({ files: [file('CloudFile1'), file('CloudFile2')] }),
    undefined,
    undefined,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  f.ctx.openFile('CloudFile2');
  release();
  await tick();
  assert.equal(f.contexts.at(-1).fileKey, 'CloudFile2');
  release();
  await tick();
});
test('host safe areas follow composer changes and reset on return without losing insets on a theme-only notification', async () => {
  const f = fixture(async () => result({ files: [] }));
  await tick();
  f.ctx.applyHostContext({
    safeAreaInsets: { top: 48, right: 0, bottom: 180, left: 0 },
  });
  assert.equal(f.styles.get('--safe-area-bottom'), '180px');
  f.ctx.applyHostContext({ theme: 'dark' });
  assert.equal(f.styles.get('--safe-area-top'), '48px');
  assert.equal(f.styles.get('--safe-area-bottom'), '180px');
  f.ctx.applyHostContext({
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  assert.equal(f.styles.get('--safe-area-top'), '0px');
  assert.equal(f.styles.get('--safe-area-bottom'), '0px');
});
test('all account covers load directly without native screenshot jobs; unchanged poll retains cards', async () => {
  const files = [file('CloudFile1'), file('CloudFile2')];
  const f = fixture(async () =>
    result({ files, catalog: { status: 'ready', accountId: '123' } }),
  );
  await tick();
  assert.equal(f.cards().length, 2);
  assert.equal(f.cards()[0].children[0].children[0].src, files[0].thumbnailUrl);
  const card = f.cards()[0];
  await f.ctx.refresh();
  assert.equal(f.cards()[0], card);
  assert(f.calls.every((call) => call.name === 'figma_open'));
});
test('name search ignores case and surrounding whitespace; clearing restores files and focus', async () => {
  const f = fixture(async () =>
    result({
      files: [
        file('CloudFile1', { name: 'iOS Kit' }),
        file('CloudFile2', { name: 'Mac Kit' }),
      ],
      catalog: { status: 'ready' },
    }),
  );
  await tick();
  const search = f.elements.get('search');
  search.value = ' IOS ';
  search.oninput();
  assert.equal(f.cards().length, 1);
  assert.equal(f.cards()[0].dataset.fileId, 'CloudFile1');
  search.value = 'no result';
  search.oninput();
  assert.equal(f.cards().length, 0);
  assert.equal(f.elements.get('empty-text').textContent, '没有匹配的项目');
  assert.equal(f.elements.get('connect').hidden, true);
  f.elements.get('clear-search').onclick();
  assert.equal(f.cards().length, 2);
  assert.equal(search.value, '');
  assert.equal(search.focused, true);
  assert.equal(f.calls.length, 1);
});
test('only cards and list modes persist as a presentation preference without new reads or file storage', async () => {
  const f = fixture(
    async () => result({ files: [file('CloudFile1')] }),
    'list',
  );
  await tick();
  assert.equal(f.elements.get('gallery').dataset.view, 'list');
  assert.equal(f.elements.get('view-list').attributes['aria-pressed'], 'true');
  f.elements.get('view-cards').onclick();
  assert.equal(f.elements.get('gallery').dataset.view, 'cards');
  assert.equal(f.storage.get('ysun-figma-view'), 'cards');
  assert.equal(f.storage.size, 1);
  assert.equal(f.calls.length, 1);
});
const connected = (key, revision = 1, extra = {}) =>
  file(key, {
    connected: true,
    clientId: key + '-client',
    sessions: [
      {
        clientId: key + '-client',
        instanceId: key + '-instance',
        pageId: '0:1',
        pageName: 'Page 1',
        documentRevision: revision,
      },
    ],
    ...extra,
  });
const cursor = (n) => 'sha256:' + String(n).padStart(64, '0');
function canvasResult(args, extra = {}) {
  return {
    structuredContent: {
      job: {
        id: 'preview-read',
        status: 'succeeded',
        result: {
          value: {
            page: { id: args.pageId, name: 'Page' },
            pages: [
              { id: '0:1', name: 'Page 1' },
              { id: '0:2', name: 'Page 2' },
            ],
            scale: 1,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            revision: 1,
            ...extra,
          },
        },
      },
    },
    content: [
      {
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from(args.fileKey || 'canvas').toString('base64'),
      },
    ],
  };
}
test('unconnected file opens the exact Desktop file and waits for native connection without web login', async () => {
  const f = fixture(async ({ name }) =>
    name === 'figma_open'
      ? result({ files: [file('CloudFile1')], catalog: { status: 'ready' } })
      : result({ state: 'connection_required' }),
  );
  await tick();
  f.cards()[0].onclick();
  await tick();
  assert.equal(f.calls.at(-1).name, 'figma_file');
  assert.equal(f.calls.at(-1).arguments.action, 'open');
  assert.equal(f.calls.at(-1).arguments.fileKey, 'CloudFile1');
  assert.equal(
    f.elements.get('canvas-status-text').textContent,
    '等待 Figma 桌面端连接',
  );
  assert.equal(f.image().src, undefined);
  assert.equal(f.messages.length, 0);
  assert.equal(f.elements.get('workspace').hidden, true);
  assert.equal(f.contexts.at(-1).fileKey, 'CloudFile1');
});
test('a late Desktop open snapshot cannot undo a newer live native connection', async () => {
  let release;
  const f = fixture(async ({ name, arguments: args }) => {
    if (name === 'figma_canvas') return canvasResult(args);
    if (name === 'figma_file')
      return new Promise((resolve) => {
        release = resolve;
      });
    return result({ files: [file('CloudFile1')] });
  });
  await tick();
  f.ctx.openFile('CloudFile1');
  f.ctx.render({ files: [connected('CloudFile1')] });
  await tick();
  release(result({ files: [file('CloudFile1')] }));
  await tick();
  assert.equal(f.image().hidden, false);
  assert.equal(f.contexts.at(-1).connected, true);
});
test('exact native preview follows revisions, preserves pan/zoom and reports preview page separately from native selection', async () => {
  let revision = 1;
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({ files: [connected('CloudFile1', revision)] })
      : canvasResult(args, { revision }),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  assert.equal(f.calls.at(-1).name, 'figma_canvas');
  assert.equal(f.calls.at(-1).arguments.clientId, 'CloudFile1-client');
  assert.equal(f.calls.at(-1).arguments.fileKey, 'CloudFile1');
  assert.equal(f.image().hidden, false);
  const viewport = f.elements.get('canvas-viewport');
  viewport.listeners.wheel({
    deltaMode: 0,
    deltaX: 20,
    deltaY: -10,
    preventDefault() {},
  });
  f.elements.get('canvas-plus').onclick();
  const transform = f.image().style.transform;
  await f.ctx.refresh();
  await tick();
  assert.equal(f.calls.filter((c) => c.name === 'figma_canvas').length, 1);
  revision++;
  await f.ctx.refresh();
  await tick();
  assert.equal(f.calls.filter((c) => c.name === 'figma_canvas').length, 2);
  assert.equal(f.image().style.transform, transform);
  assert.equal(f.contexts.at(-1).pageId, '0:1');
  assert.equal(f.contexts.at(-1).nodeId, null);
  assert.equal(f.contexts.at(-1).preview.revision, revision);
  assert.equal(f.storage.size, 0);
});
test('a native revision event refreshes the open canvas without a periodic file poll or an agent message', async () => {
  const f = fixture(async ({ name, arguments: args }) => {
    if (name === 'figma_canvas') return canvasResult(args, { revision: 2 });
    if (name === 'figma_watch') {
      assert.equal(args.cursor, cursor(1));
      return result({ files: [connected('CloudFile1', 2)], cursor: cursor(2) });
    }
    return result({ files: [connected('CloudFile1')], cursor: cursor(1) });
  });
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  await f.ctx.watch();
  await tick();
  assert.equal(f.calls.filter((c) => c.name === 'figma_open').length, 1);
  assert.equal(f.calls.filter((c) => c.name === 'figma_canvas').length, 2);
  assert.equal(f.contexts.at(-1).preview.revision, 2);
  assert.equal(f.messages.length, 0);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, 0);
});
test('a late watch cannot restore a previous account after a newer host snapshot', async () => {
  let release;
  const f = fixture(async ({ name }) =>
    name === 'figma_watch'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : result({
          files: [file('CloudFile1')],
          catalog: { accountId: 'a' },
          cursor: cursor(1),
        }),
  );
  await tick();
  const pending = f.ctx.watch();
  f.ctx.render({
    files: [file('CloudFile2')],
    catalog: { accountId: 'b' },
    cursor: cursor(2),
  });
  release(
    result({
      files: [file('CloudFile1')],
      catalog: { accountId: 'a' },
      cursor: cursor(1),
    }),
  );
  await pending;
  assert.equal(f.cards()[0].dataset.fileId, 'CloudFile2');
  assert.equal(f.contexts.at(-1).accountId, 'b');
});
test('hidden workbenches stop watching; a reply while hidden is discarded and visibility resumes the same cursor', async () => {
  let release;
  const f = fixture(async ({ name, arguments: args }) => {
    if (name === 'figma_watch') {
      assert.equal(args.cursor, cursor(1));
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return result({ files: [file('CloudFile1')], cursor: cursor(1) });
  });
  await tick();
  const pending = f.ctx.watch();
  f.document.visibilityState = 'hidden';
  f.document.listeners.visibilitychange();
  release(result({ files: [file('CloudFile2')], cursor: cursor(2) }));
  await pending;
  assert.equal(f.cards()[0].dataset.fileId, 'CloudFile1');
  assert.equal(f.timers.size, 0);
  await f.ctx.watch();
  assert.equal(f.calls.filter((c) => c.name === 'figma_watch').length, 1);
  f.document.visibilityState = 'visible';
  f.document.listeners.visibilitychange();
  assert.equal([...f.timers.values()][0].ms, 0);
});
test('writes retain the current image without competing reads, then the terminal receipt refreshes the same view', async () => {
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({ files: [connected('CloudFile1')] })
      : canvasResult(args),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  const previousImage = f.image().src;
  f.elements.get('canvas-plus').onclick();
  const previousTransform = f.image().style.transform;
  const busy = connected('CloudFile1', 2);
  busy.sessions[0].writing = true;
  f.ctx.render({ files: [busy] });
  await tick();
  assert.equal(f.calls.filter((c) => c.name === 'figma_canvas').length, 1);
  assert.equal(f.image().src, previousImage);
  assert.equal(f.image().hidden, false);
  assert.equal(f.elements.get('viewer').attributes['aria-busy'], 'true');
  f.ctx.render({ files: [connected('CloudFile1', 3)] });
  await tick();
  assert.equal(f.calls.filter((c) => c.name === 'figma_canvas').length, 2);
  assert.equal(f.image().style.transform, previousTransform);
  assert.equal(f.elements.get('viewer').attributes['aria-busy'], 'false');
});
test('native bounds changes preserve the world position after manual pan and zoom', async () => {
  let bounds = { x: 100, y: 200, width: 800, height: 600 };
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({ files: [connected('CloudFile1')] })
      : canvasResult(args, { bounds }),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  f.elements.get('canvas-plus').onclick();
  const transform = () =>
    f
      .image()
      .style.transform.match(
        /translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/,
      )
      .slice(1)
      .map(Number);
  const [x, y, scale] = transform();
  bounds = { ...bounds, x: -100, y: -50 };
  f.ctx.render({ files: [connected('CloudFile1', 2)] });
  await tick();
  const [nextX, nextY, nextScale] = transform();
  assert.equal(nextScale, scale);
  assert(Math.abs(nextX - bounds.x * scale - (x - 100 * scale)) < 1e-8);
  assert(Math.abs(nextY - bounds.y * scale - (y - 200 * scale)) < 1e-8);
});
test('switching a page during a write immediately sends its exact target, rejects the old read and renders after completion', async () => {
  let release;
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({ files: [connected('CloudFile1')] })
      : new Promise((resolve) => {
          release = () => resolve(canvasResult(args));
        }),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  release();
  await tick();
  f.ctx.render({ files: [connected('CloudFile1', 2)] });
  const busy = connected('CloudFile1', 3);
  busy.sessions[0].writing = true;
  f.ctx.render({ files: [busy] });
  const page = f.elements.get('canvas-page');
  page.value = '0:2';
  page.onchange();
  release();
  await tick();
  assert.equal(f.image().src, undefined);
  assert.equal(f.contexts.at(-1).pageId, '0:2');
  assert.equal(f.contexts.at(-1).preview, null);
  f.ctx.render({ files: [connected('CloudFile1', 4)] });
  release();
  await tick();
  assert.equal(f.calls.at(-1).arguments.pageId, '0:2');
  assert.equal(f.contexts.at(-1).pageId, '0:2');
});
test('a failed refresh retains the last rendered image and exact page context; retry follows the same viewport', async () => {
  let fail = false;
  const f = fixture(async ({ name, arguments: args }) => {
    if (name === 'figma_open')
      return result({ files: [connected('CloudFile1')] });
    if (fail) throw new Error('native export failed');
    return canvasResult(args, { revision: 2 });
  });
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  f.elements.get('canvas-plus').onclick();
  const previous = f.image().src,
    transform = f.image().style.transform;
  fail = true;
  f.ctx.render({ files: [connected('CloudFile1', 2)] });
  await tick();
  assert.equal(f.image().hidden, false);
  assert.equal(f.image().src, previous);
  assert.equal(f.contexts.at(-1).pageId, '0:1');
  assert.equal(
    f.elements.get('canvas-status-text').textContent,
    'native export failed',
  );
  fail = false;
  f.elements.get('canvas-retry').onclick();
  await tick();
  assert.equal(f.image().style.transform, transform);
  assert.equal(f.elements.get('canvas-status').hidden, true);
});
test('page navigation reads the chosen native page without changing Desktop selection, zoom is anchored to the pointer', async () => {
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({ files: [connected('CloudFile1')] })
      : canvasResult(args),
  );
  await tick();
  const page = f.elements.get('canvas-page'),
    trigger = f.document.createElement('button');
  page.append(trigger);
  f.ctx.openFile('CloudFile1');
  await tick();
  assert.equal(page.children[0], trigger);
  const viewport = f.elements.get('canvas-viewport');
  viewport.listeners.wheel({
    ctrlKey: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY: -100,
    clientX: 100,
    clientY: 120,
    preventDefault() {},
  });
  const transform = f.image().style.transform;
  assert.notEqual(transform, '');
  page.value = '0:2';
  page.onchange();
  await tick();
  assert.equal(page.children[0], trigger);
  assert.equal(
    page.children.filter((child) => child.localName === 'button').length,
    1,
  );
  assert.equal(f.calls.at(-1).arguments.pageId, '0:2');
  assert.equal(f.contexts.at(-1).pageId, '0:2');
  assert(f.calls.every((c) => ['figma_open', 'figma_canvas'].includes(c.name)));
  assert.equal(f.messages.length, 0);
});
test('a late preview cannot overwrite another file, back or an account switch with the same file key', async () => {
  let release;
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({
          files: [connected('CloudFile1'), connected('CloudFile2')],
          catalog: { accountId: 'a' },
        })
      : new Promise((resolve) => {
          release = () => resolve(canvasResult(args));
        }),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  f.ctx.openFile('CloudFile2');
  release();
  await tick();
  assert.equal(f.image().src, undefined);
  assert.equal(f.calls.at(-1).arguments.fileKey, 'CloudFile2');
  release();
  await tick();
  assert.equal(
    f.image().src,
    'data:image/png;base64,' + Buffer.from('CloudFile2').toString('base64'),
  );
  assert.equal(f.contexts.at(-1).fileKey, 'CloudFile2');
  f.ctx.render({
    files: [connected('CloudFile2')],
    catalog: { accountId: 'b' },
  });
  await tick();
  assert.equal(f.image().src, undefined);
  assert.equal(f.contexts.at(-1).accountId, 'b');
  assert.equal(f.contexts.at(-1).pageId, null);
  f.ctx.openFile('CloudFile2');
  f.elements.get('back').onclick();
  release();
  await tick();
  assert.equal(f.image().src, undefined);
  assert.equal(f.contexts.at(-1).fileKey, null);
});
test('disconnect clears a live image; reconnect to the same revision reads it again without launching Desktop', async () => {
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({ files: [connected('CloudFile1')] })
      : canvasResult(args),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  f.ctx.render({ files: [file('CloudFile1')] });
  await tick();
  assert.equal(f.image().src, undefined);
  assert.equal(f.contexts.at(-1).pageId, null);
  f.ctx.render({ files: [connected('CloudFile1')] });
  await tick();
  assert.equal(f.image().hidden, false);
  assert.equal(f.calls.filter((c) => c.name === 'figma_canvas').length, 2);
  assert(f.calls.every((c) => c.name !== 'figma_file'));
});
test('ambiguous sessions require explicit selection and never choose the first native instance', async () => {
  const a = connected('CloudFile1').sessions[0],
    b = { ...a, clientId: 'other-client', instanceId: 'other-instance' };
  const f = fixture(async ({ name, arguments: args }) =>
    name === 'figma_open'
      ? result({
          files: [
            connected('CloudFile1', 1, { clientId: null, sessions: [a, b] }),
          ],
        })
      : canvasResult(args),
  );
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.elements.get('canvas-session').hidden, false);
  f.elements.get('canvas-session').value = b.clientId;
  f.elements.get('canvas-session').onchange();
  await tick();
  assert.equal(f.calls.at(-1).arguments.clientId, b.clientId);
  assert.equal(f.contexts.at(-1).clientId, b.clientId);
});
test('nonterminal canvas follows the original job; oversized previews reduce resolution only after success', async () => {
  let jobReads = 0;
  const f = fixture(async ({ name, arguments: args }) => {
    if (name === 'figma_open')
      return result({ files: [connected('CloudFile1')] });
    if (name === 'figma_canvas' && args.maxDimension === 2048)
      return result({ job: { id: 'original-preview', status: 'queued' } });
    if (name === 'figma_job') {
      jobReads++;
      assert.equal(args.operationId, 'original-preview');
      if (jobReads === 1)
        return result({ job: { id: 'original-preview', status: 'running' } });
      const response = canvasResult({ pageId: '0:1' });
      response.content = [];
      response.structuredContent.previewHint = 'request a smaller preview';
      return response;
    }
    return canvasResult(args);
  });
  await tick();
  f.ctx.openFile('CloudFile1');
  await tick();
  assert.equal(jobReads, 2);
  assert.deepEqual(
    f.calls
      .filter((c) => c.name === 'figma_canvas')
      .map((c) => c.arguments.maxDimension),
    [2048, 1024],
  );
  assert.equal(f.image().hidden, false);
});
test('desktop button opens the app on the grid and exact file in the canvas, including connected files', async () => {
  let release;
  const f = fixture(async ({ name }) =>
    name === 'figma_open'
      ? result({ files: [file('CloudFile1', { connected: true })] })
      : new Promise((r) => {
          release = r;
        }),
  );
  await tick();
  const desktop = f.elements.get('desktop'),
    first = desktop.onclick();
  await desktop.onclick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).arguments.action, 'launch');
  assert.equal(f.calls.at(-1).arguments.fileKey, undefined);
  assert.equal(desktop.disabled, true);
  release(result({ state: 'opened' }));
  await first;
  assert.equal(desktop.disabled, false);
  f.ctx.openFile('CloudFile1');
  const second = desktop.onclick();
  assert.equal(f.calls.at(-1).arguments.fileKey, 'CloudFile1');
  release(result({ state: 'opened' }));
  await second;
});
test('desktop launch failure is visible and the button is usable again', async () => {
  const f = fixture(async ({ name }) =>
    name === 'figma_open'
      ? result({ files: [file('CloudFile1')] })
      : { isError: true, structuredContent: { message: 'Figma is missing' } },
  );
  await tick();
  await f.elements.get('desktop').onclick();
  assert.equal(f.elements.get('notice-text').textContent, 'Figma is missing');
  assert.equal(f.elements.get('desktop').disabled, false);
});
test('unchanged catalog polls leave action toasts visible until the normal timeout; another attempt can show the error again', async () => {
  const f = fixture(async ({ name }) =>
    name === 'figma_open'
      ? result({ files: [file('CloudFile1')], catalog: { status: 'ready' } })
      : { isError: true, structuredContent: { message: 'Figma is missing' } },
  );
  await tick();
  await f.elements.get('desktop').onclick();
  await f.ctx.refresh();
  assert.equal(f.elements.get('notice').hidden, false);
  assert.equal(f.timers.size, 1);
  const timer = [...f.timers.values()][0];
  assert.equal(timer.ms, 5000);
  timer.fn();
  assert.equal(f.elements.get('notice').hidden, true);
  assert.equal(f.timers.size, 0);
  await f.elements.get('desktop').onclick();
  assert.equal(f.elements.get('notice').hidden, false);
});
test('normal sync and stale incomplete state are silent; a new failed refresh can show one dismissible error', async () => {
  const files = [file('CloudFile1')],
    f = fixture(async () =>
      result({ files, catalog: { status: 'incomplete' } }),
    );
  await tick();
  assert.equal(f.elements.get('notice').hidden, true);
  assert.equal(f.timers.size, 0);
  f.ctx.render({ files, catalog: { status: 'syncing' } });
  assert.equal(f.elements.get('notice').hidden, true);
  f.ctx.render({ files, catalog: { status: 'incomplete' } });
  assert.equal(f.elements.get('notice').hidden, false);
  assert.equal(f.elements.get('retry').hidden, false);
  f.elements.get('dismiss-notice').onclick();
  await f.ctx.refresh();
  assert.equal(f.elements.get('notice').hidden, true);
  assert.equal(f.timers.size, 0);
});
test('region scroll restores independently by view, including after canvas navigation', async () => {
  const f = fixture(async () =>
    result({ files: [file('CloudFile1'), file('CloudFile2')] }),
  );
  await tick();
  const workspace = f.elements.get('workspace');
  workspace.scrollTop = 240;
  workspace.onscroll();
  f.ctx.openFile('CloudFile1');
  f.elements.get('back').onclick();
  assert.equal(workspace.scrollTop, 240);
  f.elements.get('view-list').onclick();
  assert.equal(workspace.scrollTop, 0);
  workspace.scrollTop = 100;
  workspace.onscroll();
  f.elements.get('view-cards').onclick();
  assert.equal(workspace.scrollTop, 240);
});
test('failed transport presents one retry; force sync errors remain visible', async () => {
  const f = fixture(async () => {
    throw new Error('Transport closed');
  });
  await tick();
  assert.equal(f.elements.get('notice-text').textContent, '工具连接已断开');
  assert.equal(f.elements.get('connect').hidden, false);
  await f.elements.get('connect').onclick();
  assert.equal(f.elements.get('notice-text').textContent, '工具连接已断开');
});
test('search, view switches and native revision polling retain loaded covers; account changes discard them', async () => {
  const cloud = file('CloudFile1');
  const f = fixture(async () =>
    result({ files: [cloud], catalog: { accountId: 'a', status: 'ready' } }),
  );
  await tick();
  const card = f.cards()[0];
  f.elements.get('view-list').onclick();
  assert.equal(f.cards()[0], card);
  f.elements.get('search').value = 'Cloud';
  f.elements.get('search').oninput();
  assert.equal(f.cards()[0], card);
  f.elements.get('workspace').scrollTop = 120;
  f.ctx.render({
    files: [{ ...cloud, documentRevision: 4 }],
    catalog: { accountId: 'a', status: 'ready' },
  });
  assert.equal(f.cards()[0], card);
  assert.equal(f.elements.get('workspace').scrollTop, 120);
  f.ctx.render({
    files: [cloud],
    catalog: { accountId: 'b', status: 'ready' },
  });
  assert.notEqual(f.cards()[0], card);
});
test('zoom stays continuous after fitting unusually small or large native pages', async () => {
  for (const scale of [1000, 0.000001]) {
    const f = fixture(async ({ name, arguments: args }) =>
      name === 'figma_canvas'
        ? canvasResult(args, { scale })
        : result({ files: [connected('CloudFile1')] }),
    );
    await tick();
    f.ctx.openFile('CloudFile1');
    await tick();
    const zoom = () =>
      Number(f.image().style.transform.match(/scale\(([^)]+)\)/)[1]);
    const fitted = zoom();
    const factor = scale > 1 ? 0.8 : 1.25;
    f.elements.get(scale > 1 ? 'canvas-minus' : 'canvas-plus').onclick();
    assert.ok(Math.abs(zoom() / fitted - factor) < 1e-10);
  }
});
test('background snapshots retain keyboard focus on files, including renamed covers', async () => {
  const cloud = file('CloudFile1');
  const catalog = { accountId: 'a', status: 'ready' };
  const f = fixture(async () => result({ files: [cloud], catalog }));
  await tick();
  const card = f.cards()[0];
  card.focus();
  f.ctx.render({ files: [{ ...cloud, documentRevision: 4 }], catalog });
  assert.equal(f.document.activeElement, card);
  f.ctx.render({ files: [{ ...cloud, name: 'Renamed file' }], catalog });
  assert.equal(f.document.activeElement, f.cards()[0]);
  assert.equal(f.document.activeElement.title, 'Renamed file');
});
test('background revisions retain page and session choices while actual labels update', async () => {
  const cloud = connected('CloudFile1');
  const f = fixture(async ({ name }) =>
    name === 'figma_canvas' ? canvasResult() : result({ files: [cloud] }),
  );
  await tick();
  f.ctx.openFile(cloud.fileKey);
  await tick();
  const pages = f.elements.get('canvas-page'),
    sessions = f.elements.get('canvas-session');
  const pageChoices = [...pages.children],
    sessionChoices = [...sessions.children];
  f.ctx.render({ files: [connected('CloudFile1', 2)] });
  await tick();
  assert.deepEqual(pages.children, pageChoices);
  assert.deepEqual(sessions.children, sessionChoices);
  const renamed = connected('CloudFile1', 3);
  renamed.sessions[0].pageName = 'Renamed page';
  f.ctx.render({ files: [renamed] });
  await tick();
  assert.match(sessions.children.at(-1).textContent, /Renamed page/);
});
test('list sorts all three Figma timestamps in both directions, keeps missing dates last and leaves cards in their original order', async () => {
  const dates = [
    '2024-01-01T00:00:00Z',
    '2024-02-01T00:00:00Z',
    '2024-03-01T00:00:00Z',
  ];
  const files = [
    file('FileAlpha', {
      lastViewedAt: dates[0],
      updatedAt: dates[2],
      createdAt: dates[1],
    }),
    file('FileBravo', {
      lastViewedAt: dates[2],
      updatedAt: dates[0],
      createdAt: dates[0],
    }),
    file('FileCharlie', {
      lastViewedAt: dates[1],
      updatedAt: dates[1],
      createdAt: dates[2],
    }),
    file('FileMissing'),
  ];
  const f = fixture(async () => result({ files }));
  await tick();
  const order = () => f.cards().map((c) => c.dataset.fileId);
  assert.equal(f.elements.get('list-header').hidden, true);
  f.elements.get('view-list').onclick();
  assert.deepEqual(order(), [
    'FileAlpha',
    'FileCharlie',
    'FileBravo',
    'FileMissing',
  ]);
  assert.equal(f.elements.get('list-header').hidden, false);
  for (const [field, descending] of [
    ['lastViewedAt', ['FileBravo', 'FileCharlie', 'FileAlpha']],
    ['createdAt', ['FileCharlie', 'FileAlpha', 'FileBravo']],
    ['updatedAt', ['FileAlpha', 'FileCharlie', 'FileBravo']],
  ]) {
    const button = f.elements.get('sort-' + field);
    button.onclick();
    assert.deepEqual(order(), [...descending, 'FileMissing']);
    assert.equal(button.dataset.direction, 'desc');
    assert.equal(button.attributes['aria-pressed'], 'true');
    button.onclick();
    assert.deepEqual(order(), [...descending].reverse().concat('FileMissing'));
    assert.equal(button.dataset.direction, 'asc');
  }
  f.elements.get('view-cards').onclick();
  assert.deepEqual(
    order(),
    files.map((f) => f.id),
  );
  assert.equal(f.elements.get('list-header').hidden, true);
  assert.equal(f.calls.length, 1);
});
test('list sort is remembered, combines with search and preserves the separate card scroll position', async () => {
  const files = [
    file('FileAlpha', { name: 'Kit Alpha', createdAt: '2024-01-01' }),
    file('FileBravo', { name: 'Kit Bravo', createdAt: '2024-03-01' }),
    file('FileCharlie', { name: 'Other', createdAt: '2024-02-01' }),
  ];
  const f = fixture(async () => result({ files }), 'list', {
    field: 'createdAt',
    direction: 'asc',
  });
  await tick();
  assert.deepEqual(
    f.cards().map((c) => c.dataset.fileId),
    ['FileAlpha', 'FileCharlie', 'FileBravo'],
  );
  f.elements.get('view-cards').onclick();
  const workspace = f.elements.get('workspace');
  workspace.scrollTop = 140;
  workspace.onscroll();
  f.elements.get('view-list').onclick();
  workspace.scrollTop = 90;
  workspace.onscroll();
  f.elements.get('sort-createdAt').onclick();
  assert.equal(workspace.scrollTop, 0);
  assert.deepEqual(JSON.parse(f.storage.get('ysun-figma-list-sort')), {
    field: 'createdAt',
    direction: 'desc',
  });
  f.elements.get('search').value = 'kit';
  f.elements.get('search').oninput();
  assert.deepEqual(
    f.cards().map((c) => c.dataset.fileId),
    ['FileBravo', 'FileAlpha'],
  );
  f.elements.get('clear-search').onclick();
  f.elements.get('view-cards').onclick();
  assert.equal(workspace.scrollTop, 140);
  assert.equal(f.calls.length, 1);
});
test('timestamp refresh updates cells and list order without replacing loaded covers or inventing missing dates', async () => {
  const alpha = file('FileAlpha', { lastViewedAt: '2024-01-01' }),
    bravo = file('FileBravo', { lastViewedAt: '2024-02-01' });
  const f = fixture(async () => result({ files: [alpha, bravo] }), 'list', {
    field: 'lastViewedAt',
    direction: 'desc',
  });
  await tick();
  const card = f.cards()[1],
    image = card.children[0].children[0];
  f.ctx.render({ files: [{ ...alpha, lastViewedAt: '2024-03-01' }, bravo] });
  assert.equal(f.cards()[0], card);
  assert.equal(card.children[0].children[0], image);
  assert.equal(
    card.children[1].children[1].title,
    new Date('2024-03-01').toLocaleString('zh-CN'),
  );
  assert.equal(card.children[1].children[3].textContent, '—');
  f.ctx.openFile(alpha.id);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).arguments.action, 'open');
  assert.equal(f.ctx.visibleFiles()[0].lastViewedAt, '2024-03-01');
});
