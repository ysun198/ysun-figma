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
  readDesktopFiles,
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
test('Desktop file status reads exact URLs without navigation and preserves duplicate instances', async () => {
  const calls = [];
  let closed = false;
  const result = await readDesktopFiles({
    fileKey: 'CloudFile12',
    connect: async () => ({
      async call(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        if (method === 'Target.getTargets')
          return {
            targetInfos: [
              {
                type: 'page',
                targetId: 'home',
                url: 'https://www.figma.com/files',
              },
              {
                type: 'page',
                targetId: 'wrong-origin',
                url: 'https://example.com/design/CloudFile12',
              },
              {
                type: 'page',
                targetId: 'other',
                url: 'https://www.figma.com/design/OtherFile12',
              },
              ...['first', 'second'].map((targetId) => ({
                type: 'page',
                targetId,
                url: 'https://www.figma.com/design/CloudFile12/Test?t=tracking',
              })),
            ],
          };
        if (method === 'Target.attachToTarget')
          return { sessionId: params.targetId };
        if (method === 'Runtime.enable') return {};
        if (method === 'Runtime.evaluate')
          return {
            result: {
              value: {
                url: 'https://www.figma.com/design/CloudFile12/Test?t=tracking',
                openFileKey: 'CloudFile12',
                documentReady: 'complete',
                editorLoaded: sessionId === 'first',
              },
            },
          };
        if (method === 'Target.detachFromTarget') return {};
        assert.fail('Unexpected Desktop mutation: ' + method);
      },
      close() {
        closed = true;
      },
    }),
  });
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.files.map((f) => [f.targetId, f.fileKey, f.editorLoaded]),
    [
      ['first', 'CloudFile12', true],
      ['second', 'CloudFile12', false],
    ],
  );
  assert(
    result.files.every(
      (f) => f.url === 'https://www.figma.com/design/CloudFile12/Test',
    ),
  );
  assert.equal(
    calls.filter((c) => c.method === 'Target.attachToTarget').length,
    2,
  );
  assert.equal(
    calls.filter((c) => c.method === 'Target.detachFromTarget').length,
    2,
  );
  assert.equal(closed, true);
});
test('Desktop file status discloses changed identities and unreadable renderers, releases sessions and bounds the scan', async () => {
  const detached = [];
  let closed = false;
  const result = await readDesktopFiles({
    connect: async () => ({
      async call(method, params = {}, sessionId) {
        if (method === 'Target.getTargets')
          return {
            targetInfos: Array.from({ length: 25 }, (_, i) => ({
              type: 'page',
              targetId: String(i),
              url: 'https://www.figma.com/design/CloudFile12/Test',
            })),
          };
        if (method === 'Target.attachToTarget')
          return { sessionId: params.targetId };
        if (method === 'Runtime.enable') return {};
        if (method === 'Runtime.evaluate') {
          if (sessionId === '0')
            return {
              result: {
                value: {
                  url: 'https://www.figma.com/design/ChangedFile12/Test',
                },
              },
            };
          if (sessionId === '1')
            return {
              exceptionDetails: {
                exception: { description: 'Error: renderer unavailable' },
              },
            };
          return {
            result: {
              value: {
                url: 'https://www.figma.com/design/CloudFile12/Test',
                documentReady: 'complete',
                editorLoaded: null,
              },
            },
          };
        }
        if (method === 'Target.detachFromTarget') {
          detached.push(params.sessionId);
          return {};
        }
        assert.fail(method);
      },
      close() {
        closed = true;
      },
    }),
  });
  assert.equal(result.complete, false);
  assert.equal(result.files.length, 18);
  assert.deepEqual(
    result.issues.map((i) => i.error),
    [
      'desktop_file_identity_changed',
      'renderer unavailable',
      'desktop_file_status_limit; filter by exact fileKey',
    ],
  );
  assert(result.files.every((f) => f.editorLoaded === null));
  assert.equal(detached.length, 20);
  assert.equal(closed, true);
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
