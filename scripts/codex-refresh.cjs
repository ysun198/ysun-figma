const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { writePrivateJson } = require('./state.cjs');
const { currentPath } = require('./installation.cjs');
function codexExecutable() {
  for (const app of ['Codex', 'ChatGPT']) {
    const executable = `/Applications/${app}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
    if (fs.existsSync(executable)) return executable;
  }
  throw new Error('Codex Desktop is not installed in Applications');
}
function marketplaceRoot() {
  const root = path.dirname(currentPath());
  writePrivateJson(path.join(root, '.agents/plugins/marketplace.json'), {
    name: 'figma-local',
    interface: { displayName: 'ysun figma' },
    plugins: [
      {
        name: 'figma-plugin-local',
        source: { source: 'local', path: './current' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  });
  return root;
}
async function refreshCodex() {
  const root = marketplaceRoot(),
    executable = codexExecutable(),
    options = { timeout: 30000, maxBuffer: 1024 * 1024 };
  // Official plugin installation refreshes metadata and skills as well as MCP
  // files. The canonical source is the verified current package, never another
  // mutable copy of it. Only our named registration is changed.
  const { stdout } = await execFile(
    executable,
    ['plugin', 'marketplace', 'list', '--json'],
    options,
  );
  const previous = JSON.parse(stdout).marketplaces.find(
    (item) => item.name === 'figma-local',
  );
  if (previous && previous.root !== root)
    await execFile(
      executable,
      ['plugin', 'marketplace', 'remove', 'figma-local', '--json'],
      options,
    );
  if (!previous || previous.root !== root)
    await execFile(
      executable,
      ['plugin', 'marketplace', 'add', root, '--json'],
      options,
    );
  await execFile(
    executable,
    ['plugin', 'add', 'figma-plugin-local@figma-local', '--json'],
    options,
  );
}
async function hostEnabled() {
  const { stdout } = await execFile(
    codexExecutable(),
    ['plugin', 'list', '--json'],
    { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout).installed.some(
    (plugin) =>
      plugin.pluginId === 'figma-plugin-local@figma-local' &&
      plugin.installed &&
      plugin.enabled,
  );
}
module.exports = {
  refreshCodex,
  marketplaceRoot,
  codexExecutable,
  hostEnabled,
};
