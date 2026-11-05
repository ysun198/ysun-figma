const fs = require('node:fs');
const path = require('node:path');
const { isRecord } = require('./mcp-contract.cjs');

function serve(input = process.stdin, output = process.stdout) {
  let buffer = '',
    phase = 'new';
  const pending = new Map();
  const send = (message) => output.write(JSON.stringify(message) + '\n');
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
        'Use ysun-figma skills in this conversation. For first installation or missing local tools, use the packaged ysun-figma-setup skill; figma_api(workflow="setup") works offline once Node is available. Ordinary connection uses figma_file open/connect with an exact fileKey, without a manual pairing code. Confirm exact file/client with figma_status; reuse one native client per file across tasks, never bind by title. Choose native capabilities from desired behavior without asking the user to name features. figma_api workflows give guides: edit for coherent or conditional edits, motion for timed animation, prototype for interactions, handoff for code. Prefer one live read/compute/write. When a decision spans tool calls, figma_snapshot its dependent fields and pass job.id as ifUnchanged; pin rootId rather than currentPage. On conflict re-read and merge; the body did not run. Keep one operationId per edit. After interruption inspect original figma_job and reconcile uncertain writes; repair delivery from original output. Use native MCP for edits/navigation/exports, GUI only for uncovered lifecycle or actual interactions. Sparse/truncated reads are incomplete; cloud-only services remain separate.',
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
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 6 * 1024 * 1024) {
      input.destroy();
      process.exitCode = 1;
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        continue;
      }
      void handle(message);
    }
  });
  const stop = () => {
    updateWatch?.close();
    for (const controller of pending.values()) controller.abort();
  };
  for (const event of ['end', 'close', 'error']) input.once(event, stop);
}
module.exports = { serve };
