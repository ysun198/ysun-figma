const {
  queuedDesktop,
  ensureDesktop,
  createPageReader,
  launchDesktop,
} = require('./desktop.cjs');
const { createEditorReader } = require('./editor-reader.js');
const { createNativeFrames } = require('./native-frames.cjs');
const { profileInfo } = require('./native-profiles.cjs');
const { parseFigmaUrl } = require('./targets.cjs');
const { BRIDGE_RUNTIME_VERSION } = require('../shared/core.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReadiness(perform, deadline) {
  while (true) {
    try {
      return await perform();
    } catch (error) {
      if (
        error.message === 'desktop_plugin_not_ready' &&
        Date.now() >= deadline
      )
        throw new Error('desktop_plugin_not_imported', { cause: error });
      if (
        !/^desktop_(?:file_not_open|editor_not_ready|launcher_not_ready|widget_not_ready|plugin_not_ready)$/.test(
          error.message,
        ) ||
        Date.now() >= deadline
      )
        throw error;
      await pause(200);
    }
  }
}

async function releaseEditor(connection, session) {
  session.frames?.close();
  await session.reader?.close().catch(() => {});
  if (session.id)
    await connection
      .call('Target.detachFromTarget', { sessionId: session.id })
      .catch(() => {});
  delete session.frames;
  delete session.reader;
  delete session.id;
}

