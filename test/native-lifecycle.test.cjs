const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createEditorReader } = require('../src/host/editor-reader.js');
const { connectNativeFile } = require('../src/host/native-lifecycle.cjs');
function editor(prepare = () => {}) {
  const state = {
    openFile: { key: 'CloudFile12' },
    isFullscreenDocumentLoaded: true,
    localPlugins: { 4: { plugin_id: '1675211139174009382', localFileId: 4 } },
    saveStatus: { hasUnsavedChanges: false, error: 0 },
  };
  const runs = [];
  let permitted = true;
  const runner = {
    currentRunState: null,
    getRunQueueLength: () => 0,
    enqueue: (input) => {
      runs.push(input);
      return Promise.resolve();
    },
  };
  const factory = (source) => ({ toString: () => source });
  const factories = {
    101: factory('101(e,t,n){n.d(t,{globalReduxStore:()=>s})}'),
    201: factory(
      '201(e,t,n){var z=n(301),H=n(401);switch(e){case"run-local-plugin":let o=(0,z.JT)({plugin:p});o.canRun?H.R0.instance.enqueue({}):null;case"run-installed-plugin":break}const error="runExtensionMenuAction: Cannot run plugin";}',
    ),
  };
  const modules = {
    101: { globalReduxStore: { getState: () => state } },
    301: { JT: () => ({ canRun: permitted, message: 'account denied' }) },
    401: { R0: { instance: runner } },
  };
  prepare({ factories, modules, factory, state, runner });
  const chunks = [[[], factories]];
  chunks.push = function (item) {
    Array.prototype.push.call(this, item);
    item[2]((id) => modules[id]);
    return this.length;
  };
  const location = {
    href: 'https://www.figma.com/design/CloudFile12/Test',
    origin: 'https://www.figma.com',
  };
  const reader = vm.runInNewContext(
    '(' + createEditorReader.toString() + ')()',
    {
      window: {
        rspackChunk_figma_web_bundler: chunks,
        store: {
          getState() {
            throw new Error('Debug getState delays must never be used');
          },
        },
      },
      location,
      document: { readyState: 'complete' },
      URL,
      console,
    },
  );
  return {
    reader,
    state,
    runs,
    runner,
    location,
    deny() {
      permitted = false;
    },
  };
}
test('desktop adapter resolves renamed module IDs and exports without calling permissions during diagnosis', () => {
  let checks = 0;
  const f = editor(({ factories, modules, factory }) => {
    factories[92861] = factory(
      '92861(a,b,c){var a$=c(76199),r$=c(55431);switch(a){case"run-local-plugin":let p=(0,a$.allow$)({plugin:q});p.canRun?r$.queue$.instance.enqueue({}):null;case"run-installed-plugin":break}const error="runExtensionMenuAction: Cannot run plugin";}',
    );
    delete factories[201];
    modules[76199] = {
      allow$: () => {
        checks++;
        return { canRun: true };
      },
    };
    modules[55431] = { queue$: modules[401].R0 };
  });
  assert.equal(f.reader.status().desktopAdapter.pluginLauncher.available, true);
  assert.equal(checks, 0);
  assert.equal(f.runs.length, 0);
  assert.equal(f.reader.start().state, 'starting');
  assert.equal(checks, 1);
});
test('ambiguous or changed launcher signatures fail before enqueuing a native plugin', () => {
  const ambiguous = editor(({ factories }) => {
    factories[202] = factories[201];
  });
  assert.equal(
    ambiguous.reader.status().desktopAdapter.pluginLauncher.issue,
    'desktop_launcher_ambiguous',
  );
  assert.throws(() => ambiguous.reader.start(), /desktop_launcher_ambiguous/);
  assert.equal(ambiguous.runs.length, 0);
  const changed = editor(({ factories, factory }) => {
    factories[201] = factory(
      'case"run-local-plugin"; "runExtensionMenuAction: Cannot run plugin"',
    );
  });
  assert.equal(
    changed.reader.status().desktopAdapter.pluginLauncher.available,
    false,
  );
  assert.throws(
    () => changed.reader.start(),
    /desktop_launcher_schema_changed/,
  );
  assert.equal(changed.runs.length, 0);
  assert.throws(
    () =>
      editor(({ factories }) => {
        factories[102] = factories[101];
      }),
    /desktop_state_ambiguous/,
  );
});
test('Widget diagnosis leaves permissions untouched and exact-node recovery retains both real guards', () => {
  let permitted = false,
    checks = 0;
  const mounted = [],
    inserted = [];
  const f = editor(({ state, modules, factories, factory }) => {
    state.localPlugins[4].manifest = { containsWidget: true };
    factories[501] = factory(
      '501(e,t,n){var W=n(601);switch(e){case"insert-local-widget":(0,W.insert)({pluginID:p});case"insert-installed-widget":break}const error="runExtensionMenuAction: Widget not found";}',
    );
    factories[601] = factory(
      '601(e,t,n){var G=n(701),P=n(702),N=n(703),M=n(704);}',
    );
    const insert = (args) => {
      inserted.push(args);
      return { widgetNodeID: '9:1' };
    };
    insert.toString = () =>
      'function insert(){if(!(0,G.check)())return;if(!(0,P.check)())return;(0,N.all)().get(id);M.manager.mountWidget(id)}';
    modules[601] = { insert };
    modules[701] = {
      check: () => {
        checks++;
        return permitted;
      },
    };
    modules[702] = {
      check: () => {
        checks++;
        return true;
      },
    };
    modules[703] = {
      all: () =>
        new Map([
          [
            '11:4',
            { type: 'WIDGET', widgetId: '1675211139174009382', guid: '11:4' },
          ],
        ]),
    };
    modules[704] = {
      manager: {
        mountWidget: (...args) => {
          mounted.push(args);
        },
      },
    };
  });
  assert.equal(f.reader.status().desktopAdapter.widgetLauncher.available, true);
  assert.equal(checks, 0);
  assert.throws(
    () => f.reader.startWidget('11:4'),
    /desktop_widget_not_permitted/,
  );
  assert.equal(mounted.length, 0);
  permitted = true;
  assert.equal(f.reader.startWidget('11:4').widgetNodeId, '11:4');
  assert.equal(checks, 3);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0][1], '11:4');
  assert.equal(inserted.length, 0);
  assert.throws(
    () => f.reader.startWidget('different'),
    /desktop_widget_identity_changed/,
  );
  assert.equal(mounted.length, 1);
});
test('native lifecycle avoids the intentionally slow debug store and preserves app permission and queue guards', () => {
  const f = editor();
  assert.equal(f.reader.status().editorLoaded, true);
  assert.equal(f.reader.start().state, 'starting');
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].runPluginArgs.openFileKey, 'CloudFile12');
  f.runner.currentRunState = {
    runPluginArgs: { plugin: { plugin_id: 'other-plugin' } },
  };
  assert.throws(() => f.reader.start(), /other_plugin_running/);
  assert.equal(f.runs.length, 1);
  f.runner.currentRunState = null;
  f.deny();
  assert.throws(() => f.reader.start(), /not_permitted/);
});
test('native identity accepts viewport query changes, rejects file changes and discloses an unloaded editor', () => {
  const f = editor();
  f.location.href += '?node-id=1-2';
  assert.equal(f.reader.status().editorLoaded, true);
  f.state.isFullscreenDocumentLoaded = false;
  f.state.openFile = null;
  assert.equal(f.reader.status().editorLoaded, false);
  f.state.openFile = { key: 'OtherFile12' };
  assert.throws(() => f.reader.status(), /identity_changed/);
});
test('new native pairing uses only the owned context and returns URL/document/instance proof without a GUI action', async () => {
  let listener,
    connected = false,
    started = 0;
  const calls = [];
  const result = await connectNativeFile({
    fileKey: 'CloudFile12',
    pairingCode: 'a'.repeat(32),
    connect: async () => ({
      onEvent(fn) {
        listener = fn;
        return () => {};
      },
      close() {},
      async call(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        if (method === 'Target.getTargets')
          return {
            targetInfos: [
              {
                type: 'page',
                targetId: 'target-12',
                url: 'https://www.figma.com/design/CloudFile12/Test',
              },
            ],
          };
        if (method === 'Target.attachToTarget')
          return { sessionId: 'session-12' };
        if (method === 'Runtime.enable') {
          listener({
            sessionId: 'session-12',
            method: 'Runtime.executionContextCreated',
            params: { context: { id: 12, auxData: { isDefault: true } } },
          });
          return {};
        }
        if (method === 'Runtime.evaluate') {
          if (params.expression.includes('createEditorReader'))
            return { result: { objectId: 'reader-12' } };
          if (params.expression.includes('.pair(')) {
            assert.equal(params.contextId, 12);
            assert(params.expression.includes('a'.repeat(32)));
            connected = true;
            return { result: { value: true } };
          }
          if (!started) return { result: { value: null } };
          return {
            result: {
              value: {
                pluginId: '1675211139174009382',
                clientId: 'client-12',
                instanceId: 'instance-12',
                documentId: 'd'.repeat(32),
                connected,
                closed: false,
              },
            },
          };
        }
        if (method === 'Runtime.callFunctionOn') {
          const name = params.arguments?.[0]?.value;
          if (name === 'status')
            return {
              result: {
                value: {
                  url: 'https://www.figma.com/design/CloudFile12/Test',
                  editorLoaded: true,
                },
              },
            };
          if (name === 'start') {
            started++;
            return { result: { value: { state: 'starting' } } };
          }
          return { result: { value: null } };
        }
        if (
          ['Runtime.releaseObject', 'Target.detachFromTarget'].includes(method)
        )
          return {};
        assert.fail(method);
      },
    }),
  });
  assert.equal(result.state, 'connected');
  assert.equal(result.native.documentId, 'd'.repeat(32));
  assert.equal(started, 1);
  assert(!calls.some((c) => /Input\.|Page.navigate/.test(c.method)));
});

