// Figma owns both ends of private FIFOs. Broker exit cannot close its debugging
// pipe or quit the editor; no TCP debugger, copied cookies or Keychain reader.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const {
  bridgeStateDirectory,
  privateDirectory,
  writePrivateJson,
} = require('./state.cjs');
const folder = () => path.join(bridgeStateDirectory(), 'desktop');
const receiptPath = () => path.join(folder(), 'session.json');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function processes() {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(.+\/Figma\.app\/Contents\/MacOS\/Figma)$/,
    );
    return match ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}
let starting;
function ensureDesktop() {
  if (!starting)
    starting = start().finally(() => {
      starting = null;
    });
  return starting;
}
async function start() {
  if (process.platform !== 'darwin')
    throw new Error('Figma Desktop connection requires macOS');
  privateDirectory(folder());
  const active = await processes();
  let receipt;
  if (fs.existsSync(receiptPath()))
    receipt = JSON.parse(fs.readFileSync(receiptPath(), 'utf8'));
  if (
    receipt &&
    active.some(
      (p) => p.pid === receipt.pid && p.executable === receipt.executable,
    )
  )
    return receipt;
  if (active.length) throw new Error('desktop_restart_required');
  if (receipt) {
    validate(receipt);
    fs.rmSync(receipt.directory, { recursive: true });
    fs.unlinkSync(receiptPath());
  }
  const candidates = [
    path.join('/Applications', 'Figma.app'),
    path.join(os.homedir(), 'Applications/Figma.app'),
  ];
  let app = candidates.find((p) =>
    fs.existsSync(path.join(p, 'Contents/MacOS/Figma')),
  );
  if (!app) {
    const { stdout } = await run('/usr/bin/mdfind', [
      'kMDItemCFBundleIdentifier == "com.figma.Desktop"',
    ]);
    const found = stdout
      .trim()
      .split('\n')
      .filter((p) => fs.existsSync(path.join(p, 'Contents/MacOS/Figma')));
    if (found.length !== 1) throw new Error('desktop_required');
    app = found[0];
  }
  const directory = fs.mkdtempSync(path.join(folder(), '.session-'));
  fs.chmodSync(directory, 0o700);
  const input = path.join(directory, 'input'),
    output = path.join(directory, 'output');
  await run('/usr/bin/mkfifo', ['-m', '600', input, output]);
  // These inherited descriptors must be blocking. NONBLOCK is only used on
  // the broker's separately opened descriptors, never inherited by Chromium.
  const descriptors = [input, output].map((p) => fs.openSync(p, 'r+'));
  try {
    const executable = path.join(app, 'Contents/MacOS/Figma');
    const child = spawn(executable, ['--remote-debugging-pipe'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', ...descriptors],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    receipt = { pid: child.pid, executable, directory };
    writePrivateJson(receiptPath(), receipt);
    child.unref();
    // LaunchServices must not start another instance while this one is still
    // booting. Confirm that the actual browser owns the pipe before opening it.
    const connection = await connectDesktop({ start: async () => receipt });
    connection.close();
    return receipt;
  } catch (error) {
    // A slow startup can time out while the editor is still alive. Preserve its
    // owned pipes and receipt so a later connection can recover without a quit.
    if (receipt?.directory !== directory)
      fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    descriptors.forEach((fd) => fs.closeSync(fd));
  }
}
function validate(receipt) {
  if (
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid <= 1 ||
    path.dirname(receipt.directory) !== folder() ||
    !/^\.session-[\w]+$/.test(path.basename(receipt.directory))
  )
    throw new Error('Invalid Figma desktop session');
  for (const name of ['input', 'output']) {
    const stat = fs.lstatSync(path.join(receipt.directory, name));
    if (
      !stat.isFIFO() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error('Invalid Figma desktop pipe');
  }
}
async function connectDesktop({ start = ensureDesktop } = {}) {
  const receipt = await start();
  validate(receipt);
  const lock = path.join(folder(), '.reader-lock'),
    owner = process.pid + '-' + crypto.randomUUID();
  try {
    fs.symlinkSync(owner, lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = fs.readlinkSync(lock);
    if (!/^\d+-[a-f0-9-]{36}$/.test(previous))
      throw new Error('Invalid Figma desktop reader lock', { cause: error });
    try {
      process.kill(Number(previous.split('-')[0]), 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      if (fs.readlinkSync(lock) === previous) fs.unlinkSync(lock);
      return connectDesktop({ start });
    }
    throw new Error('desktop_reader_busy', { cause: error });
  }
  const pending = new Map();
  let input,
    output,
    timer,
    buffer = Buffer.alloc(0),
    sequence = crypto.randomInt(1, 1000000000),
    sending = Promise.resolve(),
    closed = false;
  function close(error = new Error('desktop_connection_closed')) {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const fd of [input, output]) if (fd !== undefined) fs.closeSync(fd);
    try {
      if (fs.readlinkSync(lock) === owner) fs.unlinkSync(lock);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    input = fs.openSync(
      path.join(receipt.directory, 'input'),
      fs.constants.O_RDWR | fs.constants.O_NONBLOCK,
    );
    output = fs.openSync(
      path.join(receipt.directory, 'output'),
      fs.constants.O_RDWR | fs.constants.O_NONBLOCK,
    );
    const chunk = Buffer.alloc(65536);
    timer = setInterval(() => {
      try {
        process.kill(receipt.pid, 0);
        while (true) {
          let size;
          try {
            size = fs.readSync(output, chunk, 0, chunk.length, null);
          } catch (error) {
            if (error.code === 'EAGAIN') break;
            throw error;
          }
          if (!size) break;
          buffer = Buffer.concat([buffer, chunk.subarray(0, size)]);
          if (buffer.length > 16 * 1024 * 1024)
            throw new Error('desktop_response_too_large');
          let end;
          while ((end = buffer.indexOf(0)) !== -1) {
            const frame = buffer.subarray(0, end);
            buffer = buffer.subarray(end + 1);
            let message;
            try {
              message = JSON.parse(frame.toString());
            } catch {
              // A killed reader may already have consumed a stale frame prefix.
              // Its suffix has no request ID; the next frame starts at NUL.
              continue;
            }
            const request = pending.get(message.id);
            if (request) {
              pending.delete(message.id);
              clearTimeout(request.timer);
              if (message.error)
                request.reject(new Error(message.error.message));
              else request.resolve(message.result);
            }
          }
        }
      } catch (error) {
        close(error);
      }
    }, 20);
    const call = async (method, params = {}, sessionId) => {
      if (closed) throw new Error('desktop_connection_closed');
      const id = ++sequence,
        bytes = Buffer.from(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }) + '\0',
        );
      const answer = new Promise((resolve, reject) => {
        const request = {
          resolve,
          reject,
          timer: setTimeout(() => {
            close(new Error('desktop_request_timeout'));
          }, 15000),
        };
        pending.set(id, request);
      });
      // Observe a rejection even if a broken pipe interrupts the send first.
      answer.catch(() => {});
      try {
        // NONBLOCK writes larger than PIPE_BUF may be partial. Serialize full
        // frames so concurrent requests cannot interleave their JSON bytes.
        const sent = sending.then(async () => {
          let offset = 0;
          while (offset < bytes.length) {
            if (closed) throw new Error('desktop_connection_closed');
            try {
              offset += fs.writeSync(
                input,
                bytes,
                offset,
                bytes.length - offset,
              );
            } catch (error) {
              if (error.code !== 'EAGAIN') throw error;
              await pause(10);
            }
          }
        });
        sending = sent.catch(() => {});
        await sent;
        return await answer;
      } catch (error) {
        close(error);
        throw error;
      }
    };
    await call('Target.getTargets');
    return { call, close };
  } catch (error) {
    close(error);
    throw error;
  }
}
async function launchDesktop(
  key,
  { execute = run, connect = ensureDesktop, platform = process.platform } = {},
) {
  if (platform !== 'darwin')
    throw new Error('Figma Desktop launch requires macOS');
  if (key && !/^[A-Za-z0-9]{6,100}$/.test(key))
    throw new Error('Invalid Figma file key');
  let accountConnection = 'available';
  try {
    await connect();
  } catch (error) {
    if (error.message !== 'desktop_restart_required') throw error;
    accountConnection = 'restart_required';
  }
  await execute(
    '/usr/bin/open',
    ['-a', 'Figma', ...(key ? [`figma://file/${key}`] : [])],
    { timeout: 10000 },
  );
  return { state: 'opened', fileKey: key || null, accountConnection };
}
module.exports = { ensureDesktop, connectDesktop, launchDesktop };
