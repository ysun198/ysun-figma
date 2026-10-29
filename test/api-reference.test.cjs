const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readAPIReference } = require('../src/host/api-reference.cjs');

test('offline API topics resolve to packaged, readable native guidance', () => {
  const index = readAPIReference();
  assert.match(index.reference.sha256, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(index.reference.path));
  for (const { id, path: file } of index.topics) {
    const topic = readAPIReference({ topic: id });
    assert.equal(topic.text, fs.readFileSync(file, 'utf8'));
    assert.ok(
      path
        .resolve(file)
        .startsWith(path.resolve(__dirname, '../skills') + path.sep),
    );
  }
  assert.throws(() => readAPIReference({ topic: '__proto__' }), /Unknown/);
  assert.throws(
    () => readAPIReference({ topic: 'layout', query: 'FrameNode' }),
    /Choose/,
  );
});

test('API lookup resolves dotted native paths and preserves the actual declaration', () => {
  for (const [query, symbol, owner] of [
    [
      'figma.viewport.scrollAndZoomIntoView',
      'scrollAndZoomIntoView',
      'ViewportAPI',
    ],
    ['setVectorNetworkAsync', 'setVectorNetworkAsync', 'VectorLikeMixin'],
    ['createVideoAsync', 'createVideoAsync', 'PluginAPI'],
  ]) {
    const found = readAPIReference({ query, limit: 1 });
    assert.equal(found.symbol, symbol);
    assert.equal(found.excerpts[0].owner, owner);
    assert.ok(found.excerpts[0].text.includes(symbol));
    assert.ok(found.excerpts[0].startLine <= found.excerpts[0].line);
    assert.ok(found.excerpts[0].line <= found.excerpts[0].endLine);
    assert.match(found.runtimeAvailability, /Not probed/);
  }
});

test('broad API searches are bounded and literal misses do not invent support', () => {
  const broad = readAPIReference({ query: 'layout', limit: 8 });
  assert.ok(broad.totalMatchingLines > broad.excerpts.length);
  assert.ok(broad.excerpts.length <= 8);
  assert.ok(
    broad.excerpts.reduce((n, entry) => n + entry.text.length, 0) <= 12000,
  );
  assert.equal(broad.truncated, true);
  const missing = readAPIReference({ query: '.*ThisSymbolDoesNotExist' });
  assert.equal(missing.totalMatchingLines, 0);
  assert.deepEqual(missing.excerpts, []);
});
