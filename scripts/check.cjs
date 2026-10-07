const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const built = require('./build.cjs').output;
const pkg = require('../package.json');
const lock = require('../package-lock.json');
for (const key of ['name', 'version', 'license'])
  assert.equal(lock.packages[''][key], pkg[key], `Lockfile ${key} is stale`);
assert.equal(lock.version, pkg.version, 'Lockfile version is stale');
assert.equal(
  JSON.parse(fs.readFileSync(path.join(built, 'plugin.json'))).version,
  require('../package.json').version,
);

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'),
);
assert.equal(manifest.documentAccess, 'dynamic-page');
assert.deepEqual(manifest.editorType, ['figma', 'figjam', 'slides']);
assert.deepEqual(manifest.permissions, ['teamlibrary']);
assert.deepEqual(manifest.networkAccess.allowedDomains, [
  'http://localhost:38491',
]);
assert.ok(
  manifest.networkAccess.reasoning,
  'published localhost access requires an explanation',
);
assert.ok(manifest.menu.some((item) => item.command === 'connect'));
const mcp = require('../mcp.json').mcpServers['figma-local'];
assert.equal(mcp.type, 'stdio');
assert.ok(
  /^[A-Za-z0-9_-]+$/.test(mcp.command) || mcp.command.startsWith('./'),
  'portable stdio commands must use a bare executable or contained relative path',
);
const onboarding =
  require('../plugin.json').extensions['com.openai'].onboardingSkill;
assert.ok(
  onboarding.startsWith('./skills/') &&
    !onboarding.includes('..') &&
    fs.existsSync(path.join(root, onboarding)),
  'packaged onboarding skill must exist',
);
const apiDirectory = path.join(root, 'skills/ysun-figma/references');
const apiSource = JSON.parse(
  fs.readFileSync(path.join(apiDirectory, 'API-SOURCE.json'), 'utf8'),
);
assert.equal(
  require('node:crypto')
    .createHash('sha256')
    .update(fs.readFileSync(path.join(apiDirectory, apiSource.file)))
    .digest('hex'),
  apiSource.sha256,
  'public API types must match their pinned source',
);
assert.ok(
  fs.existsSync(path.join(apiDirectory, apiSource.licenseFile)),
  'the public API license must ship with the reference',
);

const code = fs.readFileSync(path.join(built, 'plugin-runtime.js'), 'utf8');
new vm.Script(code, { filename: 'plugin-runtime.js' });

const ui = fs.readFileSync(path.join(built, 'ui.html'), 'utf8');
for (const testId of ['close']) {
  assert.match(ui, new RegExp(`data-testid=["']${testId}["']`));
}
for (const match of ui.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new vm.Script(match[1], { filename: 'ui.html#script' });
}
for (const match of fs
  .readFileSync(path.join(built, 'app.html'), 'utf8')
  .matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new vm.Script(match[1], { filename: 'app.html#script' });
}

for (const relativePath of fs
  .readdirSync(path.join(root, 'scripts'))
  .filter((name) => name.endsWith('.cjs'))
  .map((name) => 'scripts/' + name)) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  new vm.Script(source, { filename: relativePath });
}

require('./audit-release.cjs').auditRelease();

assert.match(
  manifest.id,
  /^\d+$/,
  'manifest.id must be the numeric ID assigned by Figma',
);
console.log(
  'check passed · built package is ready for Figma Desktop and Codex',
);
