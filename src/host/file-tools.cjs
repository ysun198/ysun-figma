const {
  parseFigmaUrl,
  matchingClients,
  resolveTarget,
} = require('./targets.cjs');
const { DESKTOP_SETUP_TIMEOUT_MS } = require('./desktop-app.cjs');
const { submitOperation } = require('./bridge-client.cjs');

async function connectDesktop(input, request) {
  const body = {
    fileKey: input.fileKey,
    targetId: input.targetId,
    clientId: input.clientId,
    profile: input.profile,
    widgetNodeId: input.widgetNodeId,
    operationId: input.operationId,
    restart: input.restart,
  };
  const route = '/v1/desktop/connect';
  const result =
    input.profile === 'widget'
      ? await submitOperation(request, route, body, DESKTOP_SETUP_TIMEOUT_MS)
      : await request(route, {
          method: 'POST',
          body: JSON.stringify(body),
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

function fileRequest(input) {
  if (
    input.widgetNodeId &&
    (input.profile !== 'widget' || !['open', 'connect'].includes(input.action))
  )
    throw new Error('widgetNodeId requires opening or connecting a Widget');
  if (
    input.profile === 'widget' &&
    ['open', 'connect'].includes(input.action) &&
    !input.operationId
  )
    throw new Error('Supply a stable operationId when connecting a Widget');
  if (!input.figmaUrl && !input.verifiedUrl) return input;
  if (
    input.figmaUrl &&
    !['open', 'connect', 'status', 'launch'].includes(input.action)
  )
    throw new Error('figmaUrl requires open, connect, status or launch');
  const link = parseFigmaUrl(input.figmaUrl || input.verifiedUrl);
  if (
    (input.fileKey && input.fileKey !== link.fileKey) ||
    (input.verifiedUrl &&
      parseFigmaUrl(input.verifiedUrl).fileKey !== link.fileKey)
  )
    throw new Error('Conflicting Figma file keys');
  return { ...input, fileKey: input.fileKey || link.fileKey };
}

async function openFile(
  input,
  { request, launchDesktop, directory, connection },
) {
  const { fileKey } = input;
  if (!fileKey)
    throw new Error('Provide a Figma URL or fileKey to open a file.');
  const state = connection?.status || (await request('/v1/status?summary=1'));
  const target = {
    fileKey,
    profile: input.profile || 'default',
    ...(input.clientId ? { clientId: input.clientId } : {}),
  };
  const describe = async () => {
    const result = await directory();
    return {
      ...result,
      file: result.files[0] || {
        fileKey,
        url:
          input.figmaUrl ||
          input.verifiedUrl ||
          'https://www.figma.com/design/' + fileKey,
      },
    };
  };
  if (input.clientId || matchingClients(target, state.clients).length) {
    const selected = resolveTarget(target, state.clients);
    const client = state.clients.find(
      (client) => client.id === selected.clientId,
    );
    if (
      !client.needsPluginUpdate &&
      !input.restart &&
      !input.targetId &&
      !input.widgetNodeId
    )
      return {
        state: 'connected',
        clientId: selected.clientId,
        targeting: selected.targeting,
        ...(await describe()),
      };
  } else await launchDesktop(fileKey);
  return connectAndDescribe(input, request, describe);
}

async function callFile(input, { request, launchDesktop, connection }) {
  if (input.action === 'launch') return launchDesktop(input.fileKey);
  const directory = () =>
    request(
      input.fileKey
        ? '/v1/files?fileKey=' + encodeURIComponent(input.fileKey)
        : '/v1/files',
    );
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
      return openFile(input, { request, launchDesktop, directory, connection });
  }
}

module.exports = { callFile, fileRequest };
