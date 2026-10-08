// Move the serving process out of the host's disposable plugin cache.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { currentPath, prepareManagedCompanion } = require('./installation.cjs');

async function launch() {
  const source = path.resolve(__dirname, '../..');
  await prepareManagedCompanion(source);
  const child = spawn(
    '/bin/sh',
    [
      path.join(currentPath(), 'scripts/run-node.sh'),
      path.join(currentPath(), 'src/host/mcp.cjs'),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') console.error(error.message);
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => child.kill(signal));
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  // Never hold MCP discovery behind a network check or launchd registration.
  void require(path.join(currentPath(), 'src/host/update-service.cjs'))
    .ensureUpdateService()
    .catch((error) => console.error('Automatic updates: ' + error.message));
}
launch().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
