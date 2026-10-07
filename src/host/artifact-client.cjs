const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { bridgeRequest, validateConnection } = require('./bridge-client.cjs');
const { MAX_BINARY_BYTES, validName } = require('./artifacts.cjs');
async function uploadAssets(connection, sources = {}) {
  const assets = {};
  let total = 0;
  const entries = Object.entries(sources);
  for (const [name, source] of entries) {
    if (!validName(name))
      throw new Error(
        'Invalid asset name ' +
          JSON.stringify(name) +
          ': use 1–120 letters, numbers, spaces, dots, underscores or hyphens; start with a letter or number.',
      );
    if (typeof source !== 'string')
      throw new Error(
        'Asset ' + JSON.stringify(name) + ' requires a local file path.',
      );
    total += fs.statSync(source).size;
    if (total > MAX_BINARY_BYTES) throw new Error('asset exceeds 32 MiB');
  }
  for (const [name, source] of entries) {
    const bytes = fs.readFileSync(source),
      id = crypto.createHash('sha256').update(bytes).digest('hex');
    assets[name] = await bridgeRequest(connection, `/v1/assets/${id}`, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
      timeoutMs: 120000,
    });
  }
  return assets;
}
async function saveExports(connection, job, directory) {
  if (!directory) return [];
  const files = (job.result && job.result.exports) || [],
    root = path.resolve(directory),
    seen = new Set();
  for (const file of files) {
    if (!validName(file.name) || seen.has(file.name))
      throw new Error('invalid export name');
    seen.add(file.name);
    if (fs.existsSync(path.join(root, file.name)))
      throw new Error(
        'export already exists; choose an empty output directory',
      );
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const saved = [];
  try {
    for (const file of files) {
      const bytes = await readExport(connection, job.id, file);
      const destination = path.join(root, file.name);
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
      saved.push({
        path: destination,
        size: bytes.length,
        mimeType: file.mimeType,
      });
    }
  } catch (error) {
    error.exportedFiles = saved;
    throw error;
  }
  return saved;
}
async function readExport(connection, operationId, file, signal) {
  validateConnection(connection);
  if (
    !validName(file.name) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_BINARY_BYTES
  )
    throw new Error('invalid export metadata');
  const response = await fetch(
    `${connection.url}/v1/jobs/${encodeURIComponent(operationId)}/exports/${encodeURIComponent(file.name)}`,
    {
      headers: { Authorization: `Bearer ${connection.token}` },
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
    },
  );
  if (!response.ok)
    throw new Error(`export download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== file.size ||
    crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new Error('export integrity check failed');
  return bytes;
}
module.exports = {
  uploadAssets,
  saveExports,
  readExport,
};
