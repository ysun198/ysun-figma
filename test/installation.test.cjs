const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  verify,
  currentPath,
  prepareManagedCompanion,
} = require('../src/host/installation.cjs');
const { readLedger, seedLedger } = require('./helpers/ledger.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-install-')),
    state = path.join(root, 'state'),
    before = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = state;
  t.after(() => {
    if (before === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(state);
  seedLedger(path.join(state, 'operations.sqlite'), [
    {
      id: 'installation-original-uncertain',
      status: 'outcome_unknown',
      result: { proof: 'original receipts' },
    },
  ]);
  fs.writeFileSync(path.join(state, 'authorizations.json'), 'original grants');
  function source(version) {
    const dir = path.join(root, 'package-' + version);
    fs.mkdirSync(dir);
    const files = ['manifest.json', 'plugin-runtime.js', 'ui.html'];
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'figma-plugin-local',
        version,
        distributionFiles: files,
      }),
    );
    fs.writeFileSync(path.join(dir, 'README.md'), 'Public package');
    for (const file of files) fs.writeFileSync(path.join(dir, file), version);
    return dir;
  }
  return { root, state, source };
}
test('updates retain one current package, replace obsolete code and preserve private records', async (t) => {
  const f = fixture(t),
    first = f.source('1.0.0');
  assert.equal((await prepareManagedCompanion(first)).changed, true);
  assert.equal((await prepareManagedCompanion(first)).changed, false);
  fs.unlinkSync(path.join(f.state, 'plugin/ui.html'));
  await prepareManagedCompanion(first);
  assert.equal(
    fs.readFileSync(path.join(f.state, 'plugin/ui.html'), 'utf8'),
    '1.0.0',
  );
  await prepareManagedCompanion(f.source('1.1.0'));
  assert.equal(verify(currentPath()).version, '1.1.0');
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'companion')), [
    'current',
  ]);
  assert.equal(
    fs.readFileSync(path.join(f.state, 'plugin/ui.html'), 'utf8'),
    '1.1.0',
  );
  assert.equal(
    readLedger(path.join(f.state, 'operations.sqlite')).jobs[0].result.proof,
    'original receipts',
  );
  assert.equal(
    fs.readFileSync(path.join(f.state, 'authorizations.json'), 'utf8'),
    'original grants',
  );
  assert.deepEqual(await prepareManagedCompanion(first), {
    version: '1.1.0',
    changed: false,
  });
  assert.equal(
    fs.readFileSync(path.join(currentPath(), 'ui.html'), 'utf8'),
    '1.1.0',
  );
});
test('same-version changes, modified code, symlinks and hidden public paths are rejected', async (t) => {
  const f = fixture(t),
    source = f.source('1.0.0');
  await prepareManagedCompanion(source);
  fs.writeFileSync(path.join(source, 'ui.html'), 'changed');
  await assert.rejects(prepareManagedCompanion(source), /different contents/);
  fs.writeFileSync(path.join(currentPath(), 'ui.html'), 'user replacement');
  await assert.rejects(prepareManagedCompanion(f.source('1.1.0')), /modified/);
  assert.equal(
    fs.readFileSync(path.join(currentPath(), 'ui.html'), 'utf8'),
    'user replacement',
  );
  const bad = f.source('2.0.0');
  fs.unlinkSync(path.join(bad, 'ui.html'));
  fs.symlinkSync(path.join(source, 'ui.html'), path.join(bad, 'ui.html'));
  await assert.rejects(prepareManagedCompanion(bad), /symlinks/);
  const hidden = f.source('3.0.0'),
    pkg = JSON.parse(fs.readFileSync(path.join(hidden, 'package.json')));
  pkg.distributionFiles.push('.env');
  fs.writeFileSync(path.join(hidden, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(prepareManagedCompanion(hidden), /public package path/);
});
test('a reusable current package cannot bypass an unfinished activation journal', async (t) => {
  const f = fixture(t),
    older = f.source('1.0.0');
  await prepareManagedCompanion(older);
  const staging = path.join(f.state, 'companion/.install-uncommitted');
  fs.mkdirSync(staging);
  fs.cpSync(currentPath(), path.join(staging, 'replaced'), { recursive: true });
  await prepareManagedCompanion(f.source('1.1.0'));
  fs.writeFileSync(
    path.join(f.state, 'companion/.activation.json'),
    JSON.stringify({ staging }),
  );
  assert.equal((await prepareManagedCompanion(older)).version, '1.0.0');
  assert.equal(verify(currentPath()).version, '1.0.0');
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'companion')), [
    'current',
  ]);
});
test('recovery holds the installation lock before reading the journal and serializes a newer installation', async (t) => {
  const f = fixture(t),
    { spawn } = require('node:child_process');
  await prepareManagedCompanion(f.source('1.0.0'));
  const newer = f.source('1.1.0'),
    staging = path.join(f.state, 'companion/.install-interrupted'),
    release = path.join(f.root, 'release-recovery');
  fs.mkdirSync(staging);
  fs.renameSync(currentPath(), path.join(staging, 'replaced'));
  fs.writeFileSync(
    path.join(f.state, 'companion/.activation.json'),
    JSON.stringify({ staging }),
  );
  let locked, failed;
  const entered = new Promise((resolve, reject) => {
    locked = resolve;
    failed = reject;
  });
  async function worker() {
    const fs = require('node:fs'),
      path = require('node:path'),
      assert = require('node:assert/strict');
    const [modulePath, source, role, release] = process.argv.slice(1),
      state = process.env.FIGMA_PLUGIN_STATE_DIR,
      journal = path.join(state, 'companion/.activation.json'),
      read = fs.readFileSync;
    let held = false;
    fs.readFileSync = (file, ...options) => {
      if (file === journal) {
        assert.equal(
          Number(
            fs
              .readlinkSync(path.join(state, 'companion/.install-lock'))
              .split('-')[0],
          ),
          process.pid,
          'Recovery must own the installation lock before reading its journal',
        );
        if (role === 'recover' && !held) {
          held = true;
          process.send('locked');
          const deadline = Date.now() + 5000,
            pause = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(release)) {
            if (Date.now() >= deadline)
              throw new Error('Recovery barrier timed out');
            Atomics.wait(pause, 0, 0, 10);
          }
        }
      }
      return read(file, ...options);
    };
    const installation = require(modulePath);
    process.send('started');
    if (role === 'recover') await installation.recoverInstallation(state);
    else await installation.prepareManagedCompanion(source);
  }
  const run = (role) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `(${worker.toString()})().then(()=>process.exit(0),e=>{console.error(e.stack);process.exit(1)});`,
        path.resolve(__dirname, '../src/host/installation.cjs'),
        newer,
        role,
        release,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    t.after(() => child.kill());
    let error = '';
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    child.on('message', (message) => {
      if (role === 'recover' && message === 'locked') locked();
      if (role === 'install' && message === 'started')
        fs.writeFileSync(release, 'go');
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else {
          const failure = new Error(error || 'worker exited ' + code);
          failed(failure);
          reject(failure);
        }
      });
    });
    void done.catch(() => {});
    return done;
  };
  const recovering = run('recover');
  await entered;
  await Promise.all([recovering, run('install')]);
  assert.equal(verify(currentPath()).version, '1.1.0');
  assert.equal(
    fs.readFileSync(path.join(f.state, 'plugin/ui.html'), 'utf8'),
    '1.1.0',
  );
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'companion')), [
    'current',
  ]);
  assert.equal(
    readLedger(path.join(f.state, 'operations.sqlite')).jobs[0].result.proof,
    'original receipts',
  );
});
test('unrecorded installation files are preserved instead of being silently deleted by an update', async (t) => {
  const f = fixture(t);
  await prepareManagedCompanion(f.source('1.0.0'));
  const extra = path.join(currentPath(), 'user-file.txt');
  fs.writeFileSync(extra, 'unrecorded user file');
  await assert.rejects(prepareManagedCompanion(f.source('1.1.0')), /modified/);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'unrecorded user file');
});
test('an unchanged verified installation starts without an exclusive lock, runtime copies or file rewrites', async (t) => {
  const f = fixture(t),
    source = f.source('1.0.0');
  await prepareManagedCompanion(source);
  const files = [
    path.join(currentPath(), '.installation.json'),
    ...['manifest.json', 'plugin-runtime.js', 'ui.html'].map((name) =>
      path.join(f.state, 'plugin', name),
    ),
  ];
  const original = files.map((file) => fs.statSync(file).mtimeMs),
    lock = t.mock.method(fs, 'symlinkSync');
  const started = await prepareManagedCompanion(source);
  assert.equal(started.changed, false);
  assert.equal(lock.mock.callCount(), 0);
  assert.deepEqual(
    files.map((file) => fs.statSync(file).mtimeMs),
    original,
  );
  assert(!fs.existsSync(path.join(f.state, 'node')));
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'companion')), [
    'current',
  ]);
});
test('concurrent Codex launches converge on the newest package and reclaim a dead installation owner', async (t) => {
  const f = fixture(t),
    { spawn } = require('node:child_process');
  const sources = ['1.0.0', '1.1.0', '1.2.0'].map(f.source);
  const script =
    'require(process.argv[1]).prepareManagedCompanion(process.argv[2]).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)});';
  const run = (source) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          script,
          path.resolve(__dirname, '../src/host/installation.cjs'),
          source,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      t.after(() => child.kill());
      let error = '';
      child.stderr.on('data', (chunk) => {
        error += chunk;
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(error || 'installer exited ' + code)),
      );
    });
  await Promise.all([...sources, ...sources.reverse()].map(run));
  assert.equal(verify(currentPath()).version, '1.2.0');
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'companion')), [
    'current',
  ]);
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => dead.once('exit', resolve));
  fs.symlinkSync(
    dead.pid + '-' + require('node:crypto').randomUUID(),
    path.join(f.state, 'companion/.install-lock'),
  );
  assert.equal((await prepareManagedCompanion(sources[0])).changed, false);
  assert.deepEqual(fs.readdirSync(path.join(f.state, 'companion')), [
    'current',
  ]);
});
