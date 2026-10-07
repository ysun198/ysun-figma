// Build-time SDK dependencies are bundled; distributed plugins need no npm install.
const fs = require('node:fs');
const path = require('node:path');
function buildApp(directory) {
  const { buildSync } = require('esbuild');
  const template = fs.readFileSync(
    path.join(directory, 'src/app.template.html'),
    'utf8',
  );
  if (template.split('<!-- APP_SCRIPT -->').length !== 2)
    throw new Error('App must contain one build insertion point');
  if (template.split('/* CODEX_STYLES */').length !== 2)
    throw new Error('App must contain one shared style insertion point');
  const result = buildSync({
    entryPoints: [path.join(directory, 'src/app-ui.js')],
    bundle: true,
    write: false,
    metafile: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'inline',
    define: {
      APP_VERSION: JSON.stringify(
        JSON.parse(fs.readFileSync(path.join(directory, 'package.json')))
          .version,
      ),
    },
  });
  const script = result.outputFiles[0].text.replace(
    /<\/script/gi,
    '<\\/script',
  );
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const parts = input.split('node_modules/');
    if (parts.length === 1) continue;
    const names = parts.at(-1).split('/');
    packages.add(
      names[0].startsWith('@') ? names.slice(0, 2).join('/') : names[0],
    );
  }
  const notices = [
    fs.readFileSync(path.join(directory, 'NOTICE.md'), 'utf8').trim(),
    '## Bundled MCP Apps dependencies',
    'The following build-time dependencies are included in app.html. No network or npm installation is required at runtime.',
  ];
  for (const name of [...packages].sort()) {
    const root = path.join(directory, 'node_modules', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const license = fs
      .readdirSync(root)
      .find((file) => /^license(?:\.(?:md|txt))?$/i.test(file));
    if (!license) throw new Error('Missing dependency license: ' + name);
    notices.push(
      `## ${name} ${pkg.version}`,
      fs.readFileSync(path.join(root, license), 'utf8').trim(),
    );
  }
  return {
    'app.html': template
      .replace('/* CODEX_STYLES */', () =>
        fs.readFileSync(path.join(directory, 'src/codex.css'), 'utf8'),
      )
      .replace(
        '<!-- APP_SCRIPT -->',
        () => '<script>\n' + script + '\n</script>',
      ),
    'THIRD_PARTY_NOTICES.md': notices.join('\n\n') + '\n',
  };
}
module.exports = { buildApp };
