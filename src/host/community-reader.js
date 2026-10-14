// Runs inside an existing Figma Desktop Home renderer. All service requests
// are GETs in that renderer; credentials never leave its authenticated context.
function createCommunityReader() {
  let accountId,
    closed = false;
  const origin = location.origin;
  if (!['https://www.figma.com', 'https://figma.com'].includes(origin))
    throw new Error('community_home_unavailable');
  const hint = new URL(location.href).searchParams.get('fuid');
  const fail = (code) => {
    throw new Error(code);
  };
  function check() {
    if (closed) fail('community_reader_closed');
    const current = new URL(location.href);
    if (
      current.origin !== origin ||
      !/^\/(files|community)(\/|$)/.test(current.pathname) ||
      current.searchParams.get('fuid') !== hint
    )
      fail('community_account_changed');
    const live = window.INITIAL_OPTIONS?.user_data?.id;
    if (accountId && live && String(live) !== accountId)
      fail('community_account_changed');
  }
  async function response(path) {
    check();
    const url = new URL(path, origin);
    if (
      url.origin !== origin ||
      !/^\/(community|api\/search\/resources|api\/resources\/hub_files\/\d+)$/.test(
        url.pathname,
      )
    )
      fail('community_request_not_allowed');
    if (accountId || hint) url.searchParams.set('fuid', accountId || hint);
    const r = await fetch(url.href, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 401) fail('community_login_required');
    if (r.status === 403) fail('community_access_denied');
    if (r.status === 404) fail('community_resource_not_found');
    if (r.status === 429) fail('community_rate_limited');
    if (!r.ok) fail('community_http_' + r.status);
    const bytes = Number(r.headers.get('content-length') || 0);
    if (bytes > 4 * 1024 * 1024) fail('community_response_too_large');
    return r;
  }
  async function body(r) {
    const reader = r.body.getReader(),
      decoder = new TextDecoder();
    let size = 0,
      output = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) fail('community_response_too_large');
        output += decoder.decode(value, { stream: true });
      }
      return output + decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  }
  async function identity() {
    check();
    let user = window.INITIAL_OPTIONS?.user_data;
    if (!user?.id) {
      // Home may still be streaming its bootstrap document. Read the same
      // signed-in bootstrap as data, without navigating or evaluating scripts.
      const html = await body(await response('/community'));
      const match = html.match(
        /<script\b[^>]*\bdata-initial\b[^>]*>([\s\S]*?)<\/script>/i,
      );
      if (!match) fail('community_session_schema_changed');
      try {
        user = JSON.parse(match[1]).INITIAL_OPTIONS?.user_data;
      } catch {
        fail('community_session_schema_changed');
      }
    }
    if (!user?.id) fail('community_login_required');
    const current = String(user.id);
    if (!/^\d{1,30}$/.test(current)) fail('community_session_schema_changed');
    if ((accountId && accountId !== current) || (hint && hint !== current))
      fail('community_account_changed');
    accountId = current;
    return { accountId, userAgent: navigator.userAgent };
  }
  const text = (value, max = 2000) => {
    if (typeof value !== 'string') return null;
    return value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<\/(?:p|li|div|h[1-6])>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(
        /&(?:nbsp|amp|lt|gt|quot|#39);/g,
        (s) =>
          ({
            '&nbsp;': ' ',
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#39;': "'",
          })[s],
      )
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim()
      .slice(0, max);
  };
  function imageUrl(value) {
    if (typeof value !== 'string' || value.length > 4000) return null;
    try {
      const u = new URL(value);
      return u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.port &&
        [
          's3-alpha.figma.com',
          's3-alpha-sig.figma.com',
          's3-figma-hubfile-images-production-cdn-cgi.figma.com',
        ].includes(u.hostname)
        ? u.href
        : null;
    } catch {
      return null;
    }
  }
  function resource(m, expectedId) {
    if (
      !m ||
      typeof m !== 'object' ||
      m.publish_scope !== 'community' ||
      m.publishing_status !== 'approved_public' ||
      m.unpublished_at ||
      !['design_template', 'ui_kit'].includes(m.resource_type) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.id || '') ||
      !/^\d{6,30}$/.test(m.content_id || '') ||
      (expectedId && m.content_id !== expectedId) ||
      typeof m.name !== 'string' ||
      !m.name.trim()
    )
      fail('community_resource_schema_changed');
    const content = m.content?.hub_file;
    if (content && String(content.id) !== m.content_id)
      fail('community_resource_identity_mismatch');
    const canonical = new URL(m.community_rdp_url || m.rdp_url || '', origin);
    if (
      !['https://www.figma.com', 'https://figma.com'].includes(
        canonical.origin,
      ) ||
      canonical.username ||
      canonical.password ||
      canonical.pathname.split('/').slice(0, 4).join('/') !==
        '/community/file/' + m.content_id
    )
      fail('community_resource_identity_mismatch');
    const previews = [];
    const add = (url, kind) => {
      const safe = imageUrl(url);
      if (safe && !previews.some((p) => p.url === safe) && previews.length < 10)
        previews.push({ index: previews.length, kind, url: safe });
    };
    add(
      content?.resized_thumbnail_urls?.['1200'] || content?.thumbnail_url,
      'file-cover',
    );
    add(m.thumbnail_src_set?.['1200'] || m.thumbnail_url, 'community-cover');
    const carousel = Array.isArray(m.carousel_media)
      ? m.carousel_media
      : m.carousel_media?.images;
    if (carousel && typeof carousel === 'object')
      for (const [, media] of Object.entries(carousel).sort(
        ([a], [b]) => Number(a) - Number(b),
      ))
        if (media && typeof media === 'object')
          add(media.url || media.image_url || media.thumbnail_url, 'carousel');
    const creator = m.publisher || m.creator || {};
    return {
      resourceId: m.id,
      communityFileId: m.content_id,
      name: text(m.name, 1000),
      description: text(m.description, 8000),
      descriptionTruncated:
        typeof m.description === 'string' && m.description.length > 8000,
      url: 'https://www.figma.com/community/file/' + m.content_id,
      resourceType: text(m.resource_type, 100),
      editorTypes: Array.isArray(m.editor_types)
        ? m.editor_types.filter((v) => typeof v === 'string').slice(0, 10)
        : [],
      author: {
        name: text(creator.name || creator.handle, 200),
        handle: text(creator.profile_handle || creator.handle, 200),
      },
      tags: Array.isArray(m.tags)
        ? m.tags.filter((v) => typeof v === 'string').slice(0, 30)
        : [],
      updatedAt: text(m.updated_at, 50),
      stats: {
        likes: Number.isSafeInteger(m.like_count) ? m.like_count : null,
        uses: Number.isSafeInteger(m.user_count) ? m.user_count : null,
      },
      pricing: {
        thirdPartyMonetized:
          typeof m.is_3rd_party_monetized === 'boolean'
            ? m.is_3rd_party_monetized
            : null,
        monetizationStatus: text(content?.monetization_status, 100),
      },
      license: null,
      previews,
    };
  }
  async function json(path) {
    const r = await response(path);
    let data;
    try {
      data = JSON.parse(await body(r));
    } catch (error) {
      if (error.message === 'community_response_too_large') throw error;
      fail('community_response_schema_changed');
    }
    if (!data || typeof data !== 'object' || data.error || !data.meta)
      fail('community_response_schema_changed');
    check();
    return data;
  }
  return {
    identity,
    async search({ query, page = 1, pageSize = 12, sortBy = 'relevancy' }) {
      if (!accountId) fail('community_login_required');
      const params = new URLSearchParams({
        query,
        resource_type: 'design_template,ui_kit',
        publish_scope: 'community',
        sort_by: sortBy,
        include_content: 'true',
        from: String((page - 1) * pageSize),
        page_size: String(pageSize),
      });
      const data = await json('/api/search/resources?' + params);
      if (!Array.isArray(data.meta.results))
        fail('community_response_schema_changed');
      const total =
        data.pagination?.total_resource_count ?? data.meta.total_hits;
      if (!Number.isSafeInteger(total) || total < 0)
        fail('community_pagination_schema_changed');
      const resources = data.meta.results.map((x) => resource(x.model));
      if (resources.length > pageSize)
        fail('community_pagination_schema_changed');
      const next = data.pagination?.next_page;
      if (
        !data.pagination ||
        (total > (page - 1) * pageSize + resources.length && !next)
      )
        fail('community_pagination_schema_changed');
      if (next) {
        const u = new URL(next, origin);
        if (
          u.origin !== origin ||
          u.pathname !== '/api/search/resources' ||
          Number(u.searchParams.get('from')) !== page * pageSize
        )
          fail('community_pagination_schema_changed');
      }
      await identity();
      return {
        query,
        sortBy,
        page,
        pageSize,
        totalResults: total,
        hasNextPage: !!next,
        nextPage: next ? page + 1 : null,
        coverage: 'one_search_page',
        resources,
      };
    },
    async detail(id) {
      if (!accountId) fail('community_login_required');
      const data = await json(
        '/api/resources/hub_files/' + id + '?include_fig_file_metadata=true',
      );
      const result = resource(data.meta.resource, id);
      await identity();
      return { resource: result };
    },
    close() {
      closed = true;
      accountId = null;
    },
  };
}
if (typeof module !== 'undefined') module.exports = { createCommunityReader };
