// Runs only in the exact authenticated Desktop renderer selected by file URL.
// Resolve the current app's own launcher and permission guard, never bypass them.
function createEditorReader(options = {}) {
  const expectedUrl = location.href;
  const keyOf = (url) => {
    const p = new URL(url).pathname.split('/');
    return p[3] === 'branch' ? p[4] : p[2];
  };
  const fileKey = keyOf(expectedUrl);
  const pluginId = options.pluginId || '1675211139174009382';
  const chunks = window.rspackChunk_figma_web_bundler;
  if (!Array.isArray(chunks))
    throw new Error('desktop_launcher_schema_changed');
  const factories = Object.assign({}, ...chunks.map((chunk) => chunk[1] || {}));
  let require;
  const item = [
    ['ysun-bridge-' + Date.now()],
    {},
    (r) => {
      require = r;
    },
  ];
  chunks.push(item);
  chunks.splice(chunks.indexOf(item), 1);
  if (!require) throw new Error('desktop_launcher_unavailable');
  function uniqueFactory(matches, domain) {
    const entries = Object.entries(factories).filter(([, fn]) =>
      matches(String(fn)),
    );
    if (entries.length !== 1)
      throw new Error(
        `desktop_${domain}_${entries.length ? 'ambiguous' : 'schema_changed'}`,
      );
    return entries[0];
  }
  function dependency(source, alias, domain) {
    const name = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [
      ...source.matchAll(
        new RegExp('(?:[,;]|var )' + name + '=[\\w$]+\\((\\d+)\\)', 'g'),
      ),
    ];
    if (matches.length !== 1)
      throw new Error(`desktop_${domain}_schema_changed`);
    return matches[0][1];
  }
  const storeEntry = uniqueFactory(
    (source) => /globalReduxStore\s*:\s*\(\)\s*=>/.test(source),
    'state',
  );
  const store = require(storeEntry[0]).globalReduxStore;
  if (typeof store?.getState !== 'function')
    throw new Error('desktop_state_schema_changed');
  function check(requireOpenFile = true) {
    const openKey = store.getState().openFile?.key;
    if (
      location.origin !== new URL(expectedUrl).origin ||
      keyOf(location.href) !== fileKey ||
      (openKey && openKey !== fileKey) ||
      (requireOpenFile && !openKey)
    )
      throw new Error('desktop_file_identity_changed');
  }
  function launcher() {
    const [, entry] = uniqueFactory(
      (source) =>
        source.includes('case"run-local-plugin"') &&
        source.includes('runExtensionMenuAction: Cannot run plugin'),
      'launcher',
    );
    const source = String(entry);
    const branch = source.slice(
      source.indexOf('case"run-local-plugin"'),
      source.indexOf('case"run-installed-plugin"'),
    );
    const match = branch.match(
      /\(0,([\w$]+)\.([\w$]+)\)\(\{plugin:[\w$]+\}\);[\w$]+\.canRun\?([\w$]+)\.([\w$]+)\.instance\.enqueue/,
    );
    if (!match) throw new Error('desktop_launcher_schema_changed');
    const guard = require(dependency(source, match[1], 'launcher'))?.[match[2]];
    const runner = require(dependency(source, match[3], 'launcher'))?.[match[4]]
      ?.instance;
    if (typeof guard !== 'function' || typeof runner?.enqueue !== 'function')
      throw new Error('desktop_launcher_schema_changed');
    return { guard, runner };
  }
  function widgetLauncher() {
    const [, entry] = uniqueFactory(
      (source) =>
        source.includes('case"insert-local-widget"') &&
        source.includes('runExtensionMenuAction: Widget not found'),
      'widget',
    );
    const menuSource = String(entry);
    const branch = menuSource.slice(
      menuSource.indexOf('case"insert-local-widget"'),
      menuSource.indexOf('case"insert-installed-widget"'),
    );
    const insertion = branch.match(/\(0,([\w$]+)\.([\w$]+)\)\(\{pluginID:/);
    if (!insertion) throw new Error('desktop_widget_schema_changed');
    const moduleId = dependency(menuSource, insertion[1], 'widget');
    const insert = require(moduleId)?.[insertion[2]];
    if (typeof insert !== 'function')
      throw new Error('desktop_widget_schema_changed');
    const insertSource = String(insert),
      moduleSource = String(factories[moduleId]);
    const guardMatches = [
      ...insertSource.matchAll(/if\(!\(0,([\w$]+)\.([\w$]+)\)\(\)\)/g),
    ];
    if (guardMatches.length !== 2)
      throw new Error('desktop_widget_schema_changed');
    const guards = guardMatches.map(
      (guard) =>
        require(dependency(moduleSource, guard[1], 'widget'))?.[guard[2]],
    );
    if (guards.some((guard) => typeof guard !== 'function'))
      throw new Error('desktop_widget_schema_changed');
    const lookup = insertSource.match(/\(0,([\w$]+)\.([\w$]+)\)\(\)\.get\(/);
    const mount = insertSource.match(/([\w$]+)\.([\w$]+)\.mountWidget\(/);
    if (!lookup || !mount) throw new Error('desktop_widget_schema_changed');
    const nodeMap = require(dependency(moduleSource, lookup[1], 'widget'))?.[
      lookup[2]
    ];
    const manager = require(dependency(moduleSource, mount[1], 'widget'))?.[
      mount[2]
    ];
    if (
      typeof nodeMap !== 'function' ||
      typeof manager?.mountWidget !== 'function'
    )
      throw new Error('desktop_widget_schema_changed');
    return { insert, guards, nodeMap, manager };
  }
  function startWidget(nodeId) {
    check();
    const plugins = Object.values(store.getState().localPlugins || {}).filter(
      (p) => p.plugin_id === pluginId && p.manifest?.containsWidget === true,
    );
    if (plugins.length !== 1)
      throw new Error(
        plugins.length
          ? 'desktop_widget_ambiguous'
          : 'desktop_widget_not_imported',
      );
    const plugin = plugins[0];
    const { insert, guards, nodeMap, manager } = widgetLauncher();
    for (const guard of guards)
      if (!guard()) throw new Error('desktop_widget_not_permitted');
    if (nodeId) {
      const node = nodeMap().get(nodeId);
      if (node?.type !== 'WIDGET' || node.widgetId !== pluginId)
        throw new Error('desktop_widget_identity_changed');
      manager
        .mountWidget(
          pluginId,
          node.guid,
          'insert',
          undefined,
          undefined,
          'ysun-figma-mcp',
        )
        ?.catch(() => {});
      return { state: 'starting', widgetNodeId: node.guid };
    }
    const result = insert({
      pluginID: pluginId,
      widgetName: plugin.name,
      pluginVersionID: '',
      shouldFocusFirstInput: false,
      triggeredFrom: 'ysun-figma-mcp',
    });
    if (!result?.widgetNodeID)
      throw new Error('desktop_widget_insertion_rejected');
    result.widgetRunPromise?.catch(() => {});
    return { state: 'starting', widgetNodeId: result.widgetNodeID };
  }
  function probe(resolve) {
    try {
      resolve();
      return { available: true };
    } catch (error) {
      return {
        available: false,
        issue: /^desktop_\w+$/.test(error.message)
          ? error.message
          : 'desktop_adapter_schema_changed',
      };
    }
  }
  return {
    startWidget,
    status() {
      check(false);
      const state = store.getState(),
        s = state.saveStatus;
      return {
        url: location.href,
        documentReady: document.readyState,
        documentVisible:
          typeof document.visibilityState === 'string'
            ? document.visibilityState === 'visible'
            : null,
        editorLoaded:
          typeof state.isFullscreenDocumentLoaded === 'boolean'
            ? state.isFullscreenDocumentLoaded
            : null,
        openFileKey: state.openFile?.key || null,
        desktopAdapter: {
          revision: 1,
          pluginLauncher: probe(launcher),
          widgetLauncher: probe(widgetLauncher),
        },
        saveStatus: s
          ? {
              hasUnsavedChanges: s.hasUnsavedChanges,
              hasAutosaveChanges: s.hasAutosaveChanges,
              hasMultiplayerChanges: s.hasMultiplayerChanges,
              hasStagedChanges: s.hasStagedChanges,
              hasChangesBlockingNavigation: s.hasChangesBlockingNavigation,
              error: s.error,
            }
          : null,
      };
    },
    start() {
      check();
      const state = store.getState();
      if (!state.isFullscreenDocumentLoaded)
        throw new Error('desktop_editor_not_ready');
      const plugins = Object.values(state.localPlugins || {}).filter(
        (p) => p.plugin_id === pluginId,
      );
      if (plugins.length !== 1)
        throw new Error(
          plugins.length
            ? 'desktop_plugin_ambiguous'
            : 'desktop_plugin_not_imported',
        );
      const plugin = plugins[0];
      const { guard, runner } = launcher();
      const permission = guard({ plugin });
      if (!permission?.canRun)
        throw new Error(
          'desktop_plugin_not_permitted: ' + (permission?.message || 'unknown'),
        );
      const active = runner.currentRunState;
      if (active) {
        if (active.runPluginArgs?.plugin?.plugin_id !== pluginId)
          throw new Error('desktop_other_plugin_running');
        return { state: 'already_running', fileKey, pluginId };
      }
      if (runner.getRunQueueLength?.())
        throw new Error('desktop_plugin_queue_busy');
      const promise = runner.enqueue({
        mode: 'run-forever',
        runPluginArgs: {
          plugin,
          command: 'connect',
          queryMode: false,
          runMode: 'default',
          triggeredFrom: 'ysun-figma-mcp',
          openFileKey: fileKey,
          isWidget: false,
        },
      });
      promise?.catch((error) =>
        console.error(
          'ysun figma native launch:',
          String(error?.message || error),
        ),
      );
      return { state: 'starting', fileKey, pluginId };
    },
    close() {},
  };
}
if (typeof module !== 'undefined') module.exports = { createEditorReader };
