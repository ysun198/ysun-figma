const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareManagedCompanion,
  currentPath,
} = require('../src/host/installation.cjs');
const { serviceDefinition } = require('../src/host/update-service.cjs');
const launcher = path.resolve(__dirname, '../scripts/run-node.sh');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma runtime '));
  const before = { ...process.env };
  process.env.FIGMA_PLUGIN_STATE_DIR = path.join(root, 'state with spaces');
  t.after(() => {
    for (const key of [
      'FIGMA_PLUGIN_STATE_DIR',
      'FIGMA_PLUGIN_NODE',
      'FIGMA_PLUGIN_NODE_ENGINE',
    ]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('shared runtime launcher preserves argument boundaries and reuses an existing runtime', (t) => {
  const root = fixture(t),
    alias = path.join(root, 'existing node');
  fs.symlinkSync(process.execPath, alias);
  const input = 'space \' " $(untrusted) `untrusted`\nnext line';
  const output = execFileSync(
    '/bin/sh',
    [
      launcher,
      '-e',
      'console.log(JSON.stringify({ input: process.argv[1], node: process.env.FIGMA_PLUGIN_NODE }))',
      input,
    ],
    {
      env: { ...process.env, FIGMA_PLUGIN_NODE: alias },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.deepEqual(JSON.parse(output), { input, node: alias });
  assert.deepEqual(fs.readdirSync(root), ['existing node']);
});

test('missing or unsupported runtime requirements stop before executing application code', (t) => {
  fixture(t);
  for (const requirement of ['>=999', '^24']) {
    assert.throws(
      () =>
        execFileSync('/bin/sh', [launcher, '-e', 'console.log("executed")'], {
          env: { ...process.env, FIGMA_PLUGIN_NODE_ENGINE: requirement },
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (error) => {
        assert.equal(error.stdout, '');
        assert.match(
          error.stderr,
          requirement === '>=999'
            ? /requires Node.js 999/
            : /Unsupported Node.js engine requirement/,
        );
        return true;
      },
    );
  }
});

test('actual launchd command recovers interrupted activation even after the original runtime path disappears', async (t) => {
  const root = fixture(t),
    source = path.join(root, 'source'),
    state = process.env.FIGMA_PLUGIN_STATE_DIR;
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'src/host'), { recursive: true });
  const files = [
    'manifest.json',
    'plugin-runtime.js',
    'ui.html',
    'scripts/run-node.sh',
    'src/host/update-service.cjs',
  ];
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'figma-plugin-local',
      version: '1.0.0',
      engines: { node: '>=24' },
      distributionFiles: files,
    }),
  );
  fs.writeFileSync(path.join(source, 'README.md'), 'fixture');
  for (const name of files.slice(0, 3))
    fs.writeFileSync(path.join(source, name), 'original');
  fs.copyFileSync(launcher, path.join(source, 'scripts/run-node.sh'));
  const marker = path.join(state, 'receiver started');
  fs.writeFileSync(
    path.join(source, 'src/host/update-service.cjs'),
    `exports.receive = async () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');`,
  );
  await prepareManagedCompanion(source);
  const originalNode = path.join(root, 'removed node');
  fs.symlinkSync(process.execPath, originalNode);
  process.env.FIGMA_PLUGIN_NODE = originalNode;
  const plist = path.join(root, 'service.plist');
  fs.writeFileSync(plist, serviceDefinition(state));
  const definition = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
      encoding: 'utf8',
    }),
  );
  const staging = path.join(state, 'companion/.install-interrupted');
  fs.mkdirSync(staging);
  fs.renameSync(currentPath(), path.join(staging, 'replaced'));
  fs.writeFileSync(
    path.join(state, 'companion/.activation.json'),
    JSON.stringify({ staging }),
  );
  fs.unlinkSync(originalNode);
  fs.mkdirSync(path.join(state, 'node/bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(state, 'node/bin/node'));
  execFileSync(
    definition.ProgramArguments[0],
    definition.ProgramArguments.slice(1),
    {
      env: { ...process.env, ...definition.EnvironmentVariables },
      timeout: 5000,
    },
  );
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ready');
  assert.equal(fs.existsSync(staging), false);
  assert.equal(
    fs.readFileSync(path.join(state, 'plugin/ui.html'), 'utf8'),
    'original',
  );
});
