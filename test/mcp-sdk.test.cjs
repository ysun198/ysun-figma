const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');

test('the official MCP client negotiates with the packaged stdio server and validates real structured results', async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ysun-mcp-sdk-'));
  const client = new Client({ name: 'reference-client', version: '1' });
  t.after(async () => {
    await client.close();
    fs.rmSync(state, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '../build/plugin/src/host/mcp.cjs')],
      env: { FIGMA_PLUGIN_STATE_DIR: state },
    }),
  );
  assert.equal(
    client.getServerVersion().version,
    require('../package.json').version,
  );
  await client.ping();
  const listing = await client.listTools();
  const names = listing.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert(listing.tools.every((tool) => tool.outputSchema));
  const run = listing.tools.find((tool) => tool.name === 'figma_run');
  const help = await client.callTool({
    name: 'figma_api',
    arguments: { query: run.name },
  });
  assert.deepEqual(help.structuredContent.tool, run);
  const catalog = await client.callTool({
    name: 'figma_rest',
    arguments: { action: 'list' },
  });
  assert.equal(catalog.structuredContent.total, 76);
  const invalid = await client.callTool({
    name: 'figma_file',
    arguments: {
      action: 'open',
      fileKey: 'OtherKey12',
      figmaUrl: 'https://www.figma.com/design/ValidKey12',
    },
  });
  assert(invalid.isError);
  assert.equal(invalid.structuredContent.phase, 'preflight');
  assert.deepEqual(fs.readdirSync(state), []);
});
