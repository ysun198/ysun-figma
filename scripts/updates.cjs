// A release is executable code. Trust the publisher's signature, never a URL
// response or an unsigned checksum. GitHub supplies transport, not authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { newer } = require('../src/version.js');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const {
  bridgeStateDirectory,
  privateDirectory,
  writePrivateJson,
} = require('./state.cjs');
const {
  currentPath,
  publicEntries,
  prepareManagedCompanion,
} = require('./installation.cjs');
const MAX_ARCHIVE = 160 * 1024 * 1024;
const directory = () => path.join(bridgeStateDirectory(), 'updates');
const statusPath = () => path.join(directory(), 'status.json');
function updateStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function repository(pkg) {
  const match = /^https:\/\/github\.com\/([\w-]+\/[\w.-]+)\.git$/.exec(
    pkg.repository?.url || '',
  );
  if (!match) throw new Error('No GitHub update repository is configured');
  return match[1];
}
function verifyRelease(envelope, pkg) {
  const payload = Buffer.from(envelope.payload || '', 'base64');
  if (
    !crypto.verify(
      null,
      payload,
      pkg.updates.publicKey,
      Buffer.from(envelope.signature || '', 'base64'),
    )
  )
    throw new Error('Release signature is invalid');
  const release = JSON.parse(payload.toString('utf8'));
  if (
    release.product !== pkg.name ||
    release.repository !== repository(pkg) ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    release.archive !== `ysun-figma-${release.version}.zip` ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !Number.isSafeInteger(release.size) ||
    release.size <= 0 ||
    release.size > MAX_ARCHIVE
  )
    throw new Error('Release descriptor is invalid');
  return release;
}
async function download(url, maximum, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(`Update download failed: HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maximum)
    throw new Error('Update download exceeds its size limit');
  const blocks = [];
  let size = 0;
  for await (const block of response.body) {
    size += block.length;
    if (size > maximum)
      throw new Error('Update download exceeds its size limit');
    blocks.push(block);
  }
  return Buffer.concat(blocks);
}
function archiveEntries(bytes) {
  // Validate the central directory before the platform unzip touches disk.
  // Our release writer uses ordinary ZIP; encryption, ZIP64 and symlinks are
  // unnecessary and rejected, along with traversal and decompression bombs.
  if (bytes.length < 22) throw new Error('Invalid update ZIP');
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (
    end < minimum ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length ||
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6)
  )
    throw new Error('Invalid update ZIP');
  const count = bytes.readUInt16LE(end + 10),
    names = new Set();
  let offset = bytes.readUInt32LE(end + 16),
    total = 0;
  const limit = offset + bytes.readUInt32LE(end + 12);
  if (!count || count > 4096 || limit !== end)
    throw new Error('Invalid update ZIP directory');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > limit || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid update ZIP entry');
    const length = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + length + extra + comment;
    if (next > limit) throw new Error('Invalid update ZIP entry length');
    const name = bytes
      .subarray(offset + 46, offset + 46 + length)
      .toString('utf8');
    const mode = (bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000;
    total += bytes.readUInt32LE(offset + 24);
    if (
      !name ||
      names.has(name) ||
      name.includes('\\') ||
      [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      path.isAbsolute(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      ![0, 0x8000].includes(mode) ||
      bytes.readUInt16LE(offset + 8) & 1 ||
      total > 512 * 1024 * 1024
    )
      throw new Error('Unsafe update ZIP entry');
    names.add(name);
    offset = next;
  }
  if (offset !== limit) throw new Error('Invalid update ZIP directory length');
  return [...names].sort();
}
async function extractRelease(bytes, release, destination) {
  if (
    bytes.length !== release.size ||
    crypto.createHash('sha256').update(bytes).digest('hex') !== release.sha256
  )
    throw new Error('Release archive integrity check failed');
  const entries = archiveEntries(bytes),
    archive = path.join(destination, 'release.zip'),
    bundle = path.join(destination, 'bundle');
  fs.writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' });
  fs.mkdirSync(bundle, { mode: 0o700 });
  await execFile('unzip', ['-q', archive, '-d', bundle], { timeout: 30000 });
  fs.unlinkSync(archive);
  const source = path.join(bundle, 'plugin'),
    pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  if (pkg.version !== release.version)
    throw new Error('Archive and release versions differ');
  const expected = [
    '.agents/plugins/marketplace.json',
    ...publicEntries(source).map((file) => 'plugin/' + file),
  ];
  for (const architecture of ['arm64', 'x64'])
    for (const file of ['node', 'LICENSE', 'PROVENANCE.json'])
      expected.push(`plugin/runtime/darwin-${architecture}/${file}`);
  if (JSON.stringify(entries) !== JSON.stringify(expected.sort()))
    throw new Error('Unexpected files in update archive');
  return source;
}
function createUpdater({
  packageRoot = currentPath(),
  fetchImpl = fetch,
  activate = prepareManagedCompanion,
  refreshHost = require('./codex-refresh.cjs').refreshCodex,
} = {}) {
  let candidate;
  const trusted = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json')),
  );
  const base = `https://github.com/${repository(trusted)}/releases`;
  function save(stage, extra = {}) {
    writePrivateJson(statusPath(), {
      checkedAt: new Date().toISOString(),
      stage,
      ...extra,
    });
  }
  function dispose() {
    if (candidate)
      fs.rmSync(candidate.directory, { recursive: true, force: true });
    candidate = undefined;
  }
  async function check() {
    privateDirectory(directory());
    let installed,
      refreshPending = updateStatus()?.refreshPending;
    try {
      installed = JSON.parse(
        fs.readFileSync(path.join(currentPath(), 'package.json')),
      ).version;
      if (refreshPending) {
        await refreshHost();
        refreshPending = false;
        save('current', { installedVersion: installed });
      }
      const release =
        candidate?.release ||
        verifyRelease(
          JSON.parse(
            (
              await download(
                base + '/latest/download/update.json',
                65536,
                fetchImpl,
              )
            ).toString('utf8'),
          ),
          trusted,
        );
      if (!newer(release.version, installed)) {
        dispose();
        save('current', { installedVersion: installed });
        return false;
      }
      if (candidate?.version !== release.version) {
        dispose();
        candidate = {
          release,
          version: release.version,
          directory: fs.mkdtempSync(path.join(directory(), '.download-')),
        };
        save('downloading', {
          installedVersion: installed,
          availableVersion: release.version,
        });
        const bytes = await download(
          `${base}/download/v${release.version}/${release.archive}`,
          release.size,
          fetchImpl,
        );
        candidate.source = await extractRelease(
          bytes,
          release,
          candidate.directory,
        );
      }
      const runtime = path.join(
        candidate.source,
        `runtime/darwin-${process.arch}/node`,
      );
      const result = await activate(candidate.source, {
        runtimeSource: runtime,
        healthCheck: true,
      });
      dispose();
      installed = result.version;
      refreshPending = true;
      save('refreshing', { installedVersion: installed, refreshPending });
      await refreshHost();
      refreshPending = false;
      save('current', { installedVersion: result.version });
      return result.changed;
    } catch (error) {
      if (error.code === 'UPDATE_BUSY') {
        save('waiting_for_idle', { availableVersion: candidate?.version });
        return false;
      }
      dispose();
      save('error', {
        message: error.message,
        installedVersion: installed,
        refreshPending,
      });
      throw error;
    }
  }
  return { check, dispose };
}
module.exports = {
  createUpdater,
  updateStatus,
  verifyRelease,
  archiveEntries,
  extractRelease,
  newer,
  repository,
};
