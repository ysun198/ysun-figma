const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { privateDirectory } = require('./state.cjs');
const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const { validArtifactName: validName } = require('../shared/core.js');
function createArtifacts(directory) {
  function location(group, name) {
    if (!validName(group) || !validName(name))
      throw Object.assign(new Error('invalid artifact name'), {
        statusCode: 400,
      });
    const folder = path.join(directory, group);
    privateDirectory(folder);
    return path.join(folder, name);
  }
  function describe(group, name) {
    const file = location(group, name);
    if (!fs.existsSync(file))
      throw Object.assign(new Error('artifact was not found'), {
        statusCode: 404,
      });
    if (!fs.lstatSync(file).isFile())
      throw new Error('artifact must be a regular file');
    const bytes = fs.readFileSync(file);
    return {
      name,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  async function save(group, name, input) {
    const destination = location(group, name),
      temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of input) {
        size += chunk.length;
        if (size > MAX_BINARY_BYTES)
          throw Object.assign(new Error('binary transfer exceeds 32 MiB'), {
            statusCode: 413,
          });
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      await handle.close();
      const info = { name, size, sha256: hash.digest('hex') };
      // Exclusive link makes retries idempotent, including concurrent uploads.
      try {
        fs.linkSync(temporary, destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const old = describe(group, name);
        if (old.sha256 !== info.sha256 || old.size !== size)
          throw Object.assign(new Error('conflicting artifact bytes'), {
            statusCode: 409,
          });
      }
      return info;
    } finally {
      await handle.close().catch(() => {});
      fs.rmSync(temporary, { force: true });
    }
  }
  function send(group, name, res) {
    const file = location(group, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile())
      throw Object.assign(new Error('artifact was not found'), {
        statusCode: 404,
      });
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
    });
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }
  function remove(group) {
    if (validName(group))
      fs.rmSync(path.join(directory, group), { recursive: true, force: true });
  }
  function cleanupAssets(now, retained) {
    const folder = path.join(directory, 'assets');
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name),
        stat = fs.lstatSync(file);
      if (
        stat.isFile() &&
        !retained.has(name) &&
        now - stat.mtimeMs > 24 * 60 * 60 * 1000
      )
        fs.unlinkSync(file);
    }
  }
  return { save, describe, send, remove, cleanupAssets };
}
module.exports = { createArtifacts, MAX_BINARY_BYTES, validName };
