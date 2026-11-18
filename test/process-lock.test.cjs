const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const test = require('node:test');
const { acquireProcessLock } = require('../src/host/process-lock.cjs');
function fixture(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ysun-process-lock-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const name = 'companion/.install-lock';
  fs.mkdirSync(path.join(state, 'companion'), { mode: 0o700 });
  return {
    state,
    name,
    marker: path.join(state, name),
    lock: (waitMs = 1000) => acquireProcessLock(state, name, waitMs, 'busy'),
  };
}
test('an interrupted process releases the kernel lock while its legacy PID marker can be recovered', async (t) => {
  const f = fixture(t);
  const worker = spawn(
    process.execPath,
    [
      '-e',
      `const [modulePath,state,marker]=process.argv.slice(1);require(modulePath).acquireProcessLock(state,marker,0,'busy').then(lock=>{global.held=lock;process.send('ready');setInterval(()=>{},60000);}).catch(e=>{console.error(e);process.exit(1)});`,
      require.resolve('../src/host/process-lock.cjs'),
      f.state,
      f.name,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(() => worker.kill());
  const exited = once(worker, 'exit');
  const ready = await Promise.race([once(worker, 'message'), exited]);
  assert.equal(ready[0], 'ready');
  await assert.rejects(f.lock(0), /busy/);
  worker.kill('SIGKILL');
  await exited;
  assert(fs.lstatSync(f.marker).isSymbolicLink());
  const next = await f.lock();
  try {
    assert(fs.readlinkSync(f.marker).startsWith(process.pid + '-'));
  } finally {
    next.close();
  }
  assert(!fs.lstatSync(f.marker, { throwIfNoEntry: false }));
});
test('a disappearing legacy symlink can be reacquired and a regular file at the same path is preserved', async (t) => {
  const f = fixture(t),
    token = process.pid + '-' + require('node:crypto').randomUUID();
  fs.symlinkSync(token, f.marker);
  const original = fs.readlinkSync;
  let interrupted = false;
  t.mock.method(fs, 'readlinkSync', function (file, ...args) {
    if (file === f.marker && !interrupted) {
      interrupted = true;
      fs.unlinkSync(file);
      throw Object.assign(Error('readlink'), { code: 'EINVAL' });
    }
    return original.call(fs, file, ...args);
  });
  const next = await f.lock();
  next.close();
  assert(interrupted);
  fs.writeFileSync(f.marker, 'existing user file');
  await assert.rejects(f.lock(), /Invalid process lock/);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'existing user file');
});
