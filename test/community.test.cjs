const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');
const { createCommunityReader } = require('../src/host/community-reader.js');
const {
  validateResearch,
  communityReader,
  readPreview,
  researchCommunity,
} = require('../src/host/community.cjs');
const fileId = '1475930096803673913';
const imageUrl = 'https://s3-alpha.figma.com/hub/file/cover.png';
const userAgent = 'Mozilla/5.0 Figma/Test';
function model(id = fileId) {
  return {
    id: 'a6f23f52-5306-4e4a-80cc-e6973fad3acf',
    content_id: id,
    name: 'Workshop poster',
    description: '<p>Agenda</p><script>steal()</script><p>Time &amp; place</p>',
    resource_type: 'design_template',
    publish_scope: 'community',
    publishing_status: 'approved_public',
    community_rdp_url: 'https://www.figma.com/community/file/' + id,
    thumbnail_src_set: { 1200: imageUrl },
    carousel_media: {
      images: {
        0: { url: 'https://s3-alpha.figma.com/hub/file/carousel.png' },
        1: { url: 'https://evil.example/secret' },
      },
    },
    publisher: {
      name: 'Creator',
      profile_handle: 'creator',
      realtime_subscription_token: 'do-not-return',
    },
    support_contact: 'private-fixture',
    content: { hub_file: { id } },
    like_count: 12,
    user_count: 30,
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function browser({ handler, loggedIn = true } = {}) {
  const requests = [];
  const window = loggedIn
    ? { INITIAL_OPTIONS: { user_data: { id: '123456' } } }
    : {};
  const location = {
    origin: 'https://www.figma.com',
    href: 'https://www.figma.com/files/feed?fuid=123456',
  };
  const reader = vm.runInNewContext(
    '(' + createCommunityReader.toString() + ')()',
    {
      window,
      location,
      navigator: { userAgent },
      URL,
      URLSearchParams,
      AbortSignal,
      TextDecoder,
      fetch: async (url, options) => {
        requests.push({ url: new URL(url), options });
        return (
          handler?.(new URL(url), options) ||
          Response.json({ meta: { resource: model() } })
        );
      },
    },
  );
  return { reader, window, location, requests };
}
test('Community arguments distinguish exact public IDs from cloud files and reject conflicting operations', () => {
  assert.equal(
    validateResearch({
      action: 'detail',
      communityUrl:
        'https://www.figma.com/community/file/' + fileId + '/poster',
    }).communityFileId,
    fileId,
  );
  assert.equal(
    validateResearch({ action: 'search', query: '  course poster  ' }).query,
    'course poster',
  );
  for (const input of [
    { action: 'search', query: ' ' },
    { action: 'search', query: 'x', page: 0 },
    { action: 'search', query: 'x', pageSize: 51 },
    { action: 'search', query: 'x', sortBy: 'unknown' },
    { action: 'search', query: 'x', communityFileId: fileId },
    { action: 'detail', communityFileId: 'CloudFileKey' },
    { action: 'detail', communityFileId: fileId, page: 1 },
    { action: 'preview', communityFileId: fileId, previewIndex: 10 },
    ...[
      'https://evil.example/community/file/',
      'https://www.figma.com@evil.example/community/file/',
      'http://www.figma.com/community/file/',
      'https://www.figma.com/design/',
    ].map((prefix) => ({ action: 'detail', communityUrl: prefix + fileId })),
  ])
    assert.throws(() => validateResearch(input));
});
test('reader returns bounded public fields and real page offsets without executing creator HTML', async () => {
  const b = browser({
    handler: (url) => {
      assert.equal(url.searchParams.get('fuid'), '123456');
      assert.equal(
        url.searchParams.get('resource_type'),
        'design_template,ui_kit',
      );
      assert.equal(url.searchParams.get('publish_scope'), 'community');
      const from = Number(url.searchParams.get('from'));
      return Response.json({
        meta: {
          results: [{ model: model(String(BigInt(fileId) + BigInt(from))) }],
          total_hits: 3,
        },
        pagination: {
          total_resource_count: 3,
          next_page:
            from < 2 ? '/api/search/resources?from=' + (from + 1) : null,
        },
      });
    },
  });
  await b.reader.identity();
  const first = plain(await b.reader.search({ query: 'poster', pageSize: 1 }));
  const second = plain(
    await b.reader.search({ query: 'poster', pageSize: 1, page: 2 }),
  );
  assert.equal(first.nextPage, 2);
  assert.equal(second.nextPage, 3);
  assert.notEqual(
    first.resources[0].communityFileId,
    second.resources[0].communityFileId,
  );
  assert.equal(second.coverage, 'one_search_page');
  assert.equal(first.resources[0].description, model().description);
  assert.equal(first.resources[0].descriptionFormat, 'html');
  assert.doesNotMatch(
    JSON.stringify(first),
    /do-not-return|private-fixture|accountId|userAgent/,
  );
  assert.equal(first.resources[0].license, null);
  assert.equal(first.resources[0].previews.length, 2);
  for (const r of b.requests) {
    assert.equal(r.options.method, 'GET');
    assert.equal(r.options.credentials, 'same-origin');
    assert.equal(r.options.redirect, 'error');
  }
});
test('streaming Home establishes identity from bootstrap data without navigation or script evaluation', async () => {
  const b = browser({
    loggedIn: false,
    handler: (url) => {
      assert.equal(url.pathname, '/community');
      return new Response(
        '<script data-initial type="application/json">' +
          JSON.stringify({
            INITIAL_OPTIONS: {
              user_data: { id: '123456' },
              token: 'never-export',
            },
          }) +
          '</script><script>throw Error("must not execute")</script>',
      );
    },
  });
  assert.equal((await b.reader.identity()).accountId, '123456');
  assert.equal(b.location.href, 'https://www.figma.com/files/feed?fuid=123456');
});
test('reader fails on changed accounts, identities and unpublished resources', async () => {
  const b = browser();
  await b.reader.identity();
  b.window.INITIAL_OPTIONS.user_data.id = '654321';
  await assert.rejects(b.reader.detail(fileId), /community_account_changed/);
  for (const patch of [
    { publish_scope: 'organization' },
    { publishing_status: 'draft' },
    { unpublished_at: 'today' },
    { resource_type: 'plugin' },
    { content_id: '999999' },
    { community_rdp_url: 'https://evil.example/community/file/' + fileId },
    { content: { hub_file: { id: '999999' } } },
  ]) {
    const x = browser({
      handler: () =>
        Response.json({ meta: { resource: { ...model(), ...patch } } }),
    });
    await x.reader.identity();
    await assert.rejects(x.reader.detail(fileId), /community_resource_/);
  }
});
test('missing or inconsistent pagination cannot masquerade as a complete search', async () => {
  for (const pagination of [
    undefined,
    { total_resource_count: 3 },
    {
      total_resource_count: 3,
      next_page: 'https://evil.example/api/search/resources?from=1',
    },
    { total_resource_count: 3, next_page: '/api/search/resources?from=7' },
  ]) {
    const b = browser({
      handler: () =>
        Response.json({
          meta: { results: [{ model: model() }], total_hits: 3 },
          pagination,
        }),
    });
    await b.reader.identity();
    await assert.rejects(
      b.reader.search({ query: 'poster', pageSize: 1 }),
      /community_pagination_schema_changed/,
    );
  }
});
test('login, access, resource and rate failures remain distinct; chunked bodies are bounded', async () => {
  for (const [status, code] of [
    [401, 'login_required'],
    [403, 'access_denied'],
    [404, 'resource_not_found'],
    [429, 'rate_limited'],
  ]) {
    const b = browser({ handler: () => new Response('', { status }) });
    await b.reader.identity();
    await assert.rejects(
      b.reader.detail(fileId),
      new RegExp('community_' + code),
    );
  }
  const b = browser({
    handler: () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
  });
  await b.reader.identity();
  await assert.rejects(b.reader.detail(fileId), /community_response_too_large/);
  b.reader.close();
  await assert.rejects(b.reader.identity(), /community_reader_closed/);
});
function desktop(accounts) {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() {
      return closed;
    },
    connect: async () => ({
      close() {
        closed = true;
      },
      async call(method, params, sessionId) {
        calls.push({ method, params, sessionId });
        if (method === 'Target.getTargets')
          return {
            targetInfos: accounts.map((_, i) => ({
              targetId: String(i),
              type: 'page',
              url: 'https://www.figma.com/files/feed',
            })),
          };
        if (method === 'Target.attachToTarget')
          return { sessionId: params.targetId };
        if (method === 'Runtime.evaluate')
          return { result: { objectId: sessionId } };
        if (
          method === 'Runtime.callFunctionOn' &&
          params.arguments?.[0].value === 'identity'
        )
          return {
            result: {
              value: { accountId: accounts[Number(sessionId)], userAgent },
            },
          };
        return { result: { value: {} } };
      },
    }),
  };
}
test('Desktop reader rejects ambiguous accounts and releases every attached object and session', async () => {
  const d = desktop(['123456', '654321']);
  await assert.rejects(
    communityReader({ connect: d.connect }),
    /ambiguous_desktop_account/,
  );
  assert.equal(d.closed, true);
  assert.equal(
    d.calls.filter((c) => c.method === 'Runtime.releaseObject').length,
    2,
  );
  assert.equal(
    d.calls.filter((c) => c.method === 'Target.detachFromTarget').length,
    2,
  );
  const good = desktop(['123456', '123456']);
  const reader = await communityReader({ connect: good.connect });
  assert.equal(reader.userAgent, userAgent);
  await reader.close();
  assert.equal(good.closed, true);
});
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
test('public previews use Desktop client context, no credentials, no redirects, and validate bytes', async () => {
  const result = await readPreview(imageUrl, {
    userAgent,
    fetcher: async (url, options) => {
      assert.equal(url, imageUrl);
      assert.equal(options.headers['User-Agent'], userAgent);
      assert.equal(options.headers.Referer, 'https://www.figma.com/');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.Cookie, undefined);
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  assert.equal(result.data, png.toString('base64'));
  assert.equal(result.size, png.length);
  for (const [type, bytes, code] of [
    ['image/svg+xml', '<svg/>', 'type_not_allowed'],
    ['image/png', '<html/>', 'invalid_image'],
    ['image/png', Buffer.alloc(2 * 1024 * 1024 + 1), 'too_large'],
  ])
    await assert.rejects(
      readPreview(imageUrl, {
        userAgent,
        fetcher: async () =>
          new Response(bytes, { headers: { 'content-type': type } }),
      }),
      new RegExp('community_preview_' + code),
    );
  await assert.rejects(
    readPreview(imageUrl, {
      userAgent,
      fetcher: async () => new Response('', { status: 403 }),
    }),
    /community_preview_http_403/,
  );
});
test('preview URLs cannot send requests to arbitrary hosts or accept absent client context', async () => {
  const fetcher = () => assert.fail('must reject before network');
  for (const url of [
    'http://s3-alpha.figma.com/x',
    'https://s3-alpha.figma.com.evil.example/x',
    'https://user:pass@s3-alpha.figma.com/x',
    'https://127.0.0.1/x',
  ])
    await assert.rejects(
      readPreview(url, { userAgent, fetcher }),
      /community_preview_url_not_allowed/,
    );
  await assert.rejects(
    readPreview(imageUrl, { fetcher }),
    /community_preview_context_unavailable/,
  );
});
test('research closes Desktop on errors and preserves preview provenance without creating native work', async () => {
  let closed = 0;
  const readerFactory = async () => ({
    userAgent,
    detail: async () => ({
      resource: {
        url: 'https://www.figma.com/community/file/' + fileId,
        previews: [{ index: 0, kind: 'cover', url: imageUrl }],
      },
    }),
    close: async () => {
      closed++;
    },
  });
  const value = await researchCommunity(
    { action: 'preview', communityFileId: fileId },
    {
      readerFactory,
      fetcher: async () =>
        new Response(png, { headers: { 'content-type': 'image/png' } }),
    },
  );
  assert.equal(closed, 1);
  assert.equal(value.source.kind, 'figma-community');
  assert.equal(value.preview.url, imageUrl);
  await assert.rejects(
    researchCommunity(
      { action: 'detail', communityFileId: fileId },
      {
        readerFactory: async () => ({
          detail: async () => {
            throw Error('read failed');
          },
          close: async () => {
            closed++;
          },
        }),
      },
    ),
    /read failed/,
  );
  assert.equal(closed, 2);
  await assert.rejects(
    researchCommunity(
      { action: 'search', query: '' },
      { readerFactory: () => assert.fail('invalid input') },
    ),
  );
});
test('default preview reads the provided file cover when the separate promotional CDN is challenged', async () => {
  const promotional =
    'https://s3-figma-hubfile-images-production-cdn-cgi.figma.com/cdn-cgi/image/format=auto/hub/file/promo';
  const b = browser({
    handler: () => {
      const m = model();
      m.thumbnail_src_set = { 1200: promotional };
      m.content.hub_file.resized_thumbnail_urls = { 1200: imageUrl };
      return Response.json({ meta: { resource: m } });
    },
  });
  await b.reader.identity();
  const readerFactory = async () => ({
    userAgent,
    detail: (id) => b.reader.detail(id),
    close: async () => {},
  });
  const result = await researchCommunity(
    { action: 'preview', communityFileId: fileId },
    {
      readerFactory,
      fetcher: async (url) => {
        assert.equal(
          url,
          imageUrl,
          'use the published file cover rather than repeatedly requesting its challenged promotional CDN',
        );
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      },
    },
  );
  assert.equal(result.preview.kind, 'file-cover');
  assert.equal(result.resource.previews[1].kind, 'community-cover');
  assert.equal(result.resource.previews[2].kind, 'carousel');
  await assert.rejects(
    researchCommunity(
      { action: 'preview', communityFileId: fileId, previewIndex: 1 },
      {
        readerFactory,
        fetcher: async (url) => {
          assert.equal(url, promotional);
          return new Response('', {
            status: 202,
            headers: { 'x-amzn-waf-action': 'challenge' },
          });
        },
      },
    ),
    /community_preview_waf_challenge: HTTP 202/,
  );
});
