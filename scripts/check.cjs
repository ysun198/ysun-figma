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
assert.deepEqual(manifest.editorType, ['figma', 'figjam', 'slides', 'buzz']);
assert.deepEqual(manifest.permissions, [
  'teamlibrary',
  'currentuser',
  'activeusers',
  'fileusers',
  'payments',
]);
assert.deepEqual(manifest.networkAccess.allowedDomains, [
  'http://localhost:38491',
]);
assert.ok(
  manifest.networkAccess.reasoning,
  'published localhost access requires an explanation',
);
assert.ok(manifest.menu.some((item) => item.command === 'connect'));
const mcp = require('../mcp.json').mcpServers['figma-local'];
assert.equal(
  require('../mcp.json').mcpServers.figma.url,
  'https://mcp.figma.com/mcp',
);
assert.equal(
  require('../apps.json').apps.figma.id,
  'connector_68df038e0ba48191908c8434991bbac2',
);
assert.equal(
  require('../plugin.json').extensions['com.openai'].apps,
  './apps.json',
);
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
require('./sync-api.cjs').checkLocal();
require('./sync-rest.cjs').checkLocal();
require('./sync-widget-api.cjs').checkLocal();
for (const name of ['dev', 'widget']) {
  const profile = JSON.parse(
    fs.readFileSync(path.join(built, 'profiles', name, 'manifest.json')),
  );
  assert.match(profile.id, /^\d+$/);
  assert(
    !(
      profile.editorType.includes('dev') &&
      profile.editorType.includes('figjam')
    ),
  );
  new vm.Script(
    fs.readFileSync(path.join(built, 'profiles', name, 'code.js'), 'utf8'),
  );
  if (name === 'widget') assert.equal(profile.containsWidget, true);
  else assert(profile.capabilities.includes('codegen'));
}

const code = fs.readFileSync(path.join(built, 'plugin-runtime.js'), 'utf8');
new vm.Script(code, { filename: 'plugin-runtime.js' });
const mcpTools = require('../src/host/mcp.cjs').tools;
assert.ok(mcpTools.some((tool) => tool.name === 'figma_file'));
assert.ok(
  mcpTools.every((tool) => !tool._meta?.ui && !tool._meta?.['openai/ui']),
  'the plugin must not register a Codex MCP App surface',
);
assert.ok(
  !mcpTools.some((tool) =>
    ['figma_open', 'figma_watch', 'figma_canvas'].includes(tool.name),
  ),
  'the optional Codex workbench tools must be removed',
);
assert.ok(!fs.existsSync(path.join(built, 'app.html')));

const ui = fs.readFileSync(path.join(built, 'ui.html'), 'utf8');
for (const testId of ['close']) {
  assert.match(ui, new RegExp(`data-testid=["']${testId}["']`));
}
for (const match of ui.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new vm.Script(match[1], { filename: 'ui.html#script' });
}
for (const relativePath of ['src', 'scripts'].flatMap((directory) =>
  fs
    .readdirSync(path.join(root, directory), { recursive: true })
    .filter((name) => name.endsWith('.cjs'))
    .map((name) => directory + '/' + name),
)) {
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
