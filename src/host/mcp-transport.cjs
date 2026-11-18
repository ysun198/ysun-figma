const fs = require('node:fs');
const path = require('node:path');
const { isRecord } = require('./mcp-contract.cjs');
const { frameReader } = require('./framing.cjs');

function serve(input = process.stdin, output = process.stdout) {
  let phase = 'new';
  const pending = new Map();
  let closed = false;
  const resumeInput = () => {
    if (!closed) input.resume();
  };
  function send(message) {
    if (closed) return;
    if (!output.write(JSON.stringify(message) + '\n')) input.pause();
  }
  output.on('drain', resumeInput);
  let runtime, updateWatch;
  function currentRuntime() {
    runtime ||= require('./mcp.cjs');
    let observed;
    try {
      observed = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
      ).version;
    } catch (error) {
      if (error.code === 'ENOENT') return runtime;
      throw error;
    }
    if (observed === runtime.version) return runtime;
    // Managed promotion replaces the one current package atomically. Keep the
    // host's stdio transport alive and discard only this package's module cache.
    const root = path.resolve(__dirname, '../..') + path.sep;
    for (const id of Object.keys(require.cache))
      if (id.startsWith(root)) delete require.cache[id];
    runtime = require('./mcp.cjs');
    if (phase === 'ready') {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    return runtime;
  }
  function notification(message) {
    if (
      message.method === 'notifications/initialized' &&
      phase === 'initializing'
    ) {
      phase = 'ready';
      const packageRoot = path.resolve(__dirname, '../..');
      const report = (error) =>
        process.stderr.write('Update discovery: ' + error.message + '\n');
      try {
        // Managed updates atomically replace packageRoot; watch its stable parent.
        updateWatch = fs.watch(
          path.dirname(packageRoot),
          { persistent: false },
          (_event, name) => {
            if (!name || name.toString() === path.basename(packageRoot))
              try {
                currentRuntime();
              } catch (error) {
                report(error);
              }
          },
        );
        updateWatch.on('error', report);
      } catch (error) {
        report(error);
      }
    }
    if (message.method === 'notifications/cancelled')
      pending.get(message.params && message.params.requestId)?.abort();
  }
  function initialize(api, params) {
    if (phase !== 'new')
      throw Object.assign(new Error('already initialized'), {
        code: -32600,
      });
    if (
      typeof params?.protocolVersion !== 'string' ||
      typeof params.clientInfo?.name !== 'string' ||
      typeof params.clientInfo?.version !== 'string' ||
      !isRecord(params.capabilities)
    )
      throw Object.assign(new Error('invalid initialize parameters'), {
        code: -32602,
      });
    phase = 'initializing';
    return {
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: true } },
      serverInfo: {
        name: 'figma-plugin-local',
        title: 'ysun figma',
        version: api.version,
      },
      instructions:
        'Open a Figma link with figma_file(action="open", figmaUrl=...). Reuse its exact clientId for native reads and edits. Discover operations offline with figma_api(query=...) or figma_api(workflow=...). Prefer one native read/compute/write. For a decision based on earlier reads, pass figma_snapshot receipt IDs in ifUnchanged. Use one stable operationId per edit and check figma_job after interruption. Use figma_export for original files.',
    };
  }
  async function toolResult(api, params, signal) {
    if (
      typeof params?.name !== 'string' ||
      (params.arguments !== undefined && !isRecord(params.arguments))
    )
      throw Object.assign(new Error('invalid tools/call parameters'), {
        code: -32602,
      });
    try {
      const value = await api.callTool(
        params?.name,
        params?.arguments || {},
        signal,
      );
      return {
        content: [
          { type: 'text', text: JSON.stringify(value) },
          ...(value[api.images] || []),
        ],
        structuredContent: value,
        isError: false,
      };
    } catch (error) {
      if (error.code === -32602) throw error;
      const value = api.toolError(error, params?.arguments);
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
        isError: true,
      };
    }
  }
  function request(api, message, signal) {
    if (message.params !== undefined && !isRecord(message.params))
      throw Object.assign(new Error('invalid request parameters'), {
        code: -32602,
      });
    if (message.method === 'initialize') return initialize(api, message.params);
    if (message.method === 'ping') return {};
    if (phase !== 'ready')
      throw Object.assign(new Error('initialize first'), { code: -32000 });
    if (message.method === 'tools/list') return { tools: api.tools };
    if (message.method === 'tools/call')
      return toolResult(api, message.params, signal);
    throw Object.assign(new Error('Method not found'), { code: -32601 });
  }
  function validRequest(message) {
    return (
      message &&
      !Array.isArray(message) &&
      message.jsonrpc === '2.0' &&
      typeof message.method === 'string' &&
      (!Object.hasOwn(message, 'id') ||
        ['number', 'string'].includes(typeof message.id))
    );
  }
  async function handle(message) {
    if (!validRequest(message)) {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }
    if (!Object.hasOwn(message, 'id')) {
      notification(message);
      return;
    }
    if (pending.has(message.id)) {
      send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'A request with this ID is still in progress',
        },
      });
      return;
    }
    const controller = new AbortController();
    pending.set(message.id, controller);
    try {
      const result = await request(
        currentRuntime(),
        message,
        controller.signal,
      );
      if (!controller.signal.aborted)
        send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (!controller.signal.aborted)
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: Number.isInteger(error.code) ? error.code : -32603,
            message: error.message,
          },
        });
    } finally {
      pending.delete(message.id);
    }
  }
  input.on(
    'data',
    frameReader(
      10,
      6 * 1024 * 1024,
      (bytes) => {
        const line = bytes.toString('utf8');
        if (!line.trim()) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          send({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
          return;
        }
        void handle(message);
      },
      () =>
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Message exceeds 6 MiB' },
        }),
    ),
  );
  const stop = () => {
    closed = true;
    output.off('drain', resumeInput);
    updateWatch?.close();
    for (const controller of pending.values()) controller.abort();
  };
  for (const event of ['end', 'close', 'error']) input.once(event, stop);
  for (const event of ['close', 'error']) output.once(event, stop);
}
module.exports = { serve };