for (const mismatch of ['runtime', 'build']) {
  test(`cold recovery replaces an outdated ${mismatch} even with a stale connected token, then renews its broker session`, async () => {
    const expected = require('../src/shared/core.js').BRIDGE_RUNTIME_VERSION;
    let listener,
      open = true,
      current = mismatch === 'runtime' ? expected - 1 : expected,
      build = 'a'.repeat(64),
      closed = 0,
      started = 0,
      validated = 0;
    const result = await connectNativeFile({
      fileKey: 'CloudFile12',
      expectedNativeBuild: 'b'.repeat(64),
      connect: async () => ({
        onEvent(fn) {
          listener = fn;
          return () => {};
        },
        close() {},
        async call(method, params = {}) {
          if (method === 'Target.getTargets')
            return {
              targetInfos: [
                {
                  type: 'page',
                  targetId: 'exact',
                  url: 'https://www.figma.com/design/CloudFile12/QA',
                },
              ],
            };
          if (method === 'Target.attachToTarget')
            return { sessionId: 'session' };
          if (method === 'Runtime.enable') {
            listener({
              sessionId: 'session',
              method: 'Runtime.executionContextCreated',
              params: { context: { id: 10, auxData: { isDefault: true } } },
            });
            return {};
          }
          if (method === 'Runtime.evaluate') {
            if (params.expression.includes('createEditorReader'))
              return { result: { objectId: 'reader' } };
            if (params.expression.includes('closeIdle')) {
              open = false;
              closed++;
              return { result: { value: true } };
            }
            if (params.expression.includes('typeof heartbeat')) {
              validated++;
              return { result: { value: true } };
            }
            return {
              result: {
                value: open
                  ? {
                      clientId: 'actual',
                      documentId: 'doc',
                      instanceId: 'instance-' + current,
                      pluginId: '1675211139174009382',
                      runtimeVersion: current,
                      nativeBuild: build,
                      connected: true,
                      closed: false,
                    }
                  : null,
              },
            };
          }
          if (method === 'Runtime.callFunctionOn') {
            const name = params.arguments?.[0]?.value;
            if (name === 'status')
              return {
                result: {
                  value: {
                    url: 'https://www.figma.com/design/CloudFile12/QA',
                    editorLoaded: true,
                  },
                },
              };
            if (name === 'start') {
              started++;
              open = true;
              current = expected;
              build = 'b'.repeat(64);
              return { result: { value: { state: 'starting' } } };
            }
            return { result: { value: null } };
          }
          if (
            ['Runtime.releaseObject', 'Target.detachFromTarget'].includes(
              method,
            )
          )
            return {};
          assert.fail(method);
        },
      }),
    });
    assert.equal(closed, 1);
    assert.equal(started, 1);
    assert.equal(validated, 1);
    assert.equal(result.native.runtimeVersion, expected);
    assert.equal(result.native.nativeBuild, 'b'.repeat(64));
  });
}

