const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { build } = require('./build.cjs');
const { buildCodexBundle } = require('./build-codex.cjs');
const root = path.join(__dirname, '..');
function signRelease(artifact, pkg, privateKey) {
  const bytes = fs.readFileSync(artifact);
  const release = {
    product: pkg.name,
    version: pkg.version,
    repository: require('../src/host/updates.cjs').repository(pkg),
    archive: path.basename(artifact),
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  if (
    crypto
      .createPublicKey(privateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString() !== pkg.updates.publicKey
  )
    throw new Error('Release key does not match the packaged verifier');
  const payload = Buffer.from(JSON.stringify(release));
  return {
    payload: payload.toString('base64'),
    signature: crypto.sign(null, payload, privateKey).toString('base64'),
  };
}

async function release() {
  const source = build(true),
    version = require('../package.json').version;
  const output = path.join(root, 'dist', version);
  if (fs.existsSync(output))
    throw new Error('Release output already exists. Use a new version');
  const staging = fs.mkdtempSync(path.join(root, 'build/.release-'));
  try {
    const bundle = path.join(staging, 'bundle');
    const audit = await buildCodexBundle(bundle, source);
    const name = `ysun-figma-${version}.zip`,
      artifact = path.join(staging, name);
    execFileSync('zip', ['-q', '-X', artifact, ...audit.files], {
      cwd: bundle,
      stdio: 'pipe',
    });
    const sum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(artifact))
      .digest('hex');
    fs.writeFileSync(path.join(staging, 'SHA256SUMS'), `${sum}  ${name}\n`);
    const key =
      process.env.RELEASE_SIGNING_KEY ||
      (process.env.FIGMA_RELEASE_KEY_FILE &&
        fs.readFileSync(process.env.FIGMA_RELEASE_KEY_FILE, 'utf8'));
    if (!key)
      throw new Error('A publisher signing key is required for a release');
    fs.writeFileSync(
      path.join(staging, 'update.json'),
      JSON.stringify(signRelease(artifact, require('../package.json'), key)) +
        '\n',
    );
    fs.rmSync(bundle, { recursive: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.renameSync(staging, output);
    console.log(
      `Release ready · ${audit.count} audited files\n${path.join(output, name)}`,
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
if (require.main === module)
  release().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { release, signRelease };
