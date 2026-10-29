const { connectDesktop, createPageReader } = require('./desktop.cjs');
const { createCommunityReader } = require('./community-reader.js');
const HOSTS = new Set(['www.figma.com', 'figma.com']);
function validateResearch(input) {
  if (!input || !['search', 'detail', 'preview'].includes(input.action))
    throw new Error('Choose community search, detail or preview');
  if (input.action === 'search') {
    if (
      typeof input.query !== 'string' ||
      !input.query.trim() ||
      input.query.length > 200 ||
      input.communityUrl ||
      input.communityFileId ||
      input.previewIndex !== undefined
    )
      throw new Error(
        'Community search requires only a query and paging/sort options',
      );
    for (const [key, value, maximum] of [
      ['page', input.page ?? 1, 100],
      ['pageSize', input.pageSize ?? 12, 50],
    ])
      if (!Number.isInteger(value) || value < 1 || value > maximum)
        throw new Error('Invalid community ' + key);
    if (
      input.sortBy &&
      !['relevancy', 'popular', 'all_time', 'published_at'].includes(
        input.sortBy,
      )
    )
      throw new Error('Invalid community sortBy');
    return { ...input, query: input.query.trim() };
  }
  if (
    input.query !== undefined ||
    input.page !== undefined ||
    input.pageSize !== undefined ||
    input.sortBy !== undefined ||
    !!input.communityUrl === !!input.communityFileId ||
    (input.action === 'detail' && input.previewIndex !== undefined)
  )
    throw new Error('Choose one exact Community file URL or Community file ID');
  let id = input.communityFileId;
  if (input.communityUrl) {
    const u = new URL(input.communityUrl);
    if (
      u.protocol !== 'https:' ||
      !HOSTS.has(u.hostname) ||
      u.port ||
      u.username ||
      u.password ||
      !/^\/community\/file\/\d{6,30}(?:\/[^/]*)?\/?$/.test(u.pathname)
    )
      throw new Error(
        'Use an exact https://www.figma.com/community/file/ID URL',
      );
    id = u.pathname.split('/')[3];
  }
  if (typeof id !== 'string' || !/^\d{6,30}$/.test(id))
    throw new Error('Invalid Community file ID; this is not a cloud fileKey');
  if (
    input.previewIndex !== undefined &&
    (!Number.isInteger(input.previewIndex) ||
      input.previewIndex < 0 ||
      input.previewIndex > 9)
  )
    throw new Error('Invalid Community preview index');
  return { ...input, communityFileId: id };
}
async function communityReader({ connect = connectDesktop } = {}) {
  const connection = await connect();
  const readers = [];
  async function closeReader(r) {
    await r.reader?.close();
    await connection
      .call('Target.detachFromTarget', { sessionId: r.sessionId })
      .catch(() => {});
  }
  const close = async () => {
    for (const r of readers) await closeReader(r);
    connection.close();
  };
  try {
    const { targetInfos } = await connection.call('Target.getTargets');
    const targets = targetInfos.filter((t) => {
      try {
        const u = new URL(t.url);
        return (
          t.type === 'page' &&
          u.protocol === 'https:' &&
          HOSTS.has(u.hostname) &&
          /^\/(files|community)(\/|$)/.test(u.pathname)
        );
      } catch {
        return false;
      }
    });
    if (!targets.length) throw new Error('community_home_unavailable');
    const available = [];
    for (const target of targets) {
      const r = await connection.call('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      const session = { sessionId: r.sessionId };
      readers.push(session);
      session.reader = await createPageReader(
        connection,
        session.sessionId,
        createCommunityReader,
        'community_reader_unavailable',
      );
      try {
        const identity = await session.reader.invoke('identity');
        available.push({ ...session, ...identity });
      } catch (error) {
        if (error.message !== 'community_login_required') throw error;
      }
    }
    if (!available.length) throw new Error('community_login_required');
    if (new Set(available.map((r) => r.accountId)).size !== 1)
      throw new Error('ambiguous_desktop_account');
    const selected = available[0];
    return {
      userAgent: selected.userAgent,
      search: (args) => selected.reader.invoke('search', args),
      detail: (id) => selected.reader.invoke('detail', id),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
function validPreviewUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    ![
      's3-alpha.figma.com',
      's3-alpha-sig.figma.com',
      's3-figma-hubfile-images-production-cdn-cgi.figma.com',
    ].includes(u.hostname)
  )
    throw new Error('community_preview_url_not_allowed');
  return u.href;
}
async function readPreview(url, { fetcher = fetch, userAgent } = {}) {
  if (
    typeof userAgent !== 'string' ||
    !userAgent ||
    userAgent.length > 1024 ||
    /[\r\n]/.test(userAgent)
  )
    throw new Error('community_preview_context_unavailable');
  const r = await fetcher(validPreviewUrl(url), {
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: 'image/png,image/jpeg,image/webp,image/gif',
      'User-Agent': userAgent,
      Referer: 'https://www.figma.com/',
    },
  });
  if (['challenge', 'captcha'].includes(r.headers.get('x-amzn-waf-action')))
    throw new Error(
      'community_preview_waf_' +
        r.headers.get('x-amzn-waf-action') +
        ': HTTP ' +
        r.status,
    );
  if (r.status !== 200) throw new Error('community_preview_http_' + r.status);
  const mimeType = r.headers.get('content-type')?.split(';')[0];
  if (
    !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)
  )
    throw new Error('community_preview_type_not_allowed');
  const limit = 2 * 1024 * 1024;
  const stream = r.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('community_preview_too_large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await stream.cancel().catch(() => {});
    throw error;
  }
  const bytes = Buffer.concat(chunks);
  const valid =
    mimeType === 'image/png'
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mimeType === 'image/gif'
          ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new Error('community_preview_invalid_image');
  return { mimeType, size, data: bytes.toString('base64') };
}
async function researchCommunity(
  input,
  { readerFactory = communityReader, fetcher } = {},
) {
  const args = validateResearch(input),
    reader = await readerFactory();
  let result;
  try {
    result =
      args.action === 'search'
        ? await reader.search(args)
        : await reader.detail(args.communityFileId);
  } finally {
    await reader.close();
  }
  if (args.action === 'preview') {
    const index = args.previewIndex ?? 0,
      preview = result.resource.previews[index];
    if (!preview) throw new Error('community_preview_unavailable');
    const image = await readPreview(preview.url, {
      fetcher,
      userAgent: reader.userAgent,
    });
    result = {
      ...result,
      preview: { ...preview, mimeType: image.mimeType, size: image.size },
      image,
    };
  }
  return {
    source: {
      kind: 'figma-community',
      transport: 'desktop-session',
      publicOnly: true,
      fetchedAt: new Date().toISOString(),
    },
    ...result,
  };
}
module.exports = {
  validateResearch,
  communityReader,
  readPreview,
  researchCommunity,
};
