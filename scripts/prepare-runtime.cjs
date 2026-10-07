// Build-time only: vendor verified, officially signed Node binaries and licenses.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { version, sha256 } = require('../package.json').bundledNode;
const root = path.join(__dirname, '..'),
  cache = path.join(root, 'build/node');
const sha = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function runtime(arch) {
  fs.mkdirSync(cache, { recursive: true });
  const source = `https://nodejs.org/download/release/v${version}/`,
    name = `node-v${version}-darwin-${arch}.tar.gz`,
    checksum = sha256['darwin-' + arch];
  if (!/^[a-f0-9]{64}$/.test(checksum || ''))
    throw new Error('Bundled Node checksum is missing.');
  const archive = path.join(cache, name);
  if (!fs.existsSync(archive) || sha(archive) !== checksum) {
    const partial = archive + '.download';
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await run('/usr/bin/curl', [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--max-time',
          '60',
          '--continue-at',
          '-',
          source + name,
          '-o',
          partial,
        ]);
        break;
      } catch (error) {
        if (error.code !== 28 || attempt === 7) throw error;
      }
    }
    if (sha(partial) !== checksum)
      throw new Error('Node integrity check failed.');
    fs.renameSync(partial, archive);
  }
  const extracted = path.join(cache, `node-v${version}-darwin-${arch}`);
  execFileSync('/usr/bin/tar', [
    '-xzf',
    archive,
    '-C',
    cache,
    path.basename(extracted) + '/bin/node',
    path.basename(extracted) + '/LICENSE',
  ]);
  const binary = path.join(extracted, 'bin/node');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], {
    stdio: 'pipe',
  });
  const license = path.join(extracted, 'LICENSE');
  return {
    binary,
    license,
    provenance: {
      version,
      architecture: arch,
      source: source + name,
      archiveSHA256: checksum,
      binarySHA256: sha(binary),
      licenseSHA256: sha(license),
    },
  };
}
async function prepareRuntime(destination) {
  if (process.platform !== 'darwin')
    throw new Error('Prepare the macOS bundle on macOS.');
  const results = await Promise.all(['arm64', 'x64'].map(runtime));
  for (const [i, arch] of ['arm64', 'x64'].entries()) {
    const target = path.join(destination, 'runtime', 'darwin-' + arch);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(results[i].binary, path.join(target, 'node'));
    fs.chmodSync(path.join(target, 'node'), 0o755);
    fs.copyFileSync(results[i].license, path.join(target, 'LICENSE'));
    fs.writeFileSync(
      path.join(target, 'PROVENANCE.json'),
      JSON.stringify(results[i].provenance, null, 2) + '\n',
    );
  }
}
module.exports = { prepareRuntime };
