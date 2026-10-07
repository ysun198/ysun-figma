const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
    /invalid new runtime/,
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
