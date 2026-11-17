const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const { bridgeStateDirectory, privateDirectory } = require('./state.cjs');
const FIGMA_SIGNER =
  '=anchor apple generic and certificate leaf[subject.OU] = "T8RA8NE3B7"';
const bundleIds = ['com.figma.Desktop', 'com.figma.Desktop.dua'];
const DESKTOP_SETUP_TIMEOUT_MS = 32 * 60 * 1000;

async function inspectApp(app, execute = run) {
  const plist = path.join(app, 'Contents/Info.plist');
  const property = async (name) =>
    (
      await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :' + name, plist])
    ).stdout.trim();
  const id = await property('CFBundleIdentifier');
  if (!bundleIds.includes(id))
    throw new Error('desktop_app_identity_changed: ' + app);
  let valid = false;
  let signatureError;
  try {
    await execute('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '-R',
      FIGMA_SIGNER,
      app,
    ]);
    valid = true;
  } catch (error) {
    // A damaged official bundle is repaired as a whole, never re-signed.
    signatureError = error;
  }
  return {
    app,
    id,
    valid,
    signatureError,
    complete: id === 'com.figma.Desktop',
  };
}

async function findDesktopApp({ execute = run, home = os.homedir() } = {}) {
  for (const app of [
    '/Applications/Figma.app',
    path.join(home, 'Applications/Figma.app'),
  ])
    if (fs.existsSync(path.join(app, 'Contents/Info.plist'))) return app;
  const { stdout } = await execute('/usr/bin/mdfind', [
    bundleIds
      .map((id) => 'kMDItemCFBundleIdentifier == "' + id + '"')
      .join(' || '),
  ]);
  const found = [...new Set(stdout.trim().split('\n'))].filter(
    (app) =>
      app &&
      !app.split(path.sep).some((part) => part.startsWith('.')) &&
      fs.existsSync(path.join(app, 'Contents/Info.plist')),
  );
  if (found.length > 1) throw new Error('desktop_app_ambiguous');
  return found[0] || null;
}

// LaunchServices supplies the actual executable even when the bundle was renamed.
async function desktopProcesses(execute = run) {
  const script = `ObjC.import('AppKit');
    function run(ids) {
      const found = [];
      for (const id of ids) {
        const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id);
        for (let i=0; i<apps.count; i++) {
          const app = apps.objectAtIndex(i);
          found.push({pid: app.processIdentifier, executable: ObjC.unwrap(app.executableURL.path)});
        }
      }
      return JSON.stringify(found);
    }`;
  const { stdout } = await execute(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', script, ...bundleIds],
    { timeout: 5000 },
  );
  return JSON.parse(stdout);
}

async function downloadArchive(execute, archive, url) {
  const partial = fs.statSync(archive).size > 0;
  const transfer = (resume) =>
    execute(
      '/usr/bin/curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--connect-timeout',
        '20',
        '--max-time',
        '1800',
        '--speed-time',
        '30',
        '--speed-limit',
        '1024',
        ...(resume ? ['--continue-at', '-'] : []),
        '--write-out',
        '%{response_code}',
        '--max-filesize',
        String(512 * 1024 * 1024),
        '--output',
        archive,
        url,
      ],
      { timeout: 1810000 },
    );
  try {
    await transfer(partial);
  } catch (error) {
    // A retained complete file may receive 416. The unpack/signature checks
    // below determine if those bytes are usable. Exit 33 means no range support.
    if (partial && error.code === 22 && error.stdout?.trim() === '416') return;
    if (!partial || error.code !== 33) throw error;
    await transfer(false);
  }
}

// Download the complete architecture-specific application, not the GUI stub.
// Staging and the retained previous bundle share the destination filesystem.
async function installDesktopApp(
  app,
  {
    execute = run,
    home = os.homedir(),
    arch = process.arch,
    assertStopped = async () => {},
  } = {},
) {
  const channel = { arm64: 'mac-arm', x64: 'mac' }[arch];
  if (!channel) throw new Error('Unsupported Figma Desktop architecture');
  let destination = app || path.join(home, 'Applications/Figma.app');
  try {
    fs.accessSync(path.dirname(destination), fs.constants.W_OK);
  } catch {
    destination = path.join(home, 'Applications/Figma.app');
  }
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.ysun-figma-'));
  fs.chmodSync(staging, 0o700);
  let archive;
  const unpacked = path.join(staging, 'unpacked'),
    previous = path.join(staging, 'previous.app');
  try {
    const { stdout } = await execute(
      '/usr/bin/curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--max-time',
        '20',
        'https://desktop.figma.com/mac/version.txt',
      ],
      { timeout: 25000 },
    );
    const version = stdout.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new Error('desktop_download_version_invalid');
    const cache = path.join(bridgeStateDirectory(), 'desktop/downloads');
    privateDirectory(cache);
    archive = path.join(cache, `Figma-${channel}-${version}.zip`);
    if (!fs.existsSync(archive))
      fs.writeFileSync(archive, '', { mode: 0o600, flag: 'wx' });
    await downloadArchive(
      execute,
      archive,
      `https://desktop.figma.com/${channel}/Figma-${version}.zip`,
    );
    const incoming = path.join(unpacked, 'Figma.app');
    try {
      await execute('/usr/bin/ditto', ['-x', '-k', archive, unpacked], {
        timeout: 30000,
      });
      const verified = await inspectApp(incoming, execute);
      if (!verified.valid || !verified.complete)
        throw new Error(
          'desktop_app_signature_invalid: ' +
            (verified.signatureError?.stderr?.trim() ||
              'downloaded application'),
          { cause: verified.signatureError },
        );
    } catch (error) {
      fs.rmSync(archive, { force: true });
      throw error;
    }
    await assertStopped();
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try {
      fs.renameSync(incoming, destination);
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
    fs.rmSync(archive, { force: true });
    return {
      app: destination,
      version,
      installed: true,
      ...(fs.existsSync(previous) ? { previousAppPath: previous } : {}),
    };
  } finally {
    if (fs.existsSync(previous)) {
      fs.rmSync(unpacked, { recursive: true, force: true });
    } else fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function quitDesktop(
  active,
  { execute = run, processes, timeoutMs = 15000 } = {},
) {
  // NSRunningApplication asks the observed PID to quit normally. Figma retains
  // its own save/cancel dialogs; neither SIGTERM nor forceTerminate is used.
  for (const { pid } of active) {
    await execute(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        'ObjC.import("AppKit"); function run(argv) { return $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])).terminate; }',
        String(pid),
      ],
      { timeout: 5000 },
    );
  }
  const deadline = Date.now() + timeoutMs;
  while ((await processes()).length) {
    if (Date.now() >= deadline) throw new Error('desktop_quit_pending');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = {
  desktopProcesses,
  findDesktopApp,
  inspectApp,
  installDesktopApp,
  quitDesktop,
  DESKTOP_SETUP_TIMEOUT_MS,
};
