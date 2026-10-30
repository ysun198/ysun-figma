const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { privateDirectory } = require('./state.cjs');
const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const { validArtifactName: validName } = require('../shared/core.js');
// Inspect exported PNGs once at upload. Diagnostics never reject valid delivery.
function pngInfo(bytes) {
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  )
    return undefined;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20),
    image = { width, height, fullyTransparent: null };
  try {
    const depth = bytes[24],
      type = bytes[25],
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type],
      data = [];
    let transparency;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset),
        kind = bytes.toString('ascii', offset + 4, offset + 8),
        end = offset + 8 + length;
      if (end + 4 > bytes.length) throw new Error('Truncated PNG chunk');
      if (kind === 'IDAT') data.push(bytes.subarray(offset + 8, end));
      if (kind === 'tRNS') transparency = bytes.subarray(offset + 8, end);
      offset = end + 4;
    }
    if (!channels || !width || !height) throw new Error('Invalid PNG header');
    if (![4, 6].includes(type) && !transparency) {
      image.fullyTransparent = false;
      return image;
    }
    if (depth !== 8 || bytes[28] !== 0)
      throw new Error('Alpha inspection supports non-interlaced 8-bit PNGs');
    const stride = width * channels,
      limit = (stride + 1) * height;
    if (!Number.isSafeInteger(limit) || limit > 64 * 1024 * 1024)
      throw new Error('Alpha inspection exceeds 64 MiB');
    const raw = inflateSync(Buffer.concat(data), { maxOutputLength: limit });
    if (raw.length !== limit) throw new Error('Invalid PNG scanline length');
    let previous = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const offset = y * (stride + 1),
        filter = raw[offset],
        row = Buffer.from(raw.subarray(offset + 1, offset + 1 + stride));
      if (filter > 4) throw new Error('Invalid PNG filter');
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? row[x - channels] : 0,
          up = previous[x],
          corner = x >= channels ? previous[x - channels] : 0,
          p = left + up - corner,
          a = Math.abs(p - left),
          b = Math.abs(p - up),
          c = Math.abs(p - corner);
        row[x] +=
          filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? a <= b && a <= c
                    ? left
                    : b <= c
                      ? up
                      : corner
                  : 0;
      }
      for (let x = 0; x < stride; x += channels) {
        const alpha =
          type === 4 || type === 6
            ? row[x + channels - 1]
            : type === 3
              ? (transparency[row[x]] ?? 255)
              : Array.from({ length: channels }, (_, i) => row[x + i]).every(
                    (sample, i) => sample === transparency.readUInt16BE(i * 2),
                  )
                ? 0
                : 255;
        if (alpha !== 0) {
          image.fullyTransparent = false;
          return image;
        }
      }
      previous = row;
    }
    image.fullyTransparent = true;
    image.warning =
      'PNG contains no visible pixels; check node and ancestor visibility, opacity, masks and clipping.';
  } catch (error) {
    image.inspectionError = error.message;
  }
  return image;
}
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
    const hash = crypto.createHash('sha256'),
      pngChunks = group !== 'assets' && /\.png$/i.test(name) ? [] : null;
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
        pngChunks?.push(chunk);
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
      if (group === 'assets') {
        // Re-uploading starts a fresh lifetime before the next job claims it.
        const uploadedAt = new Date();
        fs.utimesSync(destination, uploadedAt, uploadedAt);
      } else if (pngChunks) {
        const image = pngInfo(Buffer.concat(pngChunks, size));
        if (image) info.image = image;
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
    let next = Infinity;
    if (!fs.existsSync(folder)) return next;
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || retained.has(name)) continue;
      const expires = stat.mtimeMs + 24 * 60 * 60 * 1000;
      if (now > expires) fs.unlinkSync(file);
      else next = Math.min(next, Math.floor(expires) + 1);
    }
    return next;
  }
  return { save, describe, send, remove, cleanupAssets };
}
module.exports = { createArtifacts, MAX_BINARY_BYTES, validName };
