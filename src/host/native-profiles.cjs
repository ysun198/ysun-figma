const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { bridgeStateDirectory, privateDirectory } = require('./state.cjs');
const profiles = Object.freeze({
  default: { pluginId: '1675211139174009382', directory: 'plugin' },
  dev: { pluginId: '1700203379527851322', directory: 'dev' },
  widget: { pluginId: '1700202761156255033', directory: 'widget' },
});
function profileInfo(name = 'default') {
  if (!Object.hasOwn(profiles, name)) throw new Error('Unknown native profile');
  const profile = profiles[name];
  return {
    name,
    ...profile,
    manifestPath: path.join(
      bridgeStateDirectory(),
      profile.directory,
      'manifest.json',
    ),
  };
}
function widgetCode(base, definition) {
  if (!definition) return base;
  if (Buffer.byteLength(definition) > 262144)
    throw new Error('Widget definition exceeds 256 KiB');
  new Function('widget', definition); // Syntax check only; execute inside Figma.
  const marker = 'const YSUN_WIDGET_RENDER = null; // YSUN_WIDGET_DEFINITION';
  if (base.split(marker).length !== 2)
    throw new Error('Widget runtime definition marker changed');
  return base.replace(
    marker,
    () =>
      'const YSUN_WIDGET_RENDER = (function(widget){\n' +
      definition +
      '\n})(figma.widget);\nif(typeof YSUN_WIDGET_RENDER!=="function")throw Error("Widget module must return its render function");',
  );
}
function savedDefinition() {
  const file = path.join(bridgeStateDirectory(), 'widget/definition.js');
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144)
    throw new Error(
      'Invalid local widget definition; preserved without execution',
    );
  return fs.readFileSync(file, 'utf8');
}
function installExtraProfiles(sourceRoot, selected = ['dev', 'widget']) {
  for (const name of selected) {
    const source = path.join(sourceRoot, 'profiles', name);
    if (!fs.existsSync(path.join(source, 'manifest.json'))) continue;
    const destination = path.join(bridgeStateDirectory(), name);
    privateDirectory(destination);
    for (const file of ['manifest.json', 'code.js', 'ui.html']) {
      const raw = fs.readFileSync(path.join(source, file));
      const bytes =
        name === 'widget' && file === 'code.js'
          ? Buffer.from(widgetCode(raw.toString(), savedDefinition()))
          : raw;
      const target = path.join(destination, file);
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
        const temporary = target + '.' + crypto.randomUUID() + '.tmp';
        try {
          fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
          fs.renameSync(temporary, target);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      }
      if ((fs.statSync(target).mode & 0o777) !== 0o600)
        fs.chmodSync(target, 0o600);
    }
  }
}
function extraProfilesInstalled(sourceRoot) {
  return ['dev', 'widget'].every((name) => {
    const source = path.join(sourceRoot, 'profiles', name);
    if (!fs.existsSync(path.join(source, 'manifest.json'))) return true;
    return ['manifest.json', 'code.js', 'ui.html'].every((file) => {
      const target = path.join(bridgeStateDirectory(), name, file);
      const raw = fs.readFileSync(path.join(source, file));
      const expected =
        name === 'widget' && file === 'code.js'
          ? Buffer.from(widgetCode(raw.toString(), savedDefinition()))
          : raw;
      return fs.existsSync(target) && fs.readFileSync(target).equals(expected);
    });
  });
}
function prepareWidget(sourcePath, sourceRoot) {
  if (!path.isAbsolute(sourcePath))
    throw new Error('Widget sourcePath must be absolute');
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144)
    throw new Error(
      'Widget source must be a regular JavaScript file of at most 256 KiB',
    );
  const definition = fs.readFileSync(sourcePath, 'utf8');
  const base = fs.readFileSync(
    path.join(sourceRoot, 'profiles/widget/code.js'),
    'utf8',
  );
  widgetCode(base, definition);
  const destination = path.join(bridgeStateDirectory(), 'widget');
  privateDirectory(destination);
  const temporary = path.join(
    destination,
    'definition.' + crypto.randomUUID() + '.tmp',
  );
  try {
    fs.writeFileSync(temporary, definition, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(destination, 'definition.js'));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  installExtraProfiles(sourceRoot, ['widget']);
  return {
    ...profileInfo('widget'),
    definitionSha256: crypto
      .createHash('sha256')
      .update(definition)
      .digest('hex'),
    next: 'Prepared trusted local widget code. Connect with profile=widget and a stable operationId, then verify actual widget state/render. No cloud source was executed by this preparation.',
  };
}
module.exports = {
  profiles,
  profileInfo,
  widgetCode,
  installExtraProfiles,
  extraProfilesInstalled,
  prepareWidget,
};
