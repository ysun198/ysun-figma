const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createUpdater,
  verifyRelease,
  archiveEntries,
  updateStatus,
} = require('../scripts/updates.cjs');
const { signRelease } = require('../scripts/release.cjs');
const {
  prepareManagedCompanion,
  currentPath,
  publicEntries,
  recoverInstallation,
} = require('../scripts/installation.cjs');
const { receive } = require('../scripts/update-service.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-update-'));
  const oldState = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = path.join(root, 'state');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = {
    name: 'figma-plugin-local',
    version: '1.0.0',
    repository: { url: 'https://github.com/example/figma.git' },
    updates: {
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
    distributionFiles: [
      'manifest.json',
      'plugin-runtime.js',
      'ui.html',
      'skills/',
    ],
  };
  function source(version) {
    const folder = path.join(root, version);
    fs.mkdirSync(path.join(folder, 'skills/router'), { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'package.json'),
      JSON.stringify({ ...pkg, version }),
    );
    fs.writeFileSync(path.join(folder, 'README.md'), 'public');
    for (const name of ['manifest.json', 'plugin-runtime.js', 'ui.html'])
      fs.writeFileSync(path.join(folder, name), version);
    fs.writeFileSync(path.join(folder, 'skills/router/SKILL.md'), version);
    return folder;
  }
  function release(version) {
    const folder = source(version),
      bundle = path.join(root, 'bundle-' + version),
      plugin = path.join(bundle, 'plugin');
    fs.cpSync(folder, plugin, { recursive: true });
    fs.mkdirSync(path.join(bundle, '.agents/plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(bundle, '.agents/plugins/marketplace.json'),
      '{}',
    );
    const files = [
      '.agents/plugins/marketplace.json',
      ...publicEntries(plugin).map((v) => 'plugin/' + v),
    ];
    for (const arch of ['arm64', 'x64']) {
      fs.mkdirSync(path.join(plugin, 'runtime/darwin-' + arch), {
        recursive: true,
      });
      for (const name of ['node', 'LICENSE', 'PROVENANCE.json']) {
        const relative = 'plugin/runtime/darwin-' + arch + '/' + name;
        fs.writeFileSync(path.join(bundle, relative), 'test runtime');
        files.push(relative);
      }
    }
    const archive = path.join(root, 'ysun-figma-' + version + '.zip');
    execFileSync('zip', ['-q', '-X', archive, ...files], { cwd: bundle });
    return {
      envelope: signRelease(archive, { ...pkg, version }, privateKey),
      bytes: fs.readFileSync(archive),
    };
  }
  t.after(() => {
    if (oldState === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = oldState;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, pkg, source, release, privateKey };
}
test('published signed release updates code, native entrypoints and skills without touching private data', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const state = process.env.FIGMA_PLUGIN_STATE_DIR;
  for (const name of [
    'authorizations.json',
    'operations.sqlite',
    'catalog.json',
  ])
    fs.writeFileSync(path.join(state, name), 'retain-' + name);
  const published = f.release('1.1.0');
  let downloads = 0,
    refreshes = 0;
  const updater = createUpdater({
    fetchImpl: async (url) => {
      if (url.endsWith('update.json'))
        return new Response(JSON.stringify(published.envelope));
      assert.equal(
        url,
        'https://github.com/example/figma/releases/download/v1.1.0/ysun-figma-1.1.0.zip',
      );
      downloads++;
      return new Response(published.bytes);
    },
    activate: (source) => prepareManagedCompanion(source),
    refreshHost: async () => {
      refreshes++;
    },
  });
  t.after(updater.dispose);
  assert.equal(await updater.check(), true);
  assert.equal(await updater.check(), false);
  assert.equal(downloads, 1);
  assert.equal(refreshes, 1);
  assert.equal(
    require(path.join(currentPath(), 'package.json')).version,
    '1.1.0',
  );
  assert.equal(
    fs.readFileSync(path.join(currentPath(), 'skills/router/SKILL.md'), 'utf8'),
    '1.1.0',
  );
  assert.equal(
    fs.readFileSync(path.join(state, 'plugin/plugin-runtime.js'), 'utf8'),
    '1.1.0',
  );
  for (const name of [
    'authorizations.json',
    'operations.sqlite',
    'catalog.json',
  ])
    assert.equal(
      fs.readFileSync(path.join(state, name), 'utf8'),
      'retain-' + name,
    );
  assert.equal(updateStatus().stage, 'current');
  assert(
    !fs
      .readdirSync(path.join(state, 'updates'))
      .some((v) => v.startsWith('.download-')),
  );
});
test('busy edits defer activation and reuse the same verified download', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const release = f.release('1.1.0');
  let busy = true,
    downloads = 0;
  const updater = createUpdater({
    fetchImpl: async (url) => {
      if (url.endsWith('update.json'))
        return new Response(JSON.stringify(release.envelope));
      downloads++;
      return new Response(release.bytes);
    },
    activate: async (source) => {
      if (busy) throw Object.assign(new Error('busy'), { code: 'UPDATE_BUSY' });
      return prepareManagedCompanion(source);
    },
    refreshHost: async () => {},
  });
  t.after(updater.dispose);
  assert.equal(await updater.check(), false);
  assert.equal(updateStatus().stage, 'waiting_for_idle');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(currentPath(), 'package.json')))
      .version,
    '1.0.0',
  );
  busy = false;
  assert.equal(await updater.check(), true);
  assert.equal(downloads, 1);
});
test('a release withdrawn while edits are busy is never activated later', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  let published = f.release('1.1.0'),
    busy = true,
    activations = 0;
  const updater = createUpdater({
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('update.json')
          ? JSON.stringify(published.envelope)
          : published.bytes,
      ),
    activate: async (source) => {
      if (busy) throw Object.assign(new Error('busy'), { code: 'UPDATE_BUSY' });
      activations++;
      return prepareManagedCompanion(source);
    },
    refreshHost: async () => {},
  });
  t.after(updater.dispose);
  assert.equal(await updater.check(), false);
  published = f.release('1.0.0');
  busy = false;
  assert.equal(await updater.check(), false);
  assert.equal(activations, 0);
  assert.equal(updateStatus().installedVersion, '1.0.0');
  assert(
    !fs
      .readdirSync(path.join(process.env.FIGMA_PLUGIN_STATE_DIR, 'updates'))
      .some((v) => v.startsWith('.download-')),
  );
});
test('a superseded staged release is replaced with the newly signed version', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  let published = f.release('1.1.0'),
    busy = true;
  const installed = [],
    downloads = [];
  const updater = createUpdater({
    fetchImpl: async (url) => {
      if (url.endsWith('update.json'))
        return new Response(JSON.stringify(published.envelope));
      downloads.push(url);
      return new Response(published.bytes);
    },
    activate: async (source) => {
      if (busy) throw Object.assign(new Error('busy'), { code: 'UPDATE_BUSY' });
      const result = await prepareManagedCompanion(source);
      installed.push(result.version);
      return result;
    },
    refreshHost: async () => {},
  });
  t.after(updater.dispose);
  await updater.check();
  published = f.release('1.2.0');
  busy = false;
  assert.equal(await updater.check(), true);
  assert.deepEqual(installed, ['1.2.0']);
  assert.equal(downloads.length, 2);
});
test('conditional checks reuse a signed feed across receiver restarts', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const published = f.release('1.0.0');
  let calls = 0;
  const options = {
    fetchImpl: async (url, request) => {
      assert(url.endsWith('update.json'));
      calls++;
      if (calls === 1)
        return new Response(JSON.stringify(published.envelope), {
          headers: { ETag: '"release-1"' },
        });
      assert.equal(request.headers['If-None-Match'], '"release-1"');
      return new Response(null, { status: 304 });
    },
  };
  const first = createUpdater(options);
  assert.equal(await first.check(), false);
  first.dispose();
  const restarted = createUpdater(options);
  t.after(restarted.dispose);
  assert.equal(await restarted.check(), false);
  assert.equal(calls, 2);
  assert.equal(updateStatus().feed, undefined);
});
test('a corrupted cached feed cannot become trusted through a 304 response', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const published = f.release('1.0.0');
  const first = createUpdater({
    fetchImpl: async () =>
      new Response(JSON.stringify(published.envelope), {
        headers: { ETag: '"release-1"' },
      }),
  });
  await first.check();
  first.dispose();
  const file = path.join(
    process.env.FIGMA_PLUGIN_STATE_DIR,
    'updates/status.json',
  );
  const state = JSON.parse(fs.readFileSync(file));
  assert(state.feed);
  state.feed.envelope.payload = Buffer.from('{}').toString('base64');
  fs.writeFileSync(file, JSON.stringify(state));
  const restarted = createUpdater({
    fetchImpl: async (url, request) => {
      assert.equal(request.headers['If-None-Match'], undefined);
      return new Response(null, { status: 304 });
    },
  });
  t.after(restarted.dispose);
  await assert.rejects(restarted.check(), /cached release/);
  assert.equal(updateStatus().installedVersion, '1.0.0');
});
test('opening conversations coalesces checks and cannot defeat durable failure backoff', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  let time = Date.UTC(2026, 0, 1),
    offline = false;
  const published = f.release('1.0.0');
  const options = {
    clock: () => time,
    random: () => 0,
    fetchImpl: async () => {
      if (offline) throw new Error('offline');
      return new Response(JSON.stringify(published.envelope));
    },
  };
  const updater = createUpdater(options);
  t.after(updater.dispose);
  await updater.check();
  assert.equal(updater.nextDelay(), 3600000);
  time += 600000;
  assert.equal(updater.nextDelay({ onOpen: true }), 3000000);
  time += 300000;
  assert.equal(updater.nextDelay({ onOpen: true }), 0);
  offline = true;
  await assert.rejects(updater.check(), /offline/);
  assert.equal(updater.nextDelay({ onOpen: true }), 60000);
  const restarted = createUpdater(options);
  t.after(restarted.dispose);
  assert.equal(restarted.nextDelay({ onOpen: true }), 60000);
  time += 60000;
  await assert.rejects(restarted.check(), /offline/);
  assert.equal(restarted.nextDelay(), 120000);
  time += 120000;
  offline = false;
  await restarted.check();
  assert.equal(updateStatus().failures, 0);
  assert.equal(restarted.nextDelay(), 3600000);
});
test('rate limits honor Retry-After seconds and HTTP dates even after restart', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  let time = Date.UTC(2026, 0, 1),
    retryAfter = '900';
  const options = {
    clock: () => time,
    random: () => 0,
    fetchImpl: async () =>
      new Response('slow down', {
        status: 429,
        headers: { 'Retry-After': retryAfter },
      }),
  };
  const updater = createUpdater(options);
  t.after(updater.dispose);
  await assert.rejects(updater.check(), /429/);
  assert.equal(updater.nextDelay({ onOpen: true }), 900000);
  time += 900000;
  retryAfter = new Date(time + 3600000).toUTCString();
  await assert.rejects(updater.check(), /429/);
  const restarted = createUpdater(options);
  t.after(restarted.dispose);
  assert.equal(restarted.nextDelay({ onOpen: true }), 3600000);
});
test('a failed health probe quarantines that release while allowing the next published version', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  let published = f.release('1.1.0'),
    downloads = 0,
    activations = 0;
  const options = {
    fetchImpl: async (url) => {
      if (url.endsWith('update.json'))
        return new Response(JSON.stringify(published.envelope));
      downloads++;
      return new Response(published.bytes);
    },
    activate: async (source) => {
      activations++;
      if (activations === 1)
        throw Object.assign(new Error('new runtime failed'), {
          code: 'UPDATE_UNHEALTHY',
        });
      return prepareManagedCompanion(source);
    },
    refreshHost: async () => {},
  };
  const updater = createUpdater(options);
  await assert.rejects(updater.check(), /new runtime failed/);
  updater.dispose();
  const restarted = createUpdater(options);
  t.after(restarted.dispose);
  assert.equal(await restarted.check(), false);
  assert.equal(downloads, 1);
  assert.equal(activations, 1);
  assert.equal(updateStatus().stage, 'rejected');
  published = f.release('1.2.0');
  assert.equal(await restarted.check(), true);
  assert.equal(downloads, 2);
  assert.equal(activations, 2);
  assert.equal(updateStatus().installedVersion, '1.2.0');
});
test('real HTTP transport revalidates the feed without transferring another body', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const body = JSON.stringify(f.release('1.0.0').envelope);
  let requests = 0,
    bodies = 0;
  const server = http.createServer((request, response) => {
    requests++;
    assert.equal(request.headers['cache-control'], 'no-cache');
    response.setHeader('etag', '"published"');
    if (request.headers['if-none-match'] === '"published"') {
      response.writeHead(304);
      response.end();
    } else {
      bodies++;
      response.end(body);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = {
    fetchImpl: (url, request) =>
      fetch(`http://127.0.0.1:${server.address().port}/update.json`, request),
  };
  const first = createUpdater(options);
  await first.check();
  first.dispose();
  const restarted = createUpdater(options);
  t.after(restarted.dispose);
  await restarted.check();
  assert.equal(requests, 2);
  assert.equal(bodies, 1);
});
test('receiver coalesces simultaneous conversation openings and removes its signal listeners on stop', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const signals = new EventEmitter(),
    checked = Promise.withResolvers(),
    checkedAgain = Promise.withResolvers(),
    published = f.release('1.0.0');
  let requests = 0,
    time = Date.UTC(2026, 0, 1);
  const updater = createUpdater({
    clock: () => time,
    fetchImpl: async () => {
      requests++;
      if (requests === 2) checkedAgain.resolve();
      return new Response(JSON.stringify(published.envelope));
    },
  });
  const running = receive({
    updater,
    signals,
    isEnabled: async () => {
      checked.resolve();
      return true;
    },
  });
  t.after(() => {
    signals.emit('SIGTERM');
    return running;
  });
  await checked.promise;
  for (let i = 0; i < 12; i++) signals.emit('SIGUSR1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests, 1);
  time += 15 * 60000;
  signals.emit('SIGUSR1');
  await checkedAgain.promise;
  assert.equal(requests, 2);
  signals.emit('SIGTERM');
  await running;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGUSR1'])
    assert.equal(signals.listenerCount(signal), 0);
});
test('host discovery failures also back off instead of spinning the receiver', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const published = f.release('1.0.0'),
    signals = new EventEmitter(),
    started = Promise.withResolvers();
  let attempts = 0,
    requests = 0;
  const updater = createUpdater({
    fetchImpl: async () => {
      requests++;
      return new Response(JSON.stringify(published.envelope));
    },
  });
  const running = receive({
    updater,
    signals,
    isEnabled: async () => {
      attempts++;
      started.resolve();
      if (attempts === 1) throw new Error('host unavailable');
      return true;
    },
  });
  t.after(() => {
    signals.emit('SIGTERM');
    return running;
  });
  await started.promise;
  for (let i = 0; i < 12; i++) signals.emit('SIGUSR1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, 1);
  assert.equal(requests, 0);
  assert.equal(updateStatus().stage, 'error');
  signals.emit('SIGTERM');
  await running;
});
test('stopping a download cancels network IO and removes staging without activating code', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const published = f.release('1.1.0'),
    signals = new EventEmitter(),
    downloading = Promise.withResolvers();
  let activations = 0;
  const updater = createUpdater({
    fetchImpl: async (url, request) => {
      if (url.endsWith('update.json'))
        return new Response(JSON.stringify(published.envelope));
      downloading.resolve();
      return new Promise((resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
    },
    activate: async () => {
      activations++;
    },
  });
  const running = receive({ updater, signals, isEnabled: async () => true });
  t.after(() => {
    signals.emit('SIGTERM');
    return running;
  });
  await downloading.promise;
  signals.emit('SIGTERM');
  await running;
  assert.equal(activations, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(currentPath(), 'package.json')))
      .version,
    '1.0.0',
  );
  assert(
    !fs
      .readdirSync(path.join(process.env.FIGMA_PLUGIN_STATE_DIR, 'updates'))
      .some((v) => v.startsWith('.download-')),
  );
});
test('stopping during activation lets the atomic transition finish before deleting staging', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const published = f.release('1.1.0'),
    signals = new EventEmitter(),
    activating = Promise.withResolvers(),
    continueActivation = Promise.withResolvers();
  let staged;
  const updater = createUpdater({
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('update.json')
          ? JSON.stringify(published.envelope)
          : published.bytes,
      ),
    activate: async (source) => {
      staged = source;
      activating.resolve();
      await continueActivation.promise;
      assert(fs.existsSync(source));
      return prepareManagedCompanion(source);
    },
    refreshHost: async () => {},
  });
  const running = receive({ updater, signals, isEnabled: async () => true });
  t.after(() => {
    signals.emit('SIGTERM');
    continueActivation.resolve();
    return running;
  });
  await activating.promise;
  signals.emit('SIGTERM');
  assert(fs.existsSync(staged));
  continueActivation.resolve();
  await running;
  assert.equal(updateStatus().installedVersion, '1.1.0');
  assert(!fs.existsSync(staged));
});
test('host refresh retries after activation, including before an offline check', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const release = f.release('1.1.0');
  let fail = true,
    refreshes = 0,
    offline = false;
  const updater = createUpdater({
    fetchImpl: async (url) => {
      if (offline) throw new Error('offline');
      return new Response(
        url.endsWith('update.json')
          ? JSON.stringify(release.envelope)
          : release.bytes,
      );
    },
    activate: (source) => prepareManagedCompanion(source),
    refreshHost: async () => {
      refreshes++;
      if (fail) throw new Error('host busy');
    },
  });
  t.after(updater.dispose);
  await assert.rejects(updater.check(), /host busy/);
  assert(updateStatus().refreshPending);
  fail = false;
  offline = true;
  await assert.rejects(updater.check(), /offline/);
  assert.equal(refreshes, 2);
  assert.equal(updateStatus().refreshPending, false);
});
test('invalid signatures, damaged archives and downgrades never activate code', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const release = f.release('1.1.0');
  let activations = 0,
    bytes = release.bytes,
    envelope = {
      ...release.envelope,
      payload: Buffer.from('{}').toString('base64'),
    };
  const updater = createUpdater({
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('update.json') ? JSON.stringify(envelope) : bytes,
      ),
    activate: async () => {
      activations++;
    },
    refreshHost: async () => {},
  });
  t.after(updater.dispose);
  await assert.rejects(updater.check(), /signature/);
  envelope = release.envelope;
  bytes = Buffer.concat([bytes, Buffer.from('corrupt')]);
  await assert.rejects(updater.check(), /size limit/);
  const older = f.release('0.9.0');
  envelope = older.envelope;
  assert.equal(await updater.check(), false);
  assert.equal(activations, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(currentPath(), 'package.json')))
      .version,
    '1.0.0',
  );
});
test('signed descriptor binds the publisher key, product, repository and exact archive', (t) => {
  const f = fixture(t),
    release = f.release('1.1.0');
  assert.equal(verifyRelease(release.envelope, f.pkg).version, '1.1.0');
  assert.throws(
    () => verifyRelease(release.envelope, { ...f.pkg, name: 'another' }),
    /invalid/,
  );
  assert.throws(
    () =>
      signRelease(
        path.join(f.root, 'ysun-figma-1.1.0.zip'),
        { ...f.pkg, version: '1.1.0' },
        crypto.generateKeyPairSync('ed25519').privateKey,
      ),
    /does not match/,
  );
});
test('ZIP inspection rejects traversal and symlinks before extraction', (t) => {
  const f = fixture(t),
    bytes = f.release('1.1.0').bytes;
  assert(archiveEntries(bytes).includes('plugin/package.json'));
  assert.throws(() => archiveEntries(Buffer.alloc(0)), /Invalid/);
  const changed = Buffer.from(bytes),
    entry = changed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  changed.writeUInt32LE(0xa0000000, entry + 38);
  assert.throws(() => archiveEntries(changed), /Unsafe/);
  const traversal = Buffer.from(bytes);
  traversal.write('../', entry + 46);
  assert.throws(() => archiveEntries(traversal), /Unsafe/);
});
test('an interrupted activation restores the last working package and runtime on restart', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const state = process.env.FIGMA_PLUGIN_STATE_DIR,
    staging = path.join(state, 'companion/.install-crash');
  fs.mkdirSync(staging);
  fs.renameSync(currentPath(), path.join(staging, 'replaced'));
  fs.mkdirSync(path.join(staging, 'runtime'));
  fs.writeFileSync(path.join(staging, 'runtime/node'), 'working');
  fs.writeFileSync(
    path.join(state, 'companion/.activation.json'),
    JSON.stringify({ staging }),
  );
  recoverInstallation(state);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(currentPath(), 'package.json')))
      .version,
    '1.0.0',
  );
  assert.equal(
    fs.readFileSync(path.join(state, 'runtime/node'), 'utf8'),
    'working',
  );
  assert(!fs.existsSync(staging));
  assert(!fs.existsSync(path.join(state, 'companion/.activation.json')));
});
test('a failed new-runtime health probe restores working code and native entrypoints', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const source = f.source('1.1.0');
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  pkg.distributionFiles.push(
    'scripts/companion.cjs',
    'scripts/bridge-client.cjs',
  );
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(pkg));
  fs.mkdirSync(path.join(source, 'scripts'));
  fs.writeFileSync(
    path.join(source, 'scripts/companion.cjs'),
    "exports.ensureCompanion=async()=>{throw new Error('invalid new runtime');};",
  );
  fs.writeFileSync(
    path.join(source, 'scripts/bridge-client.cjs'),
    'exports.bridgeRequest=async()=>({});',
  );
  await assert.rejects(
    prepareManagedCompanion(source, { healthCheck: true }),
    (error) =>
      error.code === 'UPDATE_UNHEALTHY' &&
      /invalid new runtime/.test(error.message),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(currentPath(), 'package.json')))
      .version,
    '1.0.0',
  );
  assert.equal(
    fs.readFileSync(
      path.join(process.env.FIGMA_PLUGIN_STATE_DIR, 'plugin/plugin-runtime.js'),
      'utf8',
    ),
    '1.0.0',
  );
  assert.deepEqual(
    fs.readdirSync(path.join(process.env.FIGMA_PLUGIN_STATE_DIR, 'companion')),
    ['current'],
  );
});
