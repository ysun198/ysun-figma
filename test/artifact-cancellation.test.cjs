const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  uploadAssets,
  saveExports,
} = require('../src/host/artifact-client.cjs');

async function slowResponse(t, bytes) {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    res.write(bytes.subarray(0, 1));
    started();
    const timer = setTimeout(() => res.end(bytes.subarray(1)), 80);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    ready,
    connection: {
      url: 'http://127.0.0.1:' + server.address().port,
      token: 'fixture',
      protocolVersion: 3,
    },
  };
}
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('cancelling an export download stops delivery before writing the destination', async (t) => {
  const root = directory(t),
    bytes = Buffer.from('original export');
  const { ready, connection } = await slowResponse(t, bytes);
  const controller = new AbortController();
  const result = saveExports(
    connection,
    {
      id: 'cancel-download',
      result: {
        exports: [
          {
            name: 'export.bin',
            size: bytes.length,
            mimeType: 'application/octet-stream',
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
    },
    root,
    controller.signal,
  );
  const rejected = assert.rejects(result, (error) =>
    /abort/i.test(error.message),
  );
  await ready;
  controller.abort();
  await rejected;
  assert.equal(fs.existsSync(path.join(root, 'export.bin')), false);
});

test('cancelling an asset upload stops waiting on the HTTP response', async (t) => {
  const root = directory(t),
    file = path.join(root, 'asset.bin');
  fs.writeFileSync(file, 'input');
  const { ready, connection } = await slowResponse(
    t,
    Buffer.from('{"assetId":"fixture"}'),
  );
  const controller = new AbortController();
  const result = uploadAssets(
    connection,
    { 'asset.bin': file },
    controller.signal,
  );
  const rejected = assert.rejects(result, (error) =>
    /abort/i.test(error.message),
  );
  await ready;
  controller.abort();
  await rejected;
});
test('corrupt export bytes are rejected before a destination is written', async (t) => {
  const root = directory(t),
    bytes = Buffer.from('corrupt export');
  const { connection } = await slowResponse(t, bytes);
  await assert.rejects(
    saveExports(
      connection,
      {
        id: 'corrupt-export',
        result: {
          exports: [
            {
              name: 'export.bin',
              size: bytes.length,
              sha256: '0'.repeat(64),
              mimeType: 'application/octet-stream',
            },
          ],
        },
      },
      root,
    ),
    /integrity check failed/,
  );
  assert.equal(fs.existsSync(path.join(root, 'export.bin')), false);
});
