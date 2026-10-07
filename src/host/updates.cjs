// A release is executable code. Trust the publisher's signature, never a URL
// response or an unsigned checksum. GitHub supplies transport, not authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { newer } = require('../shared/version.js');
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
const MINUTE = 60000,
  HOUR = 60 * MINUTE;
const directory = () => path.join(bridgeStateDirectory(), 'updates');
const statusPath = () => path.join(directory(), 'status.json');
function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(statusPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function updateStatus() {
  const state = readUpdateState();
  if (!state) return null;
  const { feed, ...status } = state;
  return status;
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
async function request(url, fetchImpl, signal, headers = {}, timeout = 120000) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headers,
  });
  if (!response.ok && response.status !== 304) {
    const error = new Error(`Update download failed: HTTP ${response.status}`);
    error.retryAfter = response.headers.get('retry-after');
    await response.body?.cancel();
    throw error;
  }
  return response;
}
async function readBody(response, maximum) {
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
  clock = Date.now,
  random = Math.random,
  intervalMs = HOUR,
} = {}) {
  let candidate;
  const cancellation = new AbortController();
  const trusted = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json')),
  );
  const base = `https://github.com/${repository(trusted)}/releases`;
  function save(state, stage, extra = {}) {
    Object.assign(
      state,
      { stage, message: undefined, availableVersion: undefined },
      extra,
    );
    writePrivateJson(statusPath(), state);
  }
  function finish(state, stage, extra = {}, error) {
    state.failures = error ? (state.failures || 0) + 1 : 0;
    let delay;
    if (error) {
      delay =
        Math.min(3 * HOUR, MINUTE * 2 ** Math.min(state.failures - 1, 12)) *
        (1 + random());
      const retry = error.retryAfter;
      const retryAt = /^\d+$/.test(retry || '')
        ? clock() + Number(retry) * 1000
        : Date.parse(retry);
      if (!Number.isNaN(new Date(retryAt).getTime()))
        delay = Math.max(delay, retryAt - clock());
    } else {
      delay =
        stage === 'waiting_for_idle'
          ? 30000 * (1 + random() / 2)
          : intervalMs * (1 + random() / 4);
    }
    state.nextCheckAt = new Date(clock() + delay).toISOString();
    save(state, stage, extra);
  }
  function nextDelay({ onOpen = false } = {}) {
    const state = readUpdateState();
    if (!state) return 0;
    // Opening several conversations must not create a request burst or bypass
    // a server's Retry-After. Only healthy checks can move ahead of schedule.
    if (
      onOpen &&
      ['current', 'rejected'].includes(state.stage) &&
      clock() - Date.parse(state.checkedAt) >= 15 * MINUTE
    )
      return 0;
    return Math.max(0, (Date.parse(state.nextCheckAt) || 0) - clock());
  }
  function dispose() {
    if (candidate)
      fs.rmSync(candidate.directory, { recursive: true, force: true });
    candidate = undefined;
  }
  async function check() {
    privateDirectory(directory());
    cancellation.signal.throwIfAborted();
    const state = readUpdateState() || {};
    state.checkedAt = new Date(clock()).toISOString();
    state.nextCheckAt = null;
    let installed,
      refreshPending = state.refreshPending;
    try {
      installed = JSON.parse(
        fs.readFileSync(path.join(currentPath(), 'package.json')),
      ).version;
      if (refreshPending) {
        await refreshHost();
        refreshPending = false;
        save(state, 'current', { installedVersion: installed, refreshPending });
      }
      let cached = state.feed,
        release;
      if (cached) {
        try {
          release = verifyRelease(cached.envelope, trusted);
        } catch {
          cached = undefined;
          state.feed = undefined;
        }
      }
      const headers = { 'Cache-Control': 'no-cache' };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      else if (cached?.lastModified)
        headers['If-Modified-Since'] = cached.lastModified;
      // Revalidate even a staged archive: the publisher may have withdrawn or
      // superseded it while a long-running edit held maintenance admission.
      const response = await request(
        base + '/latest/download/update.json',
        fetchImpl,
        cancellation.signal,
        headers,
        20000,
      );
      if (response.status === 304) {
        if (!cached) throw new Error('No verified cached release for HTTP 304');
      } else {
        const envelope = JSON.parse(
          (await readBody(response, 65536)).toString('utf8'),
        );
        release = verifyRelease(envelope, trusted);
        cached = {
          envelope: {
            payload: envelope.payload,
            signature: envelope.signature,
          },
        };
      }
      state.feed = {
        ...cached,
        etag:
          response.headers.get('etag') ||
          (response.status === 304 ? cached.etag : undefined),
        lastModified:
          response.headers.get('last-modified') ||
          (response.status === 304 ? cached.lastModified : undefined),
      };
      if (!newer(release.version, installed)) {
        dispose();
        finish(state, 'current', {
          installedVersion: installed,
          refreshPending,
        });
        return false;
      }
      if (state.rejectedRelease?.sha256 === release.sha256) {
        finish(state, 'rejected', {
          installedVersion: installed,
          availableVersion: release.version,
          message: state.rejectedRelease.message,
        });
        return false;
      }
      state.rejectedRelease = undefined;
      if (candidate?.release.sha256 !== release.sha256) {
        dispose();
        candidate = {
          release,
          version: release.version,
          directory: fs.mkdtempSync(path.join(directory(), '.download-')),
        };
        save(state, 'downloading', {
          installedVersion: installed,
          availableVersion: release.version,
        });
        const bytes = await readBody(
          await request(
            `${base}/download/v${release.version}/${release.archive}`,
            fetchImpl,
            cancellation.signal,
          ),
          release.size,
        );
        candidate.source = await extractRelease(
          bytes,
          release,
          candidate.directory,
        );
      }
      cancellation.signal.throwIfAborted();
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
      save(state, 'refreshing', {
        installedVersion: installed,
        refreshPending,
      });
      await refreshHost();
      refreshPending = false;
      finish(state, 'current', {
        installedVersion: result.version,
        refreshPending,
      });
      return result.changed;
    } catch (error) {
      if (error.code === 'UPDATE_BUSY') {
        finish(state, 'waiting_for_idle', {
          installedVersion: installed,
          availableVersion: candidate?.version,
        });
        return false;
      }
      if (error.code === 'UPDATE_UNHEALTHY') {
        state.rejectedRelease = {
          version: candidate.version,
          sha256: candidate.release.sha256,
          message: error.message,
        };
      }
      dispose();
      if (cancellation.signal.aborted) throw error;
      finish(
        state,
        error.code === 'UPDATE_UNHEALTHY' ? 'rejected' : 'error',
        {
          message: error.message,
          installedVersion: installed,
          refreshPending,
        },
        error.code === 'UPDATE_UNHEALTHY' ? undefined : error,
      );
      throw error;
    }
  }
  return {
    check,
    dispose,
    nextDelay,
    cancel: () => cancellation.abort(),
    defer: (error) =>
      finish(
        { ...readUpdateState(), checkedAt: new Date(clock()).toISOString() },
        'error',
        { message: error.message },
        error,
      ),
    restartRequired: () =>
      newer(
        JSON.parse(fs.readFileSync(path.join(currentPath(), 'package.json')))
          .version,
        trusted.version,
      ),
  };
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
