const {
  queuedDesktop,
  runtimeResult,
  createPageReader,
  launchDesktop,
} = require('./desktop.cjs');
const { createEditorReader } = require('./editor-reader.js');
const { parseFigmaUrl } = require('./targets.cjs');
const { BRIDGE_RUNTIME_VERSION } = require('../shared/core.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connectNativeFile({
  fileKey,
  targetId,
  pairingCode,
  restart = false,
  profile = 'default',
  widgetNodeId,
  expectedNativeBuild,
  connect = queuedDesktop,
  activate = launchDesktop,
}) {
  if (!/^[A-Za-z0-9]{6,100}$/.test(fileKey || ''))
    throw new Error('Invalid Figma file key');
  if (expectedNativeBuild && !/^[a-f0-9]{64}$/.test(expectedNativeBuild))
    throw new Error('Invalid expected native build identity');
  const connection = await connect();
  const { pluginId } = require('./native-profiles.cjs').profileInfo(profile);
  let sessionId,
    reader,
    unsubscribe,
    widgetStarted = false,
    activatedEditor = false;
  const contexts = new Set();
  try {
    const { targetInfos } = await connection.call('Target.getTargets');
    const matches = targetInfos.filter((t) => {
      try {
        return (
          t.type === 'page' &&
          /\/(design|file|board|slides|buzz)\//.test(new URL(t.url).pathname) &&
          parseFigmaUrl(t.url).fileKey === fileKey &&
          (!targetId || t.targetId === targetId)
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw Object.assign(
        new Error(
          matches.length ? 'desktop_file_ambiguous' : 'desktop_file_not_open',
        ),
        { targets: matches.map((t) => ({ targetId: t.targetId, url: t.url })) },
      );
    const target = matches[0];
    ({ sessionId } = await connection.call('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    }));
    unsubscribe = connection.onEvent?.((event) => {
      if (event.sessionId !== sessionId) return;
      if (
        event.method === 'Runtime.executionContextCreated' &&
        event.params.context.auxData?.isDefault
      )
        contexts.add(event.params.context.id);
      if (event.method === 'Runtime.executionContextDestroyed')
        contexts.delete(event.params.executionContextId);
      if (event.method === 'Runtime.executionContextsCleared') contexts.clear();
    });
    reader = await createPageReader(
      connection,
      sessionId,
      createEditorReader,
      'desktop_editor_unavailable',
      { pluginId },
    );
    const status = await reader.invoke('status');
    if (parseFigmaUrl(status.url).fileKey !== fileKey)
      throw new Error('desktop_file_identity_changed');
    if (!status.editorLoaded) throw new Error('desktop_editor_not_ready');
    const verifiedUrl = status.url;
    async function nativeUi() {
      const found = [];
      for (const contextId of [...contexts]) {
        try {
          const value = runtimeResult(
            await connection.call(
              'Runtime.evaluate',
              {
                contextId,
                expression:
                  '(()=>{const owned=globalThis.__ysunFigmaLifecycle?.identity?.() || (typeof direct!=="undefined"&&direct.context?.pluginId===' +
                  JSON.stringify(pluginId) +
                  '?{legacy:true,clientId:direct.clientId,instanceId:direct.instanceId,documentId:direct.context.documentId,pluginId:direct.context.pluginId,connected:!!direct.token,busy:!!direct.pending||!!direct.blockedJobId,closed:direct.closed}:null);return owned&&typeof direct!=="undefined"?{...owned,runtimeVersion:direct.context?.runtimeVersion,nativeBuild:direct.context?.nativeBuild}:owned})()',
                returnByValue: true,
              },
              sessionId,
              { timeoutMs: 1000, isolatedTimeout: true },
            ),
          ).value;
          if (value?.pluginId === pluginId && !value.closed)
            found.push({ contextId, ...value });
        } catch {}
      }
      if (found.length > 1) throw new Error('desktop_native_frame_ambiguous');
      return found[0] || null;
    }
    let ui = await nativeUi();
    const outdated =
      (ui?.runtimeVersion !== undefined &&
        ui.runtimeVersion !== BRIDGE_RUNTIME_VERSION) ||
      !!(ui && expectedNativeBuild && ui.nativeBuild !== expectedNativeBuild);
    if ((restart || ui?.legacy || outdated) && ui) {
      if (ui.busy) throw new Error('desktop_native_operation_pending');
      const closed = runtimeResult(
        await connection.call(
          'Runtime.evaluate',
          {
            contextId: ui.contextId,
            expression: ui.legacy
              ? '(()=>{if(direct.pending||direct.blockedJobId||typeof closePlugin!=="function")return false;closePlugin();return true})()'
              : 'globalThis.__ysunFigmaLifecycle.closeIdle()',
            returnByValue: true,
          },
          sessionId,
        ),
      ).value;
      if (!closed) throw new Error('desktop_native_operation_pending');
      await pause(100);
      ui = null;
    }
    if (!ui) {
      if (profile === 'widget' && status.documentVisible !== true) {
        // Figma defers Widget effects in hidden file renderers. Activate only
        // this exact observed file through its own deep link, then verify the
        // renderer became visible before mounting an existing Widget.
        await activate(fileKey);
        activatedEditor = true;
        const deadline = Date.now() + 5000;
        let current;
        do {
          current = await reader.invoke('status');
          if (current.documentVisible !== false) break;
          await pause(100);
        } while (Date.now() < deadline);
        if (current.documentVisible === false)
          throw new Error('desktop_widget_editor_not_visible');
      }
      if (profile === 'widget') widgetStarted = true;
      let launched;
      try {
        launched = await reader.invoke(
          profile === 'widget' ? 'startWidget' : 'start',
          widgetNodeId,
        );
      } catch (error) {
        if (
          profile === 'widget' ||
          !error.message.includes('canViewPlugins returned false')
        )
          throw error;
        // The app's real guard can require its editor to be the active tab.
        // Activate through Figma's own exact-file deep link, then re-run the
        // same guard. Never override a permission or choose another file.
        await activate(fileKey);
        activatedEditor = true;
        const deadline = Date.now() + 5000;
        while (true) {
          try {
            launched = await reader.invoke('start');
            break;
          } catch (retryError) {
            if (
              !retryError.message.includes('canViewPlugins returned false') ||
              Date.now() >= deadline
            )
              throw retryError;
            await pause(200);
          }
        }
      }
      widgetNodeId ||= launched?.widgetNodeId;
      const deadline = Date.now() + 15000;
      do {
        ui = await nativeUi();
        if (ui) break;
        await pause(100);
      } while (Date.now() < deadline);
    }
    if (!ui) throw new Error('desktop_native_lifecycle_unavailable');
    if (expectedNativeBuild && ui.nativeBuild !== expectedNativeBuild)
      throw new Error('desktop_native_build_mismatch');
    if (ui.connected) {
      // A token in an existing iframe is not a current broker session. After
      // maintenance, renew through this owned runtime's normal heartbeat/resume
      // path before returning identity for binding. No credential is returned.
      await connection.call(
        'Runtime.evaluate',
        {
          contextId: ui.contextId,
          expression:
            '(async()=>{if(typeof heartbeat!=="function")return false;const deadline=Date.now()+5000;while(direct.heartbeatBusy&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));await heartbeat();return true})()',
          returnByValue: true,
          awaitPromise: true,
        },
        sessionId,
        { timeoutMs: 8000 },
      );
      ui = (await nativeUi()) || ui;
    }
    if (!ui.connected) {
      // Saved grants restore before a genuinely new pairing is attempted.
      const deadline = Date.now() + 2000;
      while (!ui.connected && Date.now() < deadline) {
        await pause(100);
        ui = (await nativeUi()) || ui;
      }
      if (!ui.connected) {
        if (!pairingCode)
          return {
            state: 'pairing_required',
            fileKey,
            targetId: target.targetId,
            verifiedUrl,
            native: ui,
          };
        const paired = runtimeResult(
          await connection.call(
            'Runtime.evaluate',
            {
              contextId: ui.contextId,
              expression:
                'globalThis.__ysunFigmaLifecycle.pair(' +
                JSON.stringify(pairingCode) +
                ')',
              returnByValue: true,
              awaitPromise: true,
            },
            sessionId,
          ),
        ).value;
        if (!paired) throw new Error('desktop_native_pairing_failed');
        ui = await nativeUi();
      }
    }
    if (!ui?.connected || !ui.documentId)
      throw new Error('desktop_native_identity_unavailable');
    await reader.invoke('status');
    return {
      state: 'connected',
      fileKey,
      targetId: target.targetId,
      verifiedUrl,
      native: ui,
      ...(activatedEditor ? { activatedEditor: true } : {}),
      ...(widgetNodeId ? { widgetNodeId } : {}),
    };
  } catch (error) {
    if (
      widgetStarted &&
      !/^desktop_widget_(?:not_imported|not_permitted|identity_changed|schema_changed|insertion_rejected)$/.test(
        error.message,
      )
    )
      error.outcomeUnknown = true;
    throw error;
  } finally {
    unsubscribe?.();
    await reader?.close().catch(() => {});
    if (sessionId)
      await connection
        .call('Target.detachFromTarget', { sessionId })
        .catch(() => {});
    connection.close();
  }
}
module.exports = { connectNativeFile };
