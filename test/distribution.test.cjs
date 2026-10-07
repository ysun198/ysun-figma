const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditRelease,
  inspectPublicFiles,
} = require('../scripts/audit-release.cjs');
const { installPlugin, bridgeStateDirectory } = require('../scripts/state.cjs');
const { readLedger, seedLedger } = require('../test-support/ledger.cjs');

test('the single production package excludes runtime state, history and development tools', () => {
  const { files } = auditRelease();
  assert(files.includes('scripts/launch-mcp.cjs'));
  assert(files.includes('manifest.json'));
  assert(files.includes('docs/INSTALL.md'));
  assert(files.includes('LICENSE'));
  assert(files.includes('NOTICE.md'));
  assert(
    files.every(
      (file) =>
        !/^\.(?:bridge|local|git)|^test|^designs|^scripts\/(?:release|audit-release)/.test(
          file,
        ),
    ),
  );
});

test('release audit rejects hidden data and credentials while accepting semantic design tokens', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canvas-public-audit-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ distributionFiles: ['example.json'] }),
  );
  const source = path.join(directory, 'example.json');
  fs.writeFileSync(source, '{"token":"color-background-primary"}');
  assert.equal(inspectPublicFiles(directory, ['example.json']), 1);
  fs.writeFileSync(source, '{"token":"0123456789abcdef0123456789abcdef"}');
  assert.throws(
    () => inspectPublicFiles(directory, ['example.json']),
    /bearer token/,
  );
  fs.writeFileSync(source, 'local path /Users/example/private/file.txt');
  assert.throws(
    () => inspectPublicFiles(directory, ['example.json']),
    /filesystem path/,
  );
  assert.throws(
    () => inspectPublicFiles(directory, ['.bridge/connection.json']),
    /Non-public file/,
  );
});

test('distributed SVG artwork excludes executable content, metadata and external resources', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-artwork-audit-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'assets'));
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ distributionFiles: ['assets/icon.svg'] }),
  );
  const source = fs.readFileSync(
      path.join(__dirname, '../assets/icon.svg'),
      'utf8',
    ),
    target = path.join(directory, 'assets/icon.svg');
  fs.writeFileSync(target, source);
  assert.equal(inspectPublicFiles(directory, ['assets/icon.svg']), 1);
  for (const injected of [
    '<script>alert(1)</script>',
    '<image href="https://example.com/asset.png"/>',
    '<metadata>private</metadata>',
    '<rect onload="alert(1)"/>',
    '<style>svg{background:url(https://example.com/asset)}</style>',
    '<style>svg{display:none}</style>',
    '<style>@import "https://example.com/style.css";</style>',
    '<style>:root{color:#000000;background:#FFFFFF}</style>',
    '<style>:root{color:color-mix(in srgb,#000000 101%,#ffffff)}@media(prefers-color-scheme:dark){:root{color:#ffffff}}</style>',
    '<style>:root{color:color-mix(in srgb,var(--external) 65%,#ffffff)}@media(prefers-color-scheme:dark){:root{color:#ffffff}}</style>',
  ]) {
    fs.writeFileSync(target, source.replace('</svg>', injected + '</svg>'));
    assert.throws(
      () => inspectPublicFiles(directory, ['assets/icon.svg']),
      /SVG/,
    );
  }
});

test('prebuilt plugin installs at a stable private path without changing operation state', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canvas-plugin-install-'),
  );
  const previous = process.env.FIGMA_PLUGIN_STATE_DIR;
  process.env.FIGMA_PLUGIN_STATE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.FIGMA_PLUGIN_STATE_DIR;
    else process.env.FIGMA_PLUGIN_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  seedLedger(path.join(directory, 'operations.sqlite'), [
    { id: 'distribution-original-uncertain', status: 'outcome_unknown' },
  ]);
  const source = require('../scripts/build.cjs').output;
  const manifest = installPlugin(source);
  assert.equal(installPlugin(source), manifest);
  assert.deepEqual(fs.readdirSync(path.dirname(manifest)).sort(), [
    'manifest.json',
    'plugin-runtime.js',
    'ui.html',
  ]);
  assert.equal(
    readLedger(path.join(directory, 'operations.sqlite')).jobs[0].status,
    'outcome_unknown',
  );
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(manifest).mode & 0o777, 0o600);
  process.env.FIGMA_PLUGIN_STATE_DIR = './relative-state';
  assert.throws(() => bridgeStateDirectory(), /absolute path/);
});
