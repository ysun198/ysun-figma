const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureDesktop,
  connectDesktop,
  launchDesktop,
} = require('../src/host/desktop.cjs');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-pipe-test-'));
  const before = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = root;
  const directory = path.join(root, 'desktop/.session-fixture');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const pipes = ['input', 'output'].map((name) => path.join(directory, name));
  execFileSync('/usr/bin/mkfifo', ['-m', '600', ...pipes]);
  const fds = pipes.map((p) => fs.openSync(p, 'r+'));
  const source = `const fs=require('node:fs');const input=fs.openSync(${JSON.stringify(pipes[0])},fs.constants.O_RDWR|fs.constants.O_NONBLOCK);let buffer='';setInterval(()=>{const chunk=Buffer.alloc(65536);try {let n;while((n=fs.readSync(input,chunk,0,chunk.length,null))){buffer+=chunk.subarray(0,n).toString();let end;while((end=buffer.indexOf('\\0'))!==-1){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);fs.writeSync(4,JSON.stringify({id:m.id,result:{method:m.method,echo:m.params.value}})+'\\0');}}}catch(e){if(e.code!=='EAGAIN')throw e;}},5);`;
  const peer = spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'ignore', 'inherit', ...fds],
  });
  fds.forEach((fd) => fs.closeSync(fd));
  await new Promise((resolve, reject) => {
    peer.once('spawn', resolve);
    peer.once('error', reject);
  });
  t.after(async () => {
    peer.kill('SIGTERM');
    await new Promise((resolve) =>
      peer.exitCode !== null || peer.signalCode !== null
        ? resolve()
        : peer.once('exit', resolve),
    );
    if (before === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    peer,
    start: async () => ({ pid: peer.pid, directory }),
    lock: path.join(root, 'desktop/.reader-lock'),
  };
}
test('real FIFO transport releases its dangling owner symlink and reconnects without quitting the peer', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const pipe = await connectDesktop({ start: f.start });
    assert.equal(
      (await pipe.call('Target.getTargets')).method,
      'Target.getTargets',
    );
    await assert.rejects(connectDesktop({ start: f.start }), /reader_busy/);
    pipe.close();
    assert.throws(() => fs.lstatSync(f.lock), { code: 'ENOENT' });
    process.kill(f.peer.pid, 0);
  }
});
test('pipe framing matches concurrent responses and recovers a dead owner without sharing another live reader', async (t) => {
  const f = await fixture(t);
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.once('exit', resolve));
  fs.symlinkSync(dead.pid + '-00000000-0000-0000-0000-000000000000', f.lock);
  const pipe = await connectDesktop({ start: f.start });
  try {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        pipe.call('Runtime.evaluate', { value: 'x'.repeat(2000) + i }),
      ),
    );
    assert.equal(new Set(results.map((r) => r.echo)).size, 30);
  } finally {
    pipe.close();
  }
});
test('ordinary Desktop launch reports a required reconnection without quitting or requesting another login', async () => {
  const calls = [];
  const result = await launchDesktop('CloudFile12', {
    platform: 'darwin',
    connect: async () => {
      throw new Error('desktop_restart_required');
    },
    execute: async (...args) => calls.push(args),
  });
  assert.equal(result.accountConnection, 'restart_required');
  assert.equal(result.state, 'opened');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['-a', 'Figma', 'figma://file/CloudFile12']);
});
test(
  'a clean macOS runner without Figma reports the missing prerequisite before launch',
  {
    skip:
      process.platform !== 'darwin' ||
      [
        '/Applications/Figma.app',
        path.join(os.homedir(), 'Applications/Figma.app'),
      ].some((p) => fs.existsSync(p)),
  },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'figma-missing-desktop-'),
    );
    const before = process.env.FIGMA_PLUGIN_STATE_DIR;
    process.env.FIGMA_PLUGIN_STATE_DIR = root;
    t.after(() => {
      if (before === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
      else process.env.FIGMA_PLUGIN_STATE_DIR = before;
      fs.rmSync(root, { recursive: true, force: true });
    });
    await assert.rejects(ensureDesktop(), /desktop_required/);
    assert.equal(fs.existsSync(path.join(root, 'desktop/session.json')), false);
  },
);
