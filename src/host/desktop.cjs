// Figma owns both ends of private FIFOs. Broker exit cannot close its debugging
// pipe or quit the editor; no TCP debugger, copied cookies or Keychain reader.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const { frameReader } = require('./framing.cjs');
const {
  desktopProcesses: processes,
  findDesktopApp,
  inspectApp,
  installDesktopApp,
  quitDesktop,
} = require('./desktop-app.cjs');
const {
  readRegistration,
  registerDesktopPlugins,
} = require('./desktop-registration.cjs');
const {
  bridgeStateDirectory,
  privateDirectory,
  writePrivateJson,
} = require('./state.cjs');
const folder = () => path.join(bridgeStateDirectory(), 'desktop');
const receiptPath = () => path.join(folder(), 'session.json');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Recovery references outlive a Desktop process. Import existing session
// receipts on first use and commit a new reference as each setup step finishes.
function rememberBackups(setup = {}, legacy = false) {
  const file = path.join(folder(), 'backups.json');
  const previous = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {};
  const paths = { ...previous };
  for (const field of ['previousAppPath', 'settingsBackupPath'])
    if (setup[field] && !(legacy && paths[field])) paths[field] = setup[field];
  if (JSON.stringify(previous) !== JSON.stringify(paths))
    writePrivateJson(file, paths);
  return paths;
}
let lifecycle = Promise.resolve();
function ensureDesktop(options) {
  const next = lifecycle.then(() => start(options));
  lifecycle = next.catch(() => {});
  return next;
}
async function observeDesktop() {
  const active = await processes();
  const receipt = fs.existsSync(receiptPath())
    ? JSON.parse(fs.readFileSync(receiptPath(), 'utf8'))
    : null;
  if (
    receipt &&
    active.some(
      (p) => p.pid === receipt.pid && p.executable === receipt.executable,
    )
  )
    return receipt;
  throw new Error(
    active.length ? 'desktop_restart_required' : 'desktop_not_running',
  );
}
async function start({ restart = false, install = false, beforeRestart } = {}) {
  if (process.platform !== 'darwin')
    throw new Error('Figma Desktop connection requires macOS');
  privateDirectory(folder());
  const active = await processes();
  let receipt;
  if (fs.existsSync(receiptPath()))
    receipt = JSON.parse(fs.readFileSync(receiptPath(), 'utf8'));
  const registration = restart || !active.length ? readRegistration() : null;
  if (
    receipt &&
    active.some(
      (p) => p.pid === receipt.pid && p.executable === receipt.executable,
    ) &&
    !registration?.changes.length
  )
    return receipt;
  if (active.length && !restart) throw new Error('desktop_restart_required');
  if (active.length > 1) throw new Error('desktop_app_ambiguous');
  const application = await applicationForStart(active, install, receipt);
  let app = application.app;
  let guard,
    quit = false;
  try {
    if (active.length) {
      guard = await beforeRestart?.();
      await quitDesktop(active, { processes });
      quit = true;
    }
    const assertStopped = async () => {
      if ((await processes()).length)
        throw new Error('desktop_restart_required');
    };
    let setup = {};
    let backups = rememberBackups(receipt?.setup, true);
    if (application.repair) {
      setup = await installDesktopApp(app, { assertStopped });
      app = setup.app;
      backups = rememberBackups(setup);
    }
    const registered = await registerDesktopPlugins(readRegistration(), {
      assertStopped,
    });
    if (registered) {
      setup = { ...setup, ...registered };
      backups = rememberBackups(registered);
    }
    if (receipt) {
      validate(receipt);
      fs.rmSync(receipt.directory, { recursive: true });
      fs.unlinkSync(receiptPath());
    }
    return await spawnDesktop(app, { ...backups, ...setup });
  } finally {
    guard?.close(quit);
  }
}
async function applicationForStart(active, install, receipt) {
  const executable = active[0]?.executable || receipt?.executable;
  const app =
    executable && fs.existsSync(executable)
      ? path.resolve(executable, '../../..')
      : await findDesktopApp();
  const inspected = app ? await inspectApp(app) : null;
  if (!install && !inspected?.valid)
    throw new Error(app ? 'desktop_app_signature_invalid' : 'desktop_required');
  if (!install && !inspected?.complete)
    throw new Error('desktop_installer_incomplete');
  return { app, repair: !inspected?.valid || !inspected?.complete };
}
async function spawnDesktop(app, setup) {
  let receipt;
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
    receipt = { pid: child.pid, executable, directory, setup };
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
  const pending = new Map(),
    listeners = new Set();
  let input,
    output,
    timer,
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
    listeners.clear();
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
    function acceptFrame(frame) {
      let message;
      try {
        message = JSON.parse(frame.toString());
      } catch {
        // A killed reader may already have consumed a stale frame prefix.
        // Its suffix has no request ID; the next frame starts at NUL.
        return;
      }
      if (message.method)
        for (const listener of listeners) {
          try {
            listener(message);
          } catch {}
        }
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
    }
    const chunk = Buffer.alloc(65536);
    const readFrames = frameReader(0, 16 * 1024 * 1024, acceptFrame, () => {
      throw new Error('desktop_response_too_large');
    });
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
          readFrames(chunk.subarray(0, size));
        }
      } catch (error) {
        close(error);
      }
    }, 20);
    const call = async (method, params = {}, sessionId, options = {}) => {
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
            const error = new Error('desktop_request_timeout');
            if (options.isolatedTimeout) {
              pending.delete(id);
              reject(error);
            } else close(error);
          }, options.timeoutMs || 15000),
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
      } catch (error) {
        close(error);
        throw error;
      }
      return await answer;
    };
    await call('Target.getTargets');
    return {
      call,
      close,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  } catch (error) {
    close(error);
    throw error;
  }
}
async function queuedDesktop(options = {}) {
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      return await connectDesktop(options);
    } catch (error) {
      if (error.message !== 'desktop_reader_busy' || Date.now() >= deadline)
        throw error;
      await pause(50);
    }
  }
}
function runtimeResult(result, unavailable = 'desktop_reader_unavailable') {
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description
        ?.split('\n')[0]
        ?.replace(/^Error: /, '') || unavailable,
    );
  return result.result;
}
async function createPageReader(
  connection,
  sessionId,
  factory,
  unavailable,
  input,
) {
  await connection.call('Runtime.enable', {}, sessionId);
  const objectId = runtimeResult(
    await connection.call(
      'Runtime.evaluate',
      {
        expression:
          '(' +
          factory.toString() +
          ')(' +
          (input === undefined ? '' : JSON.stringify(input)) +
          ')',
        returnByValue: false,
      },
      sessionId,
    ),
    unavailable,
  ).objectId;
  if (!objectId) throw new Error(unavailable);
  return {
    invoke: async (method, ...args) =>
      runtimeResult(
        await connection.call(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration:
              'function(method,args){return this[method](...args)}',
            arguments: [{ value: method }, { value: args }],
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId,
        ),
        unavailable,
      ).value,
    async close() {
      await connection
        .call(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: 'function(){this.close()}',
            returnByValue: true,
          },
          sessionId,
        )
        .catch(() => {});
      await connection
        .call('Runtime.releaseObject', { objectId }, sessionId)
        .catch(() => {});
    },
  };
}
async function launchDesktop(
  key,
  {
    execute = run,
    beforeRestart,
    connect = () =>
      ensureDesktop({ restart: true, install: true, beforeRestart }),
    platform = process.platform,
  } = {},
) {
  if (platform !== 'darwin')
    throw new Error('Figma Desktop launch requires macOS');
  if (key && !/^[A-Za-z0-9]{6,100}$/.test(key))
    throw new Error('Invalid Figma file key');
  const receipt = await connect();
  const app = path.resolve(receipt.executable, '../../..');
  await execute(
    '/usr/bin/open',
    ['-a', app, ...(key ? [`figma://file/${key}`] : [])],
    { timeout: 10000 },
  );
  return {
    state: 'opened',
    fileKey: key || null,
    accountConnection: 'available',
    appPath: app,
    setup: receipt.setup,
  };
}
async function readDesktopFiles({
  fileKey,
  connect = () => queuedDesktop({ start: observeDesktop }),
} = {}) {
  const { parseFigmaUrl } = require('./targets.cjs');
  if (fileKey && !/^[A-Za-z0-9]{6,100}$/.test(fileKey))
    throw new Error('Invalid Figma file key');
  const connection = await connect();
  const files = [],
    issues = [];
  const timeout = setTimeout(
    () => connection.close(new Error('desktop_file_status_timeout')),
    30000,
  );
  try {
    const { targetInfos } = await connection.call('Target.getTargets');
    const candidates = targetInfos.flatMap((target) => {
      let expected;
      try {
        if (target.type !== 'page') return [];
        expected = parseFigmaUrl(target.url);
        if (new URL(target.url).pathname.startsWith('/proto/')) return [];
        if (fileKey && expected.fileKey !== fileKey) return [];
      } catch {
        return [];
      }
      return [{ target, expected }];
    });
    const results = await Promise.all(
      candidates.slice(0, 20).map(async ({ target, expected }) => {
        let sessionId;
        try {
          ({ sessionId } = await connection.call('Target.attachToTarget', {
            targetId: target.targetId,
            flatten: true,
          }));
          await connection.call('Runtime.enable', {}, sessionId);
          const state = runtimeResult(
            await connection.call(
              'Runtime.evaluate',
              {
                expression:
                  '(' +
                  require('./editor-reader.js').createEditorReader.toString() +
                  ')().status()',
                returnByValue: true,
              },
              sessionId,
              { timeoutMs: 2500, isolatedTimeout: true },
            ),
            'desktop_file_state_unavailable',
          ).value;
          const actual = parseFigmaUrl(state.url);
          if (
            actual.fileKey !== expected.fileKey ||
            (state.openFileKey && state.openFileKey !== actual.fileKey)
          )
            throw new Error('desktop_file_identity_changed');
          const url = new URL(state.url);
          url.search = '';
          url.hash = '';
          return {
            file: {
              targetId: target.targetId,
              fileKey: actual.fileKey,
              url: url.href,
              documentReady: state.documentReady,
              editorLoaded: state.editorLoaded,
              saveStatus: state.saveStatus || null,
              ...(state.desktopAdapter
                ? { desktopAdapter: state.desktopAdapter }
                : {}),
            },
          };
        } catch (error) {
          return {
            issue: {
              targetId: target.targetId,
              fileKey: expected.fileKey,
              error: String(error.message || error).slice(0, 200),
            },
          };
        } finally {
          if (sessionId)
            await connection
              .call('Target.detachFromTarget', { sessionId })
              .catch(() => {});
        }
      }),
    );
    for (const result of results) {
      if (result.file) files.push(result.file);
      else issues.push(result.issue);
    }
    if (candidates.length > 20)
      issues.push({
        targetId: candidates[20].target.targetId,
        fileKey: candidates[20].expected.fileKey,
        error: 'desktop_file_status_limit; filter by exact fileKey',
      });
    return {
      files,
      issues,
      complete: issues.length === 0,
      note: 'Observed Desktop URLs, renderer load state and native save-status flags. Clean save flags are editor evidence, not an independent cloud content readback.',
    };
  } finally {
    clearTimeout(timeout);
    connection.close();
  }
}
module.exports = {
  ensureDesktop,
  connectDesktop,
  queuedDesktop,
  launchDesktop,
  readDesktopFiles,
  runtimeResult,
  createPageReader,
  observeDesktop,
  rememberBackups,
};