for (const scenario of ['replaced', 'busy', 'failed']) {
  test(`profile transition observes an owned sibling iframe: ${scenario}`, async () => {
    let listener,
      started = false;
    const closed = {
      clientId: 'widget-old',
      instanceId: 'old-instance',
      pluginId: '1700202761156255033',
    };
    const task = connectNativeFile({
      fileKey: 'CloudFile12',
      profile: 'dev',
      connect: async () => ({
        onEvent(fn) {
          listener = fn;
          return () => {};
        },
        close() {},
        async call(method, params = {}) {
          const emit = (method, params) =>
            listener({ sessionId: 'session', method, params });
          const add = (id) =>
            emit('Runtime.executionContextCreated', {
              context: { id, auxData: { isDefault: true } },
            });
          if (method === 'Target.getTargets')
            return {
              targetInfos: [
                {
                  type: 'page',
                  targetId: 'target',
                  url: 'https://www.figma.com/design/CloudFile12/QA',
                },
              ],
            };
          if (method === 'Target.attachToTarget')
            return { sessionId: 'session' };
          if (method === 'Runtime.enable') {
            add(10);
            return {};
          }
          if (method === 'Runtime.evaluate') {
            new vm.Script(params.expression);
            if (params.expression.includes('createEditorReader'))
              return { result: { objectId: 'reader' } };
            if (params.expression.includes('typeof heartbeat'))
              return { result: { value: true } };
            return {
              result: {
                value:
                  params.contextId === 10
                    ? {
                        ...closed,
                        documentId: 'doc',
                        connected: true,
                        busy: scenario === 'busy',
                        closed: false,
                      }
                    : {
                        clientId: 'dev-new',
                        instanceId: 'new-instance',
                        pluginId: '1700203379527851322',
                        documentId: 'doc',
                        connected: true,
                        closed: false,
                      },
              },
            };
          }
          if (method === 'Runtime.callFunctionOn') {
            const name = params.arguments?.[0]?.value;
            if (name === 'status')
              return {
                result: {
                  value: {
                    url: 'https://www.figma.com/design/CloudFile12/QA',
                    editorLoaded: true,
                    documentVisible: true,
                  },
                },
              };
            if (name === 'start') {
              started = true;
              emit('Runtime.executionContextDestroyed', {
                executionContextId: 10,
              });
              add(11);
              if (scenario === 'failed')
                throw new Error('simulated_launcher_failure');
              return { result: { value: { state: 'starting' } } };
            }
          }
          if (
            ['Runtime.releaseObject', 'Target.detachFromTarget'].includes(
              method,
            )
          )
            return {};
          assert.fail(method);
        },
      }),
    });
    if (scenario === 'busy') {
      await assert.rejects(task, /desktop_native_operation_pending/);
      assert.equal(started, false);
    } else if (scenario === 'failed') {
      await assert.rejects(task, (error) => {
        assert.equal(error.message, 'simulated_launcher_failure');
        assert.deepEqual(error.endedClients, [closed]);
        return true;
      });
    } else {
      const result = await task;
      assert.deepEqual(result.endedClients, [closed]);
      assert.equal(result.native.clientId, 'dev-new');
    }
  });
}