async function findEditor(connection, fileKey, targetId) {
  const { targetInfos } = await connection.call('Target.getTargets');
  const matches = targetInfos.filter((target) => {
    try {
      return (
        target.type === 'page' &&
        /\/(design|file|board|slides|buzz)\//.test(
          new URL(target.url).pathname,
        ) &&
        parseFigmaUrl(target.url).fileKey === fileKey &&
        (!targetId || target.targetId === targetId)
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
      {
        targets: matches.map((target) => ({
          targetId: target.targetId,
          url: target.url,
        })),
      },
    );
  return matches[0];
}

function needsRestart(ui, restart, expectedBuild) {
  if (!ui) return false;
  return (
    restart ||
    ui.legacy ||
    (ui.runtimeVersion !== undefined &&
      ui.runtimeVersion !== BRIDGE_RUNTIME_VERSION) ||
    !!(expectedBuild && ui.nativeBuild !== expectedBuild)
  );
}

async function showWidgetEditor(reader, status, activate) {
  if (status.documentVisible === true) return false;
  // Figma defers Widget effects in hidden editors. Activate the observed file
  // through its exact deep link before mounting an existing Widget.
  await activate();
  const deadline = Date.now() + 5000;
  do {
    const current = await reader.invoke('status');
    if (current.documentVisible !== false) return true;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error('desktop_widget_editor_not_visible');
}

async function startPlugin(reader, activate) {
  try {
    return { launched: await reader.invoke('start'), activated: false };
  } catch (error) {
    if (!error.message.includes('canViewPlugins returned false')) throw error;
  }
  // Re-run the app's real permission guard in its active editor, never override
  // a permission or switch to a different file.
  await activate();
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return { launched: await reader.invoke('start'), activated: true };
    } catch (error) {
      if (
        !error.message.includes('canViewPlugins returned false') ||
        Date.now() >= deadline
      )
        throw error;
      await pause(200);
    }
  }
}

function connectionResult(
  state,
  target,
  status,
  ui,
  frames,
  { activatedEditor, widgetNodeId },
) {
  const ended = frames.endedClients;
  return {
    state,
    fileKey: parseFigmaUrl(status.url).fileKey,
    targetId: target.targetId,
    verifiedUrl: status.url,
    native: ui,
    ...(ended.length ? { endedClients: ended } : {}),
    ...(activatedEditor ? { activatedEditor: true } : {}),
    ...(widgetNodeId ? { widgetNodeId } : {}),
  };
}

async function mountWidget(session, status, widgetNodeId, activate) {
  const activated = await showWidgetEditor(session.reader, status, activate);
  session.widgetStarted = true;
  try {
    const launched = await session.reader.invoke('startWidget', widgetNodeId);
    return { activated, widgetNodeId: widgetNodeId || launched?.widgetNodeId };
  } catch (error) {
    if (
      /^desktop_widget_(?:not_imported|not_permitted|identity_changed|schema_changed|insertion_rejected)$/.test(
        error.message,
      )
    )
      session.widgetStarted = false;
    throw error;
  }
}

async function connectEditor(connection, input, session) {
  const {
    fileKey,
    targetId,
    pairingCode,
    restart,
    profile,
    pluginId,
    expectedNativeBuild,
    activate,
  } = input;
  let { widgetNodeId } = input;
  const deadline = Date.now() + 20000;
  const { target, status } = await waitForReadiness(async () => {
    await releaseEditor(connection, session);
    const target = await findEditor(connection, fileKey, targetId);
    const { sessionId } = await connection.call('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    session.id = sessionId;
    session.frames = createNativeFrames(connection, sessionId, pluginId);
    session.reader = await createPageReader(
      connection,
      sessionId,
      createEditorReader,
      'desktop_editor_unavailable',
      { pluginId },
    );
    const status = await session.reader.invoke('status');
    if (parseFigmaUrl(status.url).fileKey !== fileKey)
      throw new Error('desktop_file_identity_changed');
    if (!status.editorLoaded) throw new Error('desktop_editor_not_ready');
    return { target, status };
  }, deadline);
  const { frames, reader } = session;
  let ui = await frames.read();
  if (
    input.expectedClient &&
    (ui?.clientId !== input.expectedClient.id ||
      ui.instanceId !== input.expectedClient.instanceId)
  )
    throw new Error('Requested native instance no longer matches this editor');
  const replace = needsRestart(
    ui,
    restart || !!(widgetNodeId && ui?.widgetNodeId !== widgetNodeId),
    expectedNativeBuild,
  );
  if (!ui || replace)
    await waitForReadiness(async () => {
      const current = await reader.invoke('status');
      if (current.nativePlugin?.matches === 0)
        throw new Error('desktop_plugin_not_ready');
      const adapter =
        current.desktopAdapter?.[
          profile === 'widget' ? 'widgetLauncher' : 'pluginLauncher'
        ];
      if (adapter?.available === false)
        throw new Error(adapter.issue || 'desktop_launcher_schema_changed');
    }, deadline);
  if (replace) {
    await frames.closeIdle(ui);
    ui = null;
  }
  let activatedEditor = false;
  if (!ui) {
    if (frames.busy()) throw new Error('desktop_native_operation_pending');
    if (profile === 'widget') {
      const state = await mountWidget(session, status, widgetNodeId, () =>
        activate(fileKey),
      );
      activatedEditor = state.activated;
      widgetNodeId = state.widgetNodeId;
    } else {
      const started = await startPlugin(reader, () => activate(fileKey));
      activatedEditor = started.activated;
    }
    ui = await frames.wait();
  }
  if (expectedNativeBuild && ui.nativeBuild !== expectedNativeBuild)
    throw new Error('desktop_native_build_mismatch');
  if (widgetNodeId && ui.widgetNodeId !== widgetNodeId)
    throw new Error('desktop_widget_identity_changed');
  widgetNodeId ||= ui.widgetNodeId;
  ui = await frames.authorize(ui, pairingCode);
  const options = { activatedEditor, widgetNodeId };
  if (ui && !ui.connected && !pairingCode)
    return connectionResult(
      'pairing_required',
      target,
      status,
      ui,
      frames,
      options,
    );
  if (!ui?.connected || !ui.documentId)
    throw new Error('desktop_native_identity_unavailable');
  await reader.invoke('status');
  return connectionResult('connected', target, status, ui, frames, options);
}

async function connectNativeFile({
  fileKey,
  targetId,
  pairingCode,
  restart = false,
  profile = 'default',
  widgetNodeId,
  expectedNativeBuild,
  expectedClient,
  beforeRestart,
  connect = () =>
    queuedDesktop({
      start: () =>
        ensureDesktop({ restart: true, install: true, beforeRestart }),
    }),
  activate = launchDesktop,
}) {
  if (!/^[A-Za-z0-9]{6,100}$/.test(fileKey || ''))
    throw new Error('Invalid Figma file key');
  if (expectedNativeBuild && !/^[a-f0-9]{64}$/.test(expectedNativeBuild))
    throw new Error('Invalid expected native build identity');
  const { pluginId } = profileInfo(profile);
  let connection;
  const session = {};
  try {
    connection = await connect();
    return await connectEditor(
      connection,
      {
        fileKey,
        targetId,
        pairingCode,
        restart,
        profile,
        widgetNodeId,
        expectedNativeBuild,
        expectedClient,
        pluginId,
        activate,
      },
      session,
    );
  } catch (error) {
    const ended = session.frames?.endedClients;
    if (ended?.length) error.endedClients = ended;
    if (session.widgetStarted) error.outcomeUnknown = true;
    else if (profile === 'widget') error.phase = 'preflight';
    throw error;
  } finally {
    if (connection) {
      await releaseEditor(connection, session);
      connection.close();
    }
  }
}
module.exports = { connectNativeFile };
