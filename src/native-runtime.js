// Figma owns the canvas; this host only runs native scripts and connection UI.
function startNativePlugin() {
  let executing = false,
    awaitingReceipt = false,
    savedConnection = null;
  let storageTask = Promise.resolve();
  let documentRevision = 0;
  let documentId = figma.root.getPluginData('figmaPluginDocumentId');
  const context = () => ({
    fileName: figma.root.name,
    fileKey: figma.fileKey || '',
    editorType: figma.editorType,
    pageName: figma.currentPage.name,
    pageId: figma.currentPage.id,
    selection: figma.currentPage.selection.slice(0, 100).map((node) => node.id),
    pluginId: figma.pluginId || '',
    documentId,
    runtimeVersion: BRIDGE_RUNTIME_VERSION,
    nativeBuild:
      typeof FIGMA_PLUGIN_BUILD === 'string' ? FIGMA_PLUGIN_BUILD : undefined,
    documentRevision,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
  });
  const sendContext = () =>
    figma.ui.postMessage({ type: 'CONTEXT', ...context() });
  figma.showUI(__html__, {
    width: 360,
    height: 280,
    themeColors: true,
    visible: false,
  });
  figma.on('selectionchange', sendContext);
  const watchedPages = new Set();
  const changed = () => {
    documentRevision++;
    sendContext();
  };
  async function watchPage(page) {
    if (!page || watchedPages.has(page.id)) return;
    await page.loadAsync();
    page.on('nodechange', changed);
    watchedPages.add(page.id);
  }
  // Page events work in dynamic-page mode. Loading every account-sized page
  // just to register documentchange would delay launch and consume memory.
  figma.on('currentpagechange', () => {
    sendContext();
    void watchPage(figma.currentPage).catch(() => {});
  });
  void watchPage(figma.currentPage).catch(() => {});
  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'UI_READY') {
      try {
        if (documentId)
          savedConnection = await figma.clientStorage.getAsync(
            'connection:' + documentId,
          );
      } catch (_) {
        /* First pairing remains available if local storage is unavailable. */
      }
      figma.ui.postMessage({
        type: 'READY',
        ...context(),
        connection: savedConnection,
      });
    }
    if (message.type === 'GET_CONTEXT') sendContext();
    if (message.type === 'SAVE_CONNECTION') {
      storageTask = (async () => {
        try {
          documentId = documentId || message.documentId;
          if (!/^[a-f0-9]{32}$/.test(documentId || ''))
            throw new Error('invalid document identity');
          await figma.clientStorage.setAsync(
            'connection:' + documentId,
            message.connection,
          );
          figma.root.setPluginData('figmaPluginDocumentId', documentId);
          savedConnection = message.connection;
        } catch (error) {
          figma.ui.postMessage({
            type: 'STORAGE_ERROR',
            message: formatBridgeError(error),
          });
        }
      })();
      await storageTask;
    }
    if (message.type === 'CLEAR_CONNECTION' && documentId) {
      storageTask = figma.clientStorage.deleteAsync('connection:' + documentId);
      await storageTask;
      savedConnection = null;
    }
    if (message.type === 'RUN_JOB') {
      if (executing || awaitingReceipt) {
        figma.ui.postMessage({
          type: 'ERROR',
          requestId: message.requestId,
          message: 'An operation or receipt is still pending.',
        });
        return;
      }
      executing = true;
      awaitingReceipt = true;
      try {
        if (message.kind !== 'exec')
          throw new Error('Only native scripts are supported.');
        figma.ui.postMessage({
          type: 'APPLYING',
          requestId: message.requestId,
        });
        const result = await executeScript(
          message.source,
          message.args,
          message.assets,
          { ...message.options, documentId, documentRevision },
        );
        // Reads can load additional pages. Observe those too, so manual edits
        // invalidate their previews without changing the user's active page.
        for (const page of figma.root.children) {
          try {
            // Reading children creates native wrappers for every root. Probe only
            // unobserved pages; an accessible empty array is also a loaded page.
            if (!watchedPages.has(page.id) && page.children)
              await watchPage(page);
          } catch (_) {
            /* Unloaded pages remain lazy. */
          }
        }
        if (message.options?.readOnly !== true) documentRevision++;
        figma.ui.postMessage({
          type: 'APPLIED',
          requestId: message.requestId,
          result,
          context: context(),
        });
      } catch (error) {
        if (message.options?.readOnly !== true) documentRevision++;
        figma.ui.postMessage({
          type: 'ERROR',
          requestId: message.requestId,
          outcomeUnknown: error.outcomeUnknown === true,
          message: formatBridgeError(error),
          result: error.receipt,
          context: context(),
        });
      } finally {
        executing = false;
      }
    }
    if (message.type === 'RECEIPT_DELIVERED') awaitingReceipt = false;
    if (message.type === 'CLOSE') {
      await storageTask;
      if (executing || awaitingReceipt) {
        figma.notify(
          'Wait for the operation and result delivery before closing.',
        );
        return;
      }
      figma.closePlugin();
    }
    if (message.type === 'SHOW_UI') figma.ui.show();
    if (message.type === 'HIDE_UI') figma.ui.hide();
  };
}
if (typeof figma !== 'undefined') startNativePlugin();