test('Widget cold start activates the exact hidden renderer before mounting, preserving the existing Widget ID', async () => {
  let listener,
    visible = false,
    open = false,
    activated = 0;
  const result = await connectNativeFile({
    fileKey: 'CloudFile12',
    profile: 'widget',
    widgetNodeId: '11:4',
    activate: async (key) => {
      assert.equal(key, 'CloudFile12');
      activated++;
      visible = true;
    },
    connect: async () => ({
      onEvent(fn) {
        listener = fn;
        return () => {};
      },
      close() {},
      async call(method, params = {}) {
        if (method === 'Target.getTargets')
          return {
            targetInfos: [
              {
                type: 'page',
                targetId: 'exact',
                url: 'https://www.figma.com/design/CloudFile12/QA',
              },
            ],
          };
        if (method === 'Target.attachToTarget') return { sessionId: 'session' };
        if (method === 'Runtime.enable') {
          listener({
            sessionId: 'session',
            method: 'Runtime.executionContextCreated',
            params: { context: { id: 10, auxData: { isDefault: true } } },
          });
          return {};
        }
        if (method === 'Runtime.evaluate') {
          if (params.expression.includes('createEditorReader'))
            return { result: { objectId: 'reader' } };
          if (params.expression.includes('typeof heartbeat'))
            return { result: { value: true } };
          return {
            result: {
              value: open
                ? {
                    clientId: 'widget',
                    documentId: 'doc',
                    instanceId: 'instance',
                    pluginId: '1700202761156255033',
                    connected: true,
                    closed: false,
                  }
                : null,
            },
          };
        }
        if (method === 'Runtime.callFunctionOn') {
          const name = params.arguments?.[0]?.value;
          if (name === 'status')
            return {
              result: {
                value: {
                  url: 'https://www.figma.com/design/CloudFile12/QA',
                  editorLoaded: true,
                  documentVisible: visible,
                },
              },
            };
          if (name === 'startWidget') {
            assert(visible, 'A hidden Widget renderer must not be mounted');
            assert.deepEqual(Array.from(params.arguments[1].value), ['11:4']);
            open = true;
            return {
              result: { value: { state: 'starting', widgetNodeId: '11:4' } },
            };
          }
          return { result: { value: null } };
        }
        if (
          ['Runtime.releaseObject', 'Target.detachFromTarget'].includes(method)
        )
          return {};
        assert.fail(method);
      },
    }),
  });
  assert.equal(activated, 1);
  assert.equal(result.widgetNodeId, '11:4');
  assert.equal(result.activatedEditor, true);
});
