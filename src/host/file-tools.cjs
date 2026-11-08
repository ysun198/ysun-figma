const {
  parseFigmaUrl,
  matchingClients,
  resolveTarget,
} = require('./targets.cjs');
const { DESKTOP_SETUP_TIMEOUT_MS } = require('./desktop-app.cjs');

async function connectDesktop(input, request) {
  const result = await request('/v1/desktop/connect', {
    method: 'POST',
    body: JSON.stringify({
      fileKey: input.fileKey,
      targetId: input.targetId,
      profile: input.profile,
      widgetNodeId: input.widgetNodeId,
      operationId: input.operationId,
      restart: input.restart,
    }),
    timeoutMs: DESKTOP_SETUP_TIMEOUT_MS,
  });
  if (result.job && ['failed', 'outcome_unknown'].includes(result.job.status))
    throw Object.assign(new Error(result.job.error), {
      phase: 'execution',
      receipt: result,
    });
  return result;
}

async function connectAndDescribe(input, request, describe) {
  const result = await connectDesktop(input, request);
  try {
    return { ...result, ...(await describe()) };
  } catch (error) {
    if (result.job) {
      error.phase = 'delivery';
      error.receipt = result;
    }
    throw error;
  }
}

async function openFile(input, { request, launchDesktop, directory }) {
  const catalog = await request('/v1/catalog');
  if (!input.fileKey) throw new Error('fileKey is required to open a file.');
  if (
    input.verifiedUrl &&
    parseFigmaUrl(input.verifiedUrl).fileKey !== input.fileKey
  )
    throw new Error('verifiedUrl does not match fileKey.');
  const file = catalog.files.find((file) => file.fileKey === input.fileKey) || {
    fileKey: input.fileKey,
    url: input.verifiedUrl || 'https://www.figma.com/design/' + input.fileKey,
  };
  if (input.action === 'launch') return launchDesktop(file.fileKey);
  const state = await request('/v1/status?summary=1');
  const target = {
    fileKey: file.fileKey,
    profile: input.profile || 'default',
    ...(input.clientId ? { clientId: input.clientId } : {}),
  };
  if (input.clientId || matchingClients(target, state.clients).length) {
    const selected = resolveTarget(target, state.clients);
    const client = state.clients.find(
      (client) => client.id === selected.clientId,
    );
    if (client.needsPluginUpdate || input.restart)
      return connectAndDescribe({ ...input, ...target }, request, async () => ({
        file,
        ...(await directory()),
      }));
    return {
      state: 'connected',
      file,
      clientId: selected.clientId,
      targeting: selected.targeting,
      ...(await request('/v1/files')),
    };
  }
  await launchDesktop(file.fileKey);
  return connectAndDescribe(
    { ...input, fileKey: file.fileKey },
    request,
    async () => ({
      file,
      ...(await request('/v1/files')),
    }),
  );
}

async function callFile(input, { request, launchDesktop }) {
  if (input.action === 'launch' && !input.fileKey) return launchDesktop();
  const directory = async () => {
    const result = await request('/v1/files');
    return input.fileKey
      ? {
          ...result,
          files: result.files.filter((file) => file.fileKey === input.fileKey),
        }
      : result;
  };
  switch (input.action) {
    case 'prepare':
      return {
        ...(await request('/v1/native-profile', {
          method: 'POST',
          body: JSON.stringify(input),
        })),
        ...(await directory()),
      };
    case 'connect':
      if (!input.fileKey)
        throw new Error('fileKey is required for direct native connection');
      return connectAndDescribe(input, request, directory);
    case 'status':
      return {
        ...(await directory()),
        desktop: await request(
          '/v1/desktop/files?' +
            new URLSearchParams(
              input.fileKey ? { fileKey: input.fileKey } : {},
            ),
          { timeoutMs: 60000 },
        ),
      };
    case 'sync':
      await request('/v1/catalog/sync', {
        method: 'POST',
        body: '{"force":true}',
      });
      return {
        ...(await request('/v1/files')),
        next: 'Account sync reuses Figma Desktop login and never quits a running editor. If desktop_required or desktop_restart_required, use figma_file(action="launch") to prepare the complete app, stable registrations and normal restart, then sync. A pending save prompt is not forced. If login_required, complete ordinary Figma sign-in; no REST token, cookie copying or Keychain password is required.',
      };
    case 'bind':
      await request('/v1/catalog/bind', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return request('/v1/files');
    default:
      return openFile(input, { request, launchDesktop, directory });
  }
}

module.exports = { callFile };
