const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readConnection, bridgeRequest } = require('./bridge-client.cjs');
const { bridgeStateDirectory, privateDirectory } = require('./state.cjs');
const {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RUNTIME_VERSION,
} = require('../src/core.js');
async function running() {
  let connection;
  try {
    connection = readConnection();
  } catch (error) {
    if (/not running/.test(error.message)) return null;
    throw error;
  }
  let state;
  try {
    state = await bridgeRequest(connection, '/v1/status?summary=1', {
      timeoutMs: 1500,
    });
  } catch (error) {
    if (error.statusCode) throw error;
    return null;
  }
  if (
    state.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    state.runtimeVersion !== BRIDGE_RUNTIME_VERSION
  )
    throw new Error(
      'Another plugin version is running. Inspect its pending jobs, then stop it before upgrading.',
    );
  return connection;
}
let starting;
async function startCompanion() {
  const lock = path.join(bridgeStateDirectory(), 'companion/.install-lock');
  if (process.env.FIGMA_PLUGIN_ACTIVATION_PROBE !== '1') {
    const deadline = Date.now() + 15000;
    while (true) {
      let owner;
      try {
        owner = Number(fs.readlinkSync(lock).split('-')[0]);
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      if (Date.now() >= deadline)
        throw new Error('The companion update has not completed yet');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const existing = await running();
  if (existing) return existing;
  privateDirectory(bridgeStateDirectory());
  const log = fs.openSync(
    path.join(bridgeStateDirectory(), 'companion.log'),
    'a',
    0o600,
  );
  const runtime = process.env.FIGMA_PLUGIN_BUNDLED_NODE
    ? path.join(bridgeStateDirectory(), 'runtime/node')
    : process.execPath;
  const child = spawn(runtime, [path.join(__dirname, 'bridge-server.cjs')], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  child.unref();
  let failure;
  child.once('error', (error) => {
    failure = error;
  });
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const connection = await running();
    if (connection) return connection;
    if (child.exitCode !== null) break;
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  throw new Error(
    'The companion could not start. Port 38491 may be occupied; inspect the private companion.log. Existing credentials were preserved.',
  );
}
function ensureCompanion() {
  if (!starting)
    starting = startCompanion().finally(() => {
      starting = null;
    });
  return starting;
}
module.exports = { ensureCompanion };
