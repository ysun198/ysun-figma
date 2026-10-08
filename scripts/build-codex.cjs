// Build-time only. Never copy the checkout or private state into a marketplace.
const fs = require('node:fs');
const path = require('node:path');
const { auditRelease, inspectPublicFiles } = require('./audit-release.cjs');
const marketplace = {
  name: 'figma-local',
  interface: { displayName: 'ysun figma' },
  plugins: [
    {
      name: 'figma-plugin-local',
      source: { source: 'local', path: './plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  ],
};
function filesUnder(directory, prefix = '') {
  return fs.readdirSync(path.join(directory, prefix)).flatMap((name) => {
    const relative = prefix ? prefix + '/' + name : name;
    const stat = fs.lstatSync(path.join(directory, relative));
    if (stat.isSymbolicLink()) throw new Error('Symlink in Codex bundle.');
    if (stat.isDirectory()) return filesUnder(directory, relative);
    if (!stat.isFile()) throw new Error('Unsupported Codex bundle file.');
    return [relative];
  });
}
function auditCodexBundle(directory) {
  const plugin = path.join(directory, 'plugin');
  const publicFiles = require('../src/host/installation.cjs').publicEntries(
    plugin,
  );
  inspectPublicFiles(plugin, publicFiles);
  const catalog = '.agents/plugins/marketplace.json';
  if (
    JSON.stringify(
      JSON.parse(fs.readFileSync(path.join(directory, catalog))),
    ) !== JSON.stringify(marketplace)
  )
    throw new Error('Unexpected marketplace contents.');
  const expected = [catalog, ...publicFiles.map((file) => 'plugin/' + file)];
  const actual = filesUnder(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected.sort()))
    throw new Error('Non-public file in Codex bundle.');
  return { files: actual, count: actual.length };
}
async function buildCodexBundle(
  destination,
  source = path.join(__dirname, '../build/plugin'),
) {
  if (fs.existsSync(destination))
    throw new Error('Codex bundle destination already exists.');
  const audit = auditRelease(source),
    plugin = path.join(destination, 'plugin');
  for (const file of audit.files) {
    const target = path.join(plugin, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, file), target);
  }
  const catalog = path.join(destination, '.agents/plugins/marketplace.json');
  fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.writeFileSync(catalog, JSON.stringify(marketplace, null, 2) + '\n');
  return auditCodexBundle(destination);
}
module.exports = { buildCodexBundle, auditCodexBundle };
