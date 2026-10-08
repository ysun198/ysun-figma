// launchd owns one receiver per user, including while Codex is closed. A stable
// path lets the receiver itself restart into the newly activated code.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const {
  bridgeStateDirectory,
  privateDirectory,
  writePrivateJson,
} = require('./state.cjs');
const { currentPath, recoverInstallation } = require('./installation.cjs');
const label = 'com.ysun.figma.updates';
const xml = (value) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c],
  );
function serviceDefinition(state) {
  const launcher = fs.readFileSync(
    path.join(currentPath(), 'scripts/run-node.sh'),
    'utf8',
  );
  const engine = require(path.join(currentPath(), 'package.json')).engines.node;
  const bootstrap = `(${recoverInstallation.toString()})(${JSON.stringify(state)});require(${JSON.stringify(path.join(currentPath(), 'src/host/update-service.cjs'))}).receive().catch(e=>{console.error(e.message);process.exitCode=1;});`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${xml(launcher)}</string><string>ysun-figma-node</string><string>-e</string><string>${xml(bootstrap)}</string></array>
<key>EnvironmentVariables</key><dict><key>FIGMA_PLUGIN_STATE_DIR</key><string>${xml(state)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>FIGMA_PLUGIN_NODE</key><string>${xml(process.env.FIGMA_PLUGIN_NODE || process.execPath)}</string><key>FIGMA_PLUGIN_NODE_ENGINE</key><string>${xml(engine)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardErrorPath</key><string>${xml(path.join(state, 'updates/receiver.log'))}</string>
</dict></plist>\n`;
}
async function ensureUpdateService() {
  if (process.env.FIGMA_PLUGIN_DISABLE_UPDATES === '1') return;
  if (process.platform !== 'darwin')
    throw new Error('Automatic updates require macOS');
  const state = bridgeStateDirectory();
  const agents = path.join(os.homedir(), 'Library/LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  privateDirectory(path.join(state, 'updates'));
  const file = path.join(agents, label + '.plist');
  const receiptPath = path.join(state, 'updates/service.json');
  const content = serviceDefinition(state);
  const target = `gui/${process.getuid()}`;
  const digest = (value) =>
    crypto.createHash('sha256').update(value).digest('hex');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) {
    if (
      !fs.existsSync(receiptPath) ||
      JSON.parse(fs.readFileSync(receiptPath)).sha256 !==
        digest(fs.readFileSync(file))
    )
      throw new Error(
        'An existing update service has different settings; it was preserved',
      );
    // A missing service reports a nonzero status; an actually running service
    // must stop before replacing its launch configuration.
    try {
      await execFile('launchctl', ['bootout', target + '/' + label]);
    } catch (error) {
      let running = true;
      try {
        await execFile('launchctl', ['print', target + '/' + label]);
      } catch {
        running = false;
      }
      if (running) throw error;
    }
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  if (!fs.existsSync(file))
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
  writePrivateJson(receiptPath, { sha256: digest(content) });
  try {
    await execFile('launchctl', ['print', target + '/' + label]);
  } catch {
    await execFile('launchctl', ['bootstrap', target, file]);
    return;
  }
  await execFile('launchctl', ['kill', 'SIGUSR1', target + '/' + label]);
}
async function receive({
  updater = require('./updates.cjs').createUpdater(),
  isEnabled = require('./codex-refresh.cjs').hostEnabled,
  signals = process,
} = {}) {
  const folder = path.join(bridgeStateDirectory(), 'updates');
  privateDirectory(folder);
  for (const name of fs.readdirSync(folder))
    if (/^\.download-[\w]+$/.test(name))
      fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  let stopped = false,
    opening = true,
    wake;
  const stop = () => {
    stopped = true;
    updater.cancel();
    wake?.();
  };
  const onOpen = () => {
    opening = true;
    wake?.();
  };
  signals.once('SIGTERM', stop);
  signals.once('SIGINT', stop);
  signals.on('SIGUSR1', onOpen);
  try {
    while (!stopped) {
      const delay = updater.nextDelay({ onOpen: opening });
      opening = false;
      if (delay > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(
            () => {
              wake = undefined;
              resolve();
            },
            Math.min(delay, 2147483647),
          ); // Node timers use a signed 32-bit delay.
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
        continue;
      }
      let checked = false;
      try {
        if (!(await isEnabled())) {
          await execFile('launchctl', [
            'bootout',
            `gui/${process.getuid()}/${label}`,
          ]);
          break;
        }
        checked = true;
        if (!stopped && (await updater.check())) break;
      } catch (error) {
        if (!stopped) {
          if (!checked) updater.defer(error);
          console.error(new Date().toISOString() + ' ' + error.message);
        }
      }
      if (updater.restartRequired()) break;
    }
  } finally {
    signals.removeListener('SIGTERM', stop);
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGUSR1', onOpen);
    updater.dispose();
  }
}
if (require.main === module)
  receive().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { ensureUpdateService, serviceDefinition, receive };
