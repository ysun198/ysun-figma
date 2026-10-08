const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const nativeFiles = ['manifest.json', 'plugin-runtime.js', 'ui.html'];

function bridgeStateDirectory() {
  const override = process.env.FIGMA_PLUGIN_STATE_DIR;
  if (override && !path.isAbsolute(override))
    throw new Error('FIGMA_PLUGIN_STATE_DIR must be an absolute path');
  return override || path.join(os.homedir(), '.canvas-bridge');
}
const connectionPath = () =>
  path.join(bridgeStateDirectory(), 'connection.json');
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink())
    throw new Error('Private state directory cannot be a symlink');
  fs.chmodSync(directory, 0o700);
}
function writePrivateJson(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// The stable installation survives host cache eviction. Only Figma entrypoints
// are copied; credentials and receipts never enter the plugin directory.
function pluginInstalled(sourceRoot) {
  const directory = path.join(bridgeStateDirectory(), 'plugin');
  return nativeFiles.every((name) => {
    const target = path.join(directory, name);
    return (
      fs.existsSync(target) &&
      fs
        .readFileSync(target)
        .equals(fs.readFileSync(path.join(sourceRoot, name)))
    );
  });
}
function installPlugin(sourceRoot) {
  const directory = path.join(bridgeStateDirectory(), 'plugin');
  privateDirectory(directory);
  for (const name of nativeFiles) {
    const source = fs.readFileSync(path.join(sourceRoot, name));
    const target = path.join(directory, name);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(source))
      fs.writeFileSync(target, source, { mode: 0o600 });
  }
  return path.join(directory, 'manifest.json');
}

module.exports = {
  bridgeStateDirectory,
  connectionPath,
  privateDirectory,
  writePrivateJson,
  pluginInstalled,
  installPlugin,
};
