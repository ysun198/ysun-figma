const assert = require('node:assert/strict');
const { operations, source } = require('../src/host/rest-supplement.cjs');
const headings = (html) =>
  Array.from(html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g), (match) =>
    match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&#x200b;|&#8203;|\u200b/g, '')
      .trim(),
  );
async function check() {
  const urls = [
    source.scim,
    source.discovery,
    'https://developers.figma.com/docs/embeds/embed-api/',
  ];
  const pages = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      assert(
        response.ok,
        'Official documentation HTTP ' + response.status + ': ' + url,
      );
      return response.text();
    }),
  );
  assert.deepEqual(
    headings(pages[0]).filter((h) => /^(GET|POST|PUT|PATCH|DELETE) /.test(h)),
    [
      'GET Service Provider Config',
      'GET Tenant ID',
      'GET Users',
      'POST Users',
      'PUT Users',
      'PATCH Users',
      'DELETE Users',
      'GET Groups',
      'POST Groups',
      'PUT Groups',
      'PATCH Groups',
      'DELETE Groups',
    ],
    'SCIM operations changed; review the manual supplemental contracts',
  );
  assert(pages[1].includes('/v1/discovery'), 'Discovery path changed');
  for (const parameter of ['start_date', 'end_date', 'file_ttl_in_seconds'])
    assert(
      pages[1].includes(parameter),
      'Discovery parameter changed: ' + parameter,
    );
  const adapter =
    await import('../skills/ysun-figma/references/embed-runtime.mjs');
  const actual = headings(pages[2]).filter((h) => /^[A-Z][A-Z_]+$/.test(h));
  assert.deepEqual(
    new Set(actual),
    new Set([...Object.keys(adapter.commands), ...adapter.events]),
    'Embed commands/events changed; update the adapter',
  );
  assert.equal(operations.length, 13);
  return {
    scim: 12,
    discovery: 1,
    embedCommands: 5,
    embedEvents: 7,
    sources: urls,
  };
}
if (require.main === module)
  check()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { check };
