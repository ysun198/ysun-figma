// launchd owns one receiver per user, including while Codex is closed. A stable
// path lets the receiver itself restart into the newly activated code.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { bridgeStateDirectory, privateDirectory } = require('./state.cjs');
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
async function ensureUpdateService() {
  if (process.env.FIGMA_PLUGIN_DISABLE_UPDATES === '1') return;
  if (process.platform !== 'darwin')
    throw new Error('Automatic updates require macOS');
  const state = bridgeStateDirectory(),
    runtime = path.join(state, 'runtime/node');
  const agents = path.join(os.homedir(), 'Library/LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  privateDirectory(path.join(state, 'updates'));
  const file = path.join(agents, label + '.plist');
  const bootstrap = `(${recoverInstallation.toString()})(${JSON.stringify(state)});require(${JSON.stringify(path.join(currentPath(), 'scripts/update-service.cjs'))}).receive().catch(e=>{console.error(e.message);process.exitCode=1;});`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(runtime)}</string><string>-e</string><string>${xml(bootstrap)}</string></array>
<key>EnvironmentVariables</key><dict><key>FIGMA_PLUGIN_STATE_DIR</key><string>${xml(state)}</string><key>FIGMA_PLUGIN_BUNDLED_NODE</key><string>${xml(runtime)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardErrorPath</key><string>${xml(path.join(state, 'updates/receiver.log'))}</string>
</dict></plist>\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content)
    throw new Error(
      'An existing update service has different settings; it was preserved',
    );
  if (!fs.existsSync(file))
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
  const target = `gui/${process.getuid()}`;
  try {
    await execFile('launchctl', ['print', target + '/' + label]);
  } catch {
    await execFile('launchctl', ['bootstrap', target, file]);
  }
}
async function receive({
  updater = require('./updates.cjs').createUpdater(),
  intervalMs = 300000,
  isEnabled = require('./codex-refresh.cjs').hostEnabled,
} = {}) {
  const { updateStatus } = require('./updates.cjs');
  const folder = path.join(bridgeStateDirectory(), 'updates');
  privateDirectory(folder);
  for (const name of fs.readdirSync(folder))
    if (/^\.download-[\w]+$/.test(name))
      fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  let stopped = false,
    timer;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    updater.dispose();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!stopped) {
    try {
      if (!(await isEnabled())) {
        await execFile('launchctl', [
          'bootout',
          `gui/${process.getuid()}/${label}`,
        ]);
        break;
      }
      if (await updater.check()) break;
    } catch (error) {
      console.error(new Date().toISOString() + ' ' + error.message);
    }
    const delay =
      updateStatus()?.stage === 'waiting_for_idle' ? 30000 : intervalMs;
    await new Promise((resolve) => {
      timer = setTimeout(resolve, delay);
    });
  }
  updater.dispose();
}
if (require.main === module)
  receive().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { ensureUpdateService, receive };
