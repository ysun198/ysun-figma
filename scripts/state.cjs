const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const nativeFiles = ['manifest.json', 'plugin-runtime.js', 'ui.html'];

function hashFile(file) {
  const descriptor = fs.openSync(file, 'r'),
    digest = crypto.createHash('sha256'),
    block = Buffer.alloc(64 * 1024);
  try {
    let size;
    while ((size = fs.readSync(descriptor, block, 0, block.length, null)))
      digest.update(block.subarray(0, size));
    return digest.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

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

function installedRuntime(source = process.env.FIGMA_PLUGIN_BUNDLED_NODE) {
  if (!source) return process.execPath;
  if (!path.isAbsolute(source) || !fs.statSync(source).isFile())
    throw new Error('Invalid bundled runtime.');
  const root = path.join(bridgeStateDirectory(), 'runtime');
  const target = path.join(root, 'node'),
    marker = path.join(root, 'runtime.json');
  if (!fs.existsSync(target)) return null;
  const actual = hashFile(target);
  if (
    !fs.existsSync(marker) ||
    JSON.parse(fs.readFileSync(marker)).sha256 !== actual
  )
    throw new Error('An unrelated or modified local runtime was preserved.');
  return (source === target ? actual : hashFile(source)) === actual
    ? target
    : null;
}

function installRuntime(source = process.env.FIGMA_PLUGIN_BUNDLED_NODE) {
  const ready = installedRuntime(source);
  if (ready) return ready;
  const root = path.join(bridgeStateDirectory(), 'runtime');
  privateDirectory(root);
  const target = path.join(root, 'node'),
    marker = path.join(root, 'runtime.json');
  const staging = target + '.new-' + process.pid;
  try {
    fs.copyFileSync(source, staging);
    fs.chmodSync(staging, 0o700);
    fs.renameSync(staging, target);
    writePrivateJson(marker, { sha256: hashFile(target) });
  } finally {
    fs.rmSync(staging, { force: true });
  }
  return target;
}
module.exports = {
  bridgeStateDirectory,
  connectionPath,
  privateDirectory,
  writePrivateJson,
  pluginInstalled,
  installPlugin,
  installedRuntime,
  installRuntime,
};
