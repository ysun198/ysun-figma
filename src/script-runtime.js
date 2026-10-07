// Trusted local scripts run in Figma's native plugin sandbox, with its full API.
// This is not a security sandbox inside the plugin or a transaction emulator.
/* exported executeScript */
const MAX_SCRIPT_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
function encodeScriptValue(value) {
  const seen = new Set();
  function visit(item, depth) {
    if (depth > 32)
      throw new Error(
        'result is too deeply nested; return selected properties and node IDs',
      );
    if (item === undefined || item === null) return null;
    if (typeof item === 'number') {
      if (!Number.isFinite(item))
        throw new Error('result contains a non-finite number');
      return item;
    }
    if (typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item !== 'object')
      throw new Error(
        'result must contain JSON values, native node references or bytes',
      );
    if (item instanceof Uint8Array)
      return { type: 'bytes', base64: figma.base64Encode(item) };
    if (
      typeof item.id === 'string' &&
      typeof item.type === 'string' &&
      typeof item.remove === 'function'
    )
      return { id: item.id, type: item.type, name: item.name };
    if (seen.has(item))
      throw new Error('result contains a cycle; return node IDs instead');
    seen.add(item);
    const output = Array.isArray(item)
      ? item.map((child) => visit(child, depth + 1))
      : Object.fromEntries(
          Object.keys(item).map((key) => [key, visit(item[key], depth + 1)]),
        );
    seen.delete(item);
    return output;
  }
  return visit(value, 0);
}
async function executeScript(source, args = {}, assets = {}, options = {}) {
  if (typeof source !== 'string' || !source.trim())
    throw new Error('script source is required');
  // Compile before entering user code: syntax errors cannot have mutated the file.
  const run = new Function(
    'figma',
    'bridge',
    'args',
    'console',
    '"use strict"; return (async () => {\n' + source + '\n})();',
  );
  const exports = [],
    logs = [];
  const logLimits = {
    maxEntries: 100,
    maxMessageCharacters: 2000,
    droppedEntries: 0,
    truncatedMessages: 0,
  };
  let exportBytes = 0;
  const bridge = {
    assets,
    operationId: options.operationId || null,
    documentId: options.documentId || null,
    documentRevision: options.documentRevision ?? null,
    query(name, input) {
      const queries = createDesignQueries(figma, bridge, scriptConsole.log);
      if (!Object.hasOwn(queries, name))
        throw new Error('Unknown native query: ' + name);
      return queries[name](input);
    },
    assetText(name) {
      const bytes = assets[name];
      if (!bytes || bytes.length > 1024 * 1024)
        throw new Error('Text assets must be present and at most 1 MiB');
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        text += String.fromCharCode(...bytes.slice(offset, offset + 8192));
      return decodeURIComponent(escape(text));
    },
    set(node, properties) {
      if (!node || !properties || typeof properties !== 'object')
        throw new Error('bridge.set requires a node and properties');
      const { width, height, layoutMode, ...rest } = properties;
      if (layoutMode !== undefined) node.layoutMode = layoutMode;
      if (width !== undefined || height !== undefined)
        node.resize(width ?? node.width, height ?? node.height);
      for (const [key, value] of Object.entries(rest)) node[key] = value;
      return node;
    },
    autoLayout(direction = 'VERTICAL', properties = {}) {
      if (!['VERTICAL', 'HORIZONTAL'].includes(direction))
        throw new Error('Choose VERTICAL or HORIZONTAL');
      return bridge.set(figma.createFrame(), {
        layoutMode: direction,
        primaryAxisSizingMode: 'AUTO',
        counterAxisSizingMode: 'AUTO',
        ...properties,
      });
    },
    async loadFonts(text) {
      const target = text?.text || text;
      if (
        !target ||
        !('fontName' in target) ||
        typeof target.getRangeAllFontNames !== 'function'
      )
        throw new Error('Choose native text or a node with a text sublayer');
      const fonts = target.characters.length
        ? target.getRangeAllFontNames(0, target.characters.length)
        : target.fontName === figma.mixed
          ? []
          : [target.fontName];
      for (const font of new Map(
        fonts.map((font) => [JSON.stringify(font), font]),
      ).values())
        await figma.loadFontAsync(font);
    },
    async screenshot(node, { maxDimension = 1600 } = {}) {
      return bridge.query('screenshot', { nodeId: node.id, maxDimension });
    },
    exportFile(name, bytes, mimeType = 'application/octet-stream') {
      if (
        !validArtifactName(name) ||
        exports.some((file) => file.name === name)
      )
        throw new Error(
          'export requires a unique filename of 1–120 letters, numbers, spaces, dots, underscores or hyphens: ' +
            name,
        );
      if (!(bytes instanceof Uint8Array) || typeof mimeType !== 'string')
        throw new Error('exportFile expects Uint8Array bytes and a MIME type');
      exportBytes += bytes.length;
      if (exportBytes > MAX_EXPORT_BYTES)
        throw new Error(
          'exports exceed 32 MiB; export smaller nodes or use a lower scale',
        );
      exports.push({ name, mimeType, size: bytes.length, bytes });
    },
  };
  const scriptConsole = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map((level) => [
      level,
      (...items) => {
        if (logs.length >= logLimits.maxEntries) {
          logLimits.droppedEntries++;
          return;
        }
        const message = items
          .map((item) => {
            try {
              return typeof item === 'string'
                ? item
                : JSON.stringify(encodeScriptValue(item));
            } catch (_) {
              return String(item);
            }
          })
          .join(' ');
        const truncated = message.length > logLimits.maxMessageCharacters;
        if (truncated) logLimits.truncatedMessages++;
        logs.push({
          level,
          message: message.slice(0, logLimits.maxMessageCharacters),
          ...(truncated ? { truncated: true } : {}),
        });
      },
    ]),
  );
  const startedAt = Date.now();
  try {
    const value = await run(figma, bridge, args, scriptConsole);
    const receipt = {
      operationId: bridge.operationId,
      editorType: figma.editorType,
      apiVersion: figma.apiVersion,
      elapsedMs: Date.now() - startedAt,
      value: encodeScriptValue(value),
      logs,
      logLimits,
      exports,
    };
    // Count actual UTF-8 bytes without relying on TextEncoder in the native VM.
    if (
      unescape(
        encodeURIComponent(
          JSON.stringify({
            ...receipt,
            exports: exports.map(({ bytes, ...file }) => file),
          }),
        ),
      ).length > MAX_SCRIPT_RESULT_BYTES
    )
      throw new Error(
        'script result exceeds 4 MiB; return a smaller projection',
      );
    if (options.commitUndo !== false) figma.commitUndo();
    return receipt;
  } catch (error) {
    // Native scripts can mutate arbitrary pre-existing nodes. Never claim rollback
    // or automatically undo edits that might include concurrent user work.
    const failure = new Error(
      'script: ' +
        formatBridgeError(error) +
        (options.readOnly === true
          ? ''
          : '; execution started, inspect the file before another write'),
    );
    failure.outcomeUnknown = options.readOnly !== true;
    failure.receipt = {
      operationId: bridge.operationId,
      editorType: figma.editorType,
      apiVersion: figma.apiVersion,
      elapsedMs: Date.now() - startedAt,
      logs,
      logLimits,
      exports,
      ...(error.queryDiagnostics
        ? { queryDiagnostics: error.queryDiagnostics }
        : {}),
    };
    throw failure;
  }
}
