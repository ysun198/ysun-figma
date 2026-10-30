const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { crc32, deflateSync } = require('node:zlib');
const { createArtifacts } = require('../src/host/artifacts.cjs');
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

test('PNG export diagnostics detect empty and visible pixels across native scanline filters without changing bytes', async (t) => {
  const root = directory(t),
    artifacts = createArtifacts(root);
  function png(rows, { type = 6, depth = 8, transparency } = {}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(2, 4);
    header[8] = depth;
    header[9] = type;
    const chunk = (kind, data) => {
      const body = Buffer.concat([Buffer.from(kind), data]),
        result = Buffer.alloc(data.length + 12);
      result.writeUInt32BE(data.length);
      body.copy(result, 4);
      result.writeUInt32BE(crc32(body), result.length - 4);
      return result;
    };
    return Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      ...(transparency ? [chunk('tRNS', transparency)] : []),
      chunk('IDAT', deflateSync(Buffer.from(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
  const first = [0, 17, 34, 51, 0, 17, 34, 51, 0];
  for (const [filter, row] of [
    [0, [17, 34, 51, 0, 17, 34, 51, 0]],
    [1, [17, 34, 51, 0, 0, 0, 0, 0]],
    [2, [0, 0, 0, 0, 0, 0, 0, 0]],
    [3, [9, 17, 26, 0, 0, 0, 0, 0]],
    [4, [0, 0, 0, 0, 0, 0, 0, 0]],
  ]) {
    const bytes = png([...first, filter, ...row]),
      name = 'filter-' + filter + '.png',
      saved = await artifacts.save('export-job', name, [bytes]);
    assert.equal(saved.image.width, 2);
    assert.equal(saved.image.height, 2);
    assert.equal(saved.image.fullyTransparent, true);
    assert.match(saved.image.warning, /no visible pixels/);
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'export-job', name)),
      bytes,
    );
  }
  for (const [name, bytes, expected] of [
    ['visible', png([...first, 0, 17, 34, 51, 1, 17, 34, 51, 0]), false],
    ['gray-alpha', png([0, 77, 0, 77, 0, 0, 77, 0, 77, 0], { type: 4 }), true],
    [
      'palette',
      png([0, 0, 0, 0, 0, 0], { type: 3, transparency: Buffer.from([0]) }),
      true,
    ],
    [
      'gray-key',
      png([0, 77, 77, 0, 77, 77], {
        type: 0,
        transparency: Buffer.from([0, 77]),
      }),
      true,
    ],
    [
      'rgb',
      png([0, 1, 2, 3, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3], { type: 2 }),
      false,
    ],
    ['unsupported', png([], { depth: 16 }), null],
    ['malformed', png([9]), null],
  ]) {
    const { image } = await artifacts.save('export-job', name + '.png', [
      bytes,
    ]);
    assert.equal(image.fullyTransparent, expected, name);
    if (expected === null) assert(image.inspectionError);
    else assert.equal(image.inspectionError, undefined);
  }
});

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
