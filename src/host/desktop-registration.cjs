const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { profiles, profileInfo } = require('./native-profiles.cjs');
const { bridgeStateDirectory, privateDirectory } = require('./state.cjs');

function readRegistration({ home = os.homedir() } = {}) {
  const file = path.join(
    home,
    'Library/Application Support/Figma/settings.json',
  );
  let before;
  try {
    before = fs.readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const settings = before ? JSON.parse(before.toString()) : {};
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    (settings.localFileExtensions !== undefined &&
      !Array.isArray(settings.localFileExtensions))
  )
    throw new Error('desktop_registration_schema_changed');
  const entries = settings.localFileExtensions || [];
  if (
    entries.some(
      (entry) =>
        !entry ||
        !Number.isSafeInteger(entry.id) ||
        entry.id < 0 ||
        typeof entry.manifestPath !== 'string',
    ) ||
    new Set(entries.map((entry) => entry.id)).size !== entries.length
  )
    throw new Error('desktop_registration_schema_changed');
  const requested = Object.keys(profiles)
    .map((name) => profileInfo(name))
    .filter((p) => fs.existsSync(p.manifestPath));
  const changes = requested.filter(({ pluginId, manifestPath }) => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      manifest.id !== pluginId ||
      !fs.existsSync(path.join(path.dirname(manifestPath), manifest.main))
    )
      throw new Error('desktop_native_manifest_invalid');
    const matches = entries.filter(
      (entry) =>
        entry.manifestPath === manifestPath ||
        entry.lastKnownPluginId === pluginId,
    );
    return (
      matches.length !== 1 ||
      matches[0].manifestPath !== manifestPath ||
      (matches[0].lastKnownPluginId &&
        matches[0].lastKnownPluginId !== pluginId)
    );
  });
  return { home, file, before, settings, changes };
}

async function registerDesktopPlugins(plan, { assertStopped } = {}) {
  if (!plan.changes.length) return null;
  await assertStopped();
  // Check after the process check as Figma writes settings when quitting.
  const latest = readRegistration({ home: plan.home });
  if (!latest.changes.length) return null;
  const { file, before, settings, changes } = latest;
  let entries = [...(settings.localFileExtensions || [])];
  const ids = new Set(entries.map((entry) => entry.id));
  for (const { pluginId, manifestPath } of changes) {
    const replaced = entries.filter(
      (entry) =>
        entry.lastKnownPluginId === pluginId ||
        entry.manifestPath === manifestPath,
    );
    const removedIds = new Set(replaced.map((entry) => entry.id));
    entries = entries.filter(
      (entry) =>
        !removedIds.has(entry.id) &&
        !removedIds.has(entry.fileMetadata?.manifestFileId),
    );
    let id = replaced[0]?.id || 1;
    if (replaced.length) ids.delete(id);
    while (ids.has(id)) id++;
    ids.add(id);
    // Figma's registry rebuilds code/UI metadata from this minimal manifest
    // record on startup. Replace only our obsolete registration and its owned
    // code/UI records; preserve every unrelated plugin and file-ID graph.
    entries.push({ id, manifestPath, lastKnownPluginId: pluginId });
  }
  const backups = path.join(bridgeStateDirectory(), 'backups');
  privateDirectory(backups);
  const backup = path.join(
    backups,
    'figma-settings-' + crypto.randomUUID() + '.json',
  );
  if (before) fs.writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ ...settings, localFileExtensions: entries }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    await assertStopped();
    const current = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    if (before ? !current?.equals(before) : current !== undefined)
      throw new Error('desktop_registration_changed');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    registered: changes.map((p) => p.name),
    ...(before ? { settingsBackupPath: backup } : {}),
  };
}

module.exports = { readRegistration, registerDesktopPlugins };
