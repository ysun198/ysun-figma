const path = require('node:path');
const { resolved } = require('./execution.cjs');
const {
  profileInfo,
  profiles,
  prepareWidget,
} = require('./native-profiles.cjs');
const problem = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode, phase: 'preflight' });

// The companion owns live client identities. This controller owns the interval
// in which Desktop or a file's native instance is being replaced.
function createDesktopCoordinator({
  execution,
  externalJobs,
  clients,
  catalog,
  activeClients,
  clientStatus,
  notifyChange,
  createPairing,
  releasePairing,
  expectedNativeBuild,
  launchDesktop = require('./desktop.cjs').launchDesktop,
  connectNative = require('./native-lifecycle.cjs').connectNativeFile,
}) {
  const nativeRecoveries = new Set();
  let desktopRecovering = false;
  function beforeDesktopRestart(ownedOperationId) {
    const observed = activeClients().map(({ id, instanceId }) => ({
      id,
      instanceId,
    }));
    if (
      desktopRecovering ||
      nativeRecoveries.size > 1 ||
      execution
        .unresolved()
        .some(
          (job) =>
            job.id !== ownedOperationId &&
            (['queued', 'running'].includes(job.status) ||
              (!resolved(job) &&
                observed.some(
                  (client) =>
                    client.id === job.target?.clientId &&
                    client.instanceId === job.target?.instanceId,
                ))),
        )
    )
      throw problem(
        409,
        'Finish or reconcile active operations before restarting Figma Desktop',
      );
    desktopRecovering = true;
    return {
      close(quit) {
        if (quit)
          for (const previous of observed) {
            const client = clients.get(previous.id);
            if (client?.instanceId === previous.instanceId)
              client.suspended = true;
          }
        desktopRecovering = false;
        notifyChange();
      },
    };
  }

  function launch({ fileKey }) {
    return launchDesktop(fileKey, { beforeRestart: beforeDesktopRestart });
  }

  async function connect({
    fileKey,
    targetId,
    clientId,
    profile = 'default',
    widgetNodeId,
    operationId,
    restart = false,
  }) {
    const { pluginId } = profileInfo(profile);
    if (
      profile === 'widget' &&
      !/^[A-Za-z0-9_-]{8,100}$/.test(operationId || '')
    )
      throw problem(
        400,
        'Widget connection can insert a widget; supply a stable operationId and an existing widgetNodeId when reconnecting',
      );
    async function recoverNativeSession() {
      const nativeClients = catalog
        .decorate(activeClients())
        .filter(
          (c) =>
            c.connected &&
            c.fileKey === fileKey &&
            c.pluginId === pluginId &&
            (!clientId || c.id === clientId),
        );
      if (nativeClients.length > 1)
        throw Object.assign(
          problem(409, 'Select the exact connected Figma client'),
          { code: 'FILE_AMBIGUOUS', clients: nativeClients },
        );
      const active = nativeClients[0];
      if (clientId && !active)
        throw problem(409, 'The requested Figma client is no longer connected');
      if (
        execution
          .unresolved()
          .some(
            (job) =>
              (profile !== 'widget' || job.id !== operationId) &&
              (job.target?.fileKey === fileKey ||
                job.target?.fileKeys?.includes(fileKey) ||
                job.target?.clientId === active?.id) &&
              !resolved(job),
          )
      )
        throw problem(
          409,
          'Finish or reconcile original operations before recovering the native plugin',
        );
      const pairing = createPairing();
      let result;
      try {
        result = await connectNative({
          fileKey,
          targetId,
          profile,
          widgetNodeId,
          pairingCode: pairing.code,
          ...(clientId ? { expectedClient: active } : {}),
          beforeRestart: () =>
            beforeDesktopRestart(
              profile === 'widget' ? operationId : undefined,
            ),
          restart: restart || !!active?.needsPluginUpdate,
          ...(expectedNativeBuild ? { expectedNativeBuild } : {}),
        });
        retireNativeClients(result.endedClients);
      } catch (error) {
        retireNativeClients(error.endedClients);
        throw error;
      } finally {
        releasePairing(pairing.code);
      }
      const client = clients.get(result.native?.clientId);
      if (
        !client ||
        client.instanceId !== result.native.instanceId ||
        client.documentId !== result.native.documentId ||
        !clientStatus(client).connected
      )
        throw Object.assign(
          problem(409, 'Native lifecycle identity changed before binding'),
          { outcomeUnknown: profile === 'widget' },
        );
      catalog.bind(
        {
          fileKey,
          clientId: client.id,
          documentId: client.documentId,
          verifiedUrl: result.verifiedUrl,
        },
        activeClients(),
      );
      notifyChange();
      return { ...result, clientId: client.id };
    }
    async function recoverNative() {
      if (nativeRecoveries.has(fileKey))
        throw problem(
          409,
          'Native connection recovery is already in progress for this file',
        );
      nativeRecoveries.add(fileKey);
      try {
        return await recoverNativeSession();
      } finally {
        nativeRecoveries.delete(fileKey);
      }
    }
    if (profile !== 'widget') return recoverNative();
    const record = await externalJobs.run({
      id: operationId,
      kind: 'widget-connect',
      accountId: catalog.view().accountId || 'desktop',
      fileKey,
      source: 'Connect native Widget API',
      args: {
        fileKey,
        targetId,
        widgetNodeId,
        restart,
        ...(clientId ? { clientId } : {}),
      },
      readOnly: false,
      perform: async () => ({ ...(await recoverNative()), ok: true }),
    });
    return { ...(record.job.result?.value || {}), ...record };
  }

  function retireNativeClients(endedClients = []) {
    for (const ended of endedClients) {
      const previous = clients.get(ended.clientId);
      if (
        previous?.instanceId !== ended.instanceId ||
        previous.pluginId !== ended.pluginId
      )
        continue;
      previous.suspended = true;
      execution.endInstance(
        previous.id,
        'the original native iframe ended during a profile change; this instance cannot receive new operations',
      );
    }
    if (endedClients.length) notifyChange();
  }

  function prepare({ profile, sourcePath }) {
    if (profile !== 'widget' || typeof sourcePath !== 'string')
      throw problem(
        400,
        'prepare requires profile=widget and an absolute sourcePath',
      );
    const ids = new Set(
      activeClients()
        .filter((c) => c.pluginId === profiles.widget.pluginId)
        .map((c) => c.id),
    );
    if (
      execution
        .unresolved()
        .some((job) => ids.has(job.target?.clientId) && !resolved(job))
    )
      throw problem(
        409,
        'Finish or reconcile Widget operations before replacing its local render module',
      );
    return prepareWidget(sourcePath, path.resolve(__dirname, '../..'));
  }

  function recovering(target) {
    return (
      desktopRecovering ||
      [target.fileKey, ...(target.fileKeys || [])].some((key) =>
        nativeRecoveries.has(key),
      )
    );
  }
  return { launch, connect, prepare, recovering };
}
module.exports = { createDesktopCoordinator };
