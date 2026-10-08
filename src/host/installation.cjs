const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  bridgeStateDirectory,
  privateDirectory,
  writePrivateJson,
  pluginInstalled,
  installPlugin,
} = require('./state.cjs');
const { readConnection, bridgeRequest } = require('./bridge-client.cjs');
const product = require('../../package.json').name;
const directory = () => path.join(bridgeStateDirectory(), 'companion');
const currentPath = () => path.join(directory(), 'current');
const hash = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function recoverInstallation(state) {
  // This small recovery entrypoint is embedded in launchd's generated command,
  // so a process dying between the directory renames cannot strand the receiver.
  const fs = require('node:fs'),
    path = require('node:path');
  const directory = path.join(state, 'companion'),
    journal = path.join(directory, '.activation.json');
  if (!fs.existsSync(journal)) return;
  try {
    const owner = Number(
      fs.readlinkSync(path.join(directory, '.install-lock')).split('-')[0],
    );
    try {
      process.kill(owner, 0);
      return;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { staging } = JSON.parse(fs.readFileSync(journal));
  if (
    path.dirname(staging) !== directory ||
    !/^\.install-[\w]+$/.test(path.basename(staging))
  )
    throw new Error('Invalid installation recovery journal');
  const backup = path.join(staging, 'replaced'),
    current = path.join(directory, 'current');
  if (fs.existsSync(backup)) {
    fs.rmSync(current, { recursive: true, force: true });
    fs.renameSync(backup, current);
    for (const name of ['manifest.json', 'plugin-runtime.js', 'ui.html'])
      fs.copyFileSync(
        path.join(current, name),
        path.join(state, 'plugin', name),
      );
  }
  fs.unlinkSync(journal);
  fs.rmSync(staging, { recursive: true, force: true });
}

function publicEntries(root, entries) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  if (
    pkg.name !== product ||
    !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
    !Array.isArray(pkg.distributionFiles)
  )
    throw new Error('Invalid companion package');
  const files = [];
  function add(entry) {
    if (
      path.isAbsolute(entry) ||
      entry
        .split('/')
        .some(
          (part) => !part || part.startsWith('.') || part === 'node_modules',
        )
    )
      throw new Error('Invalid public package path');
    const file = path.join(root, entry),
      stat = fs.lstatSync(file);
    if (stat.isSymbolicLink())
      throw new Error('Public packages cannot contain symlinks');
    if (stat.isDirectory())
      for (const name of fs.readdirSync(file)) add(entry + '/' + name);
    else if (stat.isFile()) files.push(entry);
    else throw new Error('Unsupported package file');
  }
  for (const entry of new Set([
    'package.json',
    'README.md',
    ...(entries || pkg.distributionFiles),
  ]))
    add(entry.replace(/\/$/, ''));
  return files.sort();
}
function receiptFor(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  return {
    product,
    version: pkg.version,
    files: Object.fromEntries(
      publicEntries(root).map((file) => [file, hash(path.join(root, file))]),
    ),
  };
}
function verify(root) {
  if (fs.lstatSync(root).isSymbolicLink())
    throw new Error('Installation directory cannot be a symlink');
  const receipt = JSON.parse(
    fs.readFileSync(path.join(root, '.installation.json'), 'utf8'),
  );
  const actual = publicEntries(
    root,
    fs.readdirSync(root).filter((name) => name !== '.installation.json'),
  );
  if (
    JSON.stringify(receipt) !== JSON.stringify(receiptFor(root)) ||
    JSON.stringify(actual) !== JSON.stringify(Object.keys(receipt.files).sort())
  )
    throw new Error('Installed code was modified; it was preserved');
  return receipt;
}
async function stopForMaintenance() {
  let connection;
  try {
    connection = readConnection();
  } catch (error) {
    if (/not running/.test(error.message)) return;
    throw error;
  }
  try {
    await bridgeRequest(connection, '/v1/maintenance', {
      method: 'POST',
      timeoutMs: 1500,
    });
  } catch (error) {
    if (error.statusCode === 409) error.code = 'UPDATE_BUSY';
    if (error.statusCode) throw error;
    return;
  }
  if (
    !Number.isSafeInteger(connection.pid) ||
    connection.pid <= 1 ||
    connection.pid === process.pid
  )
    throw new Error('No managed companion PID is available');
  process.kill(connection.pid, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      process.kill(connection.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
  }
  throw new Error('The companion has not stopped yet. No code was activated');
}

function reusableReceipt(current, requested) {
  if (!fs.existsSync(current)) return null;
  const active = verify(current),
    a = active.version.split('.').map(Number),
    b = requested.version.split('.').map(Number),
    different = a.findIndex((n, i) => n !== b[i]);
  if (different >= 0) return a[different] > b[different] ? active : null;
  if (JSON.stringify(active) !== JSON.stringify(requested))
    throw new Error('This version has different contents. Use a new version');
  return active;
}
async function prepareManagedCompanion(source, options = {}) {
  recoverInstallation(bridgeStateDirectory());
  const requested = receiptFor(source),
    current = currentPath();
  privateDirectory(directory());
  // A symlink publishes the owner atomically, including when its process dies
  // before reaching an exit handler. Codex may launch several transports at once.
  const lock = path.join(directory(), '.install-lock'),
    owner = process.pid + '-' + crypto.randomUUID();
  function lockOwner() {
    let active;
    try {
      active = fs.readlinkSync(lock);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!/^\d+-[a-f0-9-]{36}$/.test(active))
      throw new Error('Invalid installation lock; it was preserved');
    return active;
  }
  function generation() {
    try {
      return fs.lstatSync(current).ino;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  const deadline = Date.now() + 10000;
  while (true) {
    const active = lockOwner();
    if (!active) {
      // Normal starts only read verified files, without serializing every
      // Codex conversation on the installation lock.
      const before = generation();
      let ready;
      try {
        const receipt = reusableReceipt(current, requested);
        if (receipt && pluginInstalled(current))
          ready = {
            version: receipt.version,
            changed: false,
          };
      } catch (error) {
        if (lockOwner() || generation() !== before) continue;
        throw error;
      }
      // Atomic activation changes the directory inode. Retry if an installer
      // crossed this read; never combine files from different activations.
      if (lockOwner() || generation() !== before) continue;
      if (ready) return ready;
      try {
        fs.symlinkSync(owner, lock);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        continue;
      }
    }
    try {
      process.kill(Number(active.split('-')[0]), 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      try {
        if (fs.readlinkSync(lock) === active) fs.unlinkSync(lock);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error('Another installation is still running');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    const active = reusableReceipt(current, requested);
    if (active) {
      installPlugin(current);
      return {
        version: active.version,
        changed: false,
      };
    }
    const staging = fs.mkdtempSync(path.join(directory(), '.install-'));
    const backup = path.join(staging, 'replaced');
    try {
      const next = path.join(staging, 'next');
      for (const file of Object.keys(requested.files)) {
        const destination = path.join(next, file);
        fs.mkdirSync(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        fs.copyFileSync(path.join(source, file), destination);
        fs.chmodSync(destination, 0o600);
      }
      writePrivateJson(path.join(next, '.installation.json'), requested);
      verify(next);
      await stopForMaintenance();
      const journal = path.join(directory(), '.activation.json');
      writePrivateJson(journal, { staging });
      try {
        if (fs.existsSync(current)) fs.renameSync(current, backup);
        fs.renameSync(next, current);
        installPlugin(current);
        if (options.healthCheck) {
          try {
            await checkActivatedRuntime(requested.version);
          } catch (error) {
            error.code = 'UPDATE_UNHEALTHY';
            throw error;
          }
        }
        fs.unlinkSync(journal);
      } catch (error) {
        try {
          await stopForMaintenance();
        } catch {}
        if (fs.existsSync(backup)) {
          fs.rmSync(current, { recursive: true, force: true });
          fs.renameSync(backup, current);
          installPlugin(current);
        }
        fs.rmSync(journal, { force: true });
        throw error;
      }
      return { version: requested.version, changed: true };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    if (fs.readlinkSync(lock) === owner) fs.unlinkSync(lock);
  }
}
async function checkActivatedRuntime(expectedVersion) {
  const { spawn } = require('node:child_process');
  // Probe the activated package through the shared launcher, not modules retained by the
  // receiver. Only successful startup against the real ledger commits it.
  const source = `const {ensureCompanion}=require(${JSON.stringify(path.join(currentPath(), 'src/host/companion.cjs'))});
const {bridgeRequest}=require(${JSON.stringify(path.join(currentPath(), 'src/host/bridge-client.cjs'))});
ensureCompanion().then(c=>bridgeRequest(c,'/v1/status?summary=1')).then(s=>{if(s.version!==${JSON.stringify(expectedVersion)})throw new Error('Activated version did not start');}).catch(e=>{console.error(e.message);process.exitCode=1;});`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/sh',
      [path.join(currentPath(), 'scripts/run-node.sh'), '-e', source],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, FIGMA_PLUGIN_ACTIVATION_PROBE: '1' },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString().slice(0, 4096);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Update health check timed out'));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error('Update health check failed: ' + stderr.trim()));
    });
  });
}
module.exports = {
  currentPath,
  publicEntries,
  verify,
  stopForMaintenance,
  prepareManagedCompanion,
  recoverInstallation,
};
