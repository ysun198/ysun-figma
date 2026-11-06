const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const directory = path.resolve(__dirname, '../skills/ysun-figma/references');
const sourceFile = path.join(directory, 'WIDGET-API-SOURCE.json');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function checkLocal() {
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  assert.equal(source.repository, 'https://github.com/figma/widget-typings');
  assert.equal(source.file, 'widget-api.d.ts');
  assert.equal(
    hash(fs.readFileSync(path.join(directory, source.file))),
    source.sha256,
  );
  assert(fs.existsSync(path.join(directory, source.licenseFile)));
  return source;
}
async function refresh(update = false) {
  const source = checkLocal();
  const commit = execFileSync(
    'git',
    ['ls-remote', source.repository + '.git', 'HEAD'],
    { encoding: 'utf8', timeout: 30000 },
  ).split(/\s/)[0];
  assert.match(commit, /^[a-f0-9]{40}$/);
  async function get(file) {
    const r = await fetch(
      'https://raw.githubusercontent.com/figma/widget-typings/' +
        commit +
        '/' +
        file,
      { redirect: 'error', signal: AbortSignal.timeout(20000) },
    );
    if (!r.ok) throw new Error('Widget reference HTTP ' + r.status);
    return r.text();
  }
  const [types, license] = await Promise.all([
    get(source.file),
    get('LICENSE'),
  ]);
  const changed = hash(types) !== source.sha256;
  if (changed && !update)
    throw new Error(
      'Official Widget API changed; review and run npm run api:update',
    );
  if (update && changed) {
    fs.writeFileSync(path.join(directory, source.file), types);
    fs.writeFileSync(path.join(directory, source.licenseFile), license);
    fs.writeFileSync(
      sourceFile,
      JSON.stringify(
        {
          ...source,
          commit,
          sha256: hash(types),
          retrieved: new Date().toISOString().slice(0, 10),
        },
        null,
        2,
      ) + '\n',
    );
  }
  return {
    ...checkLocal(),
    upstreamCommit: commit,
    changed,
    updated: update && changed,
  };
}
if (require.main === module)
  refresh(process.argv.includes('--update'))
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { checkLocal, refresh };
