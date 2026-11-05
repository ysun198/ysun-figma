const { runtimeResult } = require('./desktop.cjs');
const { profiles } = require('./native-profiles.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This tracker owns its frame subscription. The caller owns the Desktop
// connection and editor session, including their cleanup.
function createNativeFrames(connection, sessionId, pluginId) {
  const ownedIds = Object.values(profiles).map((p) => p.pluginId);
  const contexts = new Set(),
    observed = new Map(),
    ended = new Map();
  function end(contextId) {
    contexts.delete(contextId);
    const peer = observed.get(contextId);
    if (peer)
      ended.set(peer.instanceId, {
        clientId: peer.clientId,
        instanceId: peer.instanceId,
        pluginId: peer.pluginId,
      });
  }
  const unsubscribe = connection.onEvent?.((event) => {
    if (event.sessionId !== sessionId) return;
    if (
      event.method === 'Runtime.executionContextCreated' &&
      event.params.context.auxData?.isDefault
    )
      contexts.add(event.params.context.id);
    if (event.method === 'Runtime.executionContextDestroyed')
      end(event.params.executionContextId);
    if (event.method === 'Runtime.executionContextsCleared')
      for (const id of [...contexts]) end(id);
  });
  async function evaluate(ui, expression, options = {}) {
    const { timeoutMs, isolatedTimeout, awaitPromise } = options;
    return runtimeResult(
      await connection.call(
        'Runtime.evaluate',
        {
          contextId: ui.contextId,
          expression,
          returnByValue: true,
          ...(awaitPromise ? { awaitPromise: true } : {}),
        },
        sessionId,
        { timeoutMs, isolatedTimeout },
      ),
    ).value;
  }
  async function read() {
    const found = [];
    for (const contextId of [...contexts]) {
      try {
        const value = await evaluate(
          { contextId },
          '(()=>{const owned=globalThis.__ysunFigmaLifecycle?.identity?.() || (typeof direct!=="undefined"&&' +
            JSON.stringify(ownedIds) +
            '.includes(direct.context?.pluginId)' +
            '?{legacy:true,clientId:direct.clientId,instanceId:direct.instanceId,documentId:direct.context.documentId,pluginId:direct.context.pluginId,connected:!!direct.token,busy:!!direct.pending||!!direct.blockedJobId,closed:direct.closed}:null);return owned&&typeof direct!=="undefined"?{...owned,runtimeVersion:direct.context?.runtimeVersion,nativeBuild:direct.context?.nativeBuild}:owned})()',
          { timeoutMs: 1000, isolatedTimeout: true },
        );
        if (!ownedIds.includes(value?.pluginId) || value.closed) continue;
        observed.set(contextId, value);
        if (value.pluginId === pluginId) found.push({ contextId, ...value });
      } catch {}
    }
    if (found.length > 1) throw new Error('desktop_native_frame_ambiguous');
    return found[0] || null;
  }
  async function closeIdle(ui) {
    if (ui.busy) throw new Error('desktop_native_operation_pending');
    const closed = await evaluate(
      ui,
      ui.legacy
        ? '(()=>{if(direct.pending||direct.blockedJobId||typeof closePlugin!=="function")return false;closePlugin();return true})()'
        : 'globalThis.__ysunFigmaLifecycle.closeIdle()',
    );
    if (!closed) throw new Error('desktop_native_operation_pending');
    await pause(100);
  }
  async function wait() {
    const deadline = Date.now() + 15000;
    do {
      const ui = await read();
      if (ui) return ui;
      await pause(100);
    } while (Date.now() < deadline);
    throw new Error('desktop_native_lifecycle_unavailable');
  }
  async function authorize(ui, pairingCode) {
    if (ui.connected) {
      // A saved iframe token is not evidence of a current broker session.
      await evaluate(
        ui,
        '(async()=>{if(typeof heartbeat!=="function")return false;const deadline=Date.now()+5000;while(direct.heartbeatBusy&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));await heartbeat();return true})()',
        { timeoutMs: 8000, awaitPromise: true },
      );
      ui = (await read()) || ui;
    }
    if (ui.connected) return ui;
    // Saved grants restore before a genuinely new pairing is attempted.
    const deadline = Date.now() + 2000;
    while (!ui.connected && Date.now() < deadline) {
      await pause(100);
      ui = (await read()) || ui;
    }
    if (ui.connected || !pairingCode) return ui;
    const paired = await evaluate(
      ui,
      'globalThis.__ysunFigmaLifecycle.pair(' +
        JSON.stringify(pairingCode) +
        ')',
      { awaitPromise: true },
    );
    if (!paired) throw new Error('desktop_native_pairing_failed');
    return read();
  }
  return {
    read,
    wait,
    closeIdle,
    authorize,
    busy: () =>
      [...observed].some(([id, peer]) => contexts.has(id) && peer.busy),
    get endedClients() {
      return [...ended.values()];
    },
    close: () => unsubscribe?.(),
  };
}
module.exports = { createNativeFrames };
