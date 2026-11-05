const {
  queuedDesktop,
  createPageReader,
  launchDesktop,
} = require('./desktop.cjs');
const { createEditorReader } = require('./editor-reader.js');
const { createNativeFrames } = require('./native-frames.cjs');
const { profileInfo } = require('./native-profiles.cjs');
const { parseFigmaUrl } = require('./targets.cjs');
const { BRIDGE_RUNTIME_VERSION } = require('../shared/core.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const target = await findEditor(connection, fileKey, targetId);
  const { sessionId } = await connection.call('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  session.id = sessionId;
  const frames = (session.frames = createNativeFrames(
    connection,
    sessionId,
    pluginId,
  ));
  const reader = (session.reader = await createPageReader(
    connection,
    sessionId,
    createEditorReader,
    'desktop_editor_unavailable',
    { pluginId },
  ));
  const status = await reader.invoke('status');
  if (parseFigmaUrl(status.url).fileKey !== fileKey)
    throw new Error('desktop_file_identity_changed');
  if (!status.editorLoaded) throw new Error('desktop_editor_not_ready');
  let ui = await frames.read();
  if (needsRestart(ui, restart, expectedNativeBuild)) {
    await frames.closeIdle(ui);
    ui = null;
  }
  let activatedEditor = false;
  if (!ui) {
    if (frames.busy()) throw new Error('desktop_native_operation_pending');
    if (profile === 'widget') {
      activatedEditor = await showWidgetEditor(reader, status, () =>
        activate(fileKey),
      );
      session.widgetStarted = true;
      const launched = await reader.invoke('startWidget', widgetNodeId);
      widgetNodeId ||= launched?.widgetNodeId;
    } else {
      const started = await startPlugin(reader, () => activate(fileKey));
      activatedEditor = started.activated;
    }
    ui = await frames.wait();
  }
  if (expectedNativeBuild && ui.nativeBuild !== expectedNativeBuild)
    throw new Error('desktop_native_build_mismatch');
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
  connect = queuedDesktop,
  activate = launchDesktop,
}) {
  if (!/^[A-Za-z0-9]{6,100}$/.test(fileKey || ''))
    throw new Error('Invalid Figma file key');
  if (expectedNativeBuild && !/^[a-f0-9]{64}$/.test(expectedNativeBuild))
    throw new Error('Invalid expected native build identity');
  const { pluginId } = profileInfo(profile);
  const connection = await connect(),
    session = {};
  try {
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
        pluginId,
        activate,
      },
      session,
    );
  } catch (error) {
    const ended = session.frames?.endedClients;
    if (ended?.length) error.endedClients = ended;
    if (
      session.widgetStarted &&
      !/^desktop_widget_(?:not_imported|not_permitted|identity_changed|schema_changed|insertion_rejected)$/.test(
        error.message,
      )
    )
      error.outcomeUnknown = true;
    throw error;
  } finally {
    session.frames?.close();
    await session.reader?.close().catch(() => {});
    if (session.id)
      await connection
        .call('Target.detachFromTarget', { sessionId: session.id })
        .catch(() => {});
    connection.close();
  }
}
module.exports = { connectNativeFile };
