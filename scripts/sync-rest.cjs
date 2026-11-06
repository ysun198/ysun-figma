const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const directory = path.resolve(__dirname, '../skills/ysun-figma/references');
const sourcePath = path.join(directory, 'REST-API-SOURCE.json');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function checkLocal() {
  const source = JSON.parse(fs.readFileSync(sourcePath));
  assert.equal(source.repository, 'https://github.com/figma/rest-api-spec');
  assert.equal(source.packagedFile, 'rest-api.json');
  assert.equal(
    hash(fs.readFileSync(path.join(directory, source.packagedFile))),
    source.packagedSha256,
    'REST reference hash mismatch',
  );
  assert(fs.existsSync(path.join(directory, source.licenseFile)));
  const spec = JSON.parse(
    fs.readFileSync(path.join(directory, source.packagedFile)),
  );
  const ops = Object.values(spec.paths).flatMap((item) =>
    Object.entries(item)
      .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map(([, o]) => o.operationId),
  );
  assert.equal(new Set(ops).size, ops.length, 'Duplicate REST operation IDs');
  assert.deepEqual(
    new Set(
      require('../src/host/rest.cjs')
        .operations.filter((o) => !o.source)
        .map((o) => o.operationId),
    ),
    new Set(ops),
    'REST executor must expose every official operation',
  );
  return {
    version: spec.info.version,
    paths: Object.keys(spec.paths).length,
    operations: ops.length,
    source,
  };
}
async function refresh(update = false) {
  const current = JSON.parse(fs.readFileSync(sourcePath));
  const commit = execFileSync(
    'git',
    ['ls-remote', current.repository + '.git', 'HEAD'],
    { encoding: 'utf8', timeout: 30000 },
  ).split(/\s/)[0];
  assert.match(commit, /^[a-f0-9]{40}$/);
  const get = async (name) => {
    const url =
      'https://raw.githubusercontent.com/figma/rest-api-spec/' +
      commit +
      '/' +
      name;
    const r = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok)
      throw new Error('Official REST reference HTTP ' + r.status + ': ' + url);
    return r.text();
  };
  const [yaml, license] = await Promise.all([
    get(current.file),
    get('LICENSE'),
  ]);
  const spec = require('yaml').parse(yaml);
  assert.equal(spec.openapi, '3.1.0');
  assert.match(license, /MIT License/);
  const changed = hash(yaml) !== current.sha256;
  if (update && changed) {
    const json = await require('prettier').format(JSON.stringify(spec), {
      parser: 'json',
      ...(await require('prettier').resolveConfig(sourcePath)),
    });
    fs.writeFileSync(path.join(directory, current.packagedFile), json);
    fs.writeFileSync(path.join(directory, current.licenseFile), license);
    fs.writeFileSync(
      sourcePath,
      JSON.stringify(
        {
          ...current,
          commit,
          sha256: hash(yaml),
          packagedSha256: hash(json),
          retrieved: new Date().toISOString().slice(0, 10),
        },
        null,
        2,
      ) + '\n',
    );
  } else if (!changed) {
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, current.packagedFile))),
      spec,
      'Packaged REST reference lost or changed official schema data',
    );
  }
  if (changed && !update)
    throw new Error('Official REST API changed; run npm run api:update');
  return {
    ...checkLocal(),
    upstreamCommit: commit,
    changed,
    updated: changed && update,
  };
}
if (require.main === module)
  refresh(process.argv.includes('--update'))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { checkLocal, refresh };
