// Execute in Figma Home's existing authenticated renderer. Own subscriptions
// read the same directories as Home without changing its navigation or filters.
function createAccountReader() {
  const client = window.LIVEGRAPH?.client;
  const initial = window.INITIAL_OPTIONS?.user_data;
  if (!initial?.id) throw new Error('login_required');
  if (!client?.subscribe || !client.viewRegistry)
    throw new Error('account_directory_unavailable');
  const accountId = String(initial.id);
  let current,
    unsubscribe,
    lease,
    closed = false;
  function close() {
    clearTimeout(lease);
    unsubscribe?.();
    unsubscribe = null;
    current = null;
    closed = true;
  }
  function check() {
    if (closed) throw new Error('account_reader_closed');
    if (
      String(window.INITIAL_OPTIONS?.user_data?.id) !== accountId ||
      window.LIVEGRAPH?.client !== client
    ) {
      close();
      throw new Error('account_changed');
    }
    clearTimeout(lease);
    // A crashed worker cannot leave subscriptions alive indefinitely.
    lease = setTimeout(close, 60000);
  }
  const date = (value) => {
    const n = typeof value === 'string' ? Date.parse(value) : Number(value);
    const date = new Date(n);
    return Number.isFinite(date.getTime()) && n > 0 ? date.toISOString() : null;
  };
  return {
    identity() {
      check();
      return { accountId, accountName: initial.name || '' };
    },
    async plans() {
      check();
      const response = await fetch('/api/user/plans', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('plan_directory_unavailable');
      const value = await response.json();
      check();
      if (!Array.isArray(value.meta?.plans) || !value.meta.plans.length)
        throw new Error('plan_directory_empty');
      return value.meta.plans.map((p) => ({
        id: String(p.plan_id),
        type: p.plan_type,
        draftFolderId: p.has_drafts ? String(p.draft_folder_id) : null,
      }));
    },
    open(name, args) {
      check();
      const def = client.viewRegistry.get(name);
      if (
        !def ||
        def.args.some((arg) => !arg.nullable && !Object.hasOwn(args, arg.name))
      )
        throw new Error('account_directory_schema_changed');
      unsubscribe?.();
      current = { status: 'loading' };
      // LiveGraph resolves its current view definition; no captured build hash.
      unsubscribe = client.subscribe(
        { _name: name, _argKeys: def.args.map((arg) => arg.name) },
        args,
        (result) => {
          current = result;
        },
      );
    },
    read(loadNext = false, offset = 0) {
      check();
      if (current?.errors?.length)
        throw new Error('account_directory_request_failed');
      const result = {
        accountId,
        ready: false,
        files: [],
        folders: [],
        teams: [],
        hasNextPage: false,
        fetching: false,
        itemCount: 0,
      };
      if (current?.status !== 'loaded') return result;
      const data = current.data;
      const items =
        data?.folderItems ??
        data?.currentUser?.recentResources ??
        data?.sharedWithYouResourcesV2 ??
        data?.orgDiscoverableTeams ??
        data?.orgJoinedTeams;
      if (!Array.isArray(items))
        throw new Error('account_directory_schema_changed');
      if (
        typeof items.hasNextPage !== 'function' ||
        typeof items.loadNext !== 'function' ||
        typeof items.isLoadingNextPage !== 'boolean'
      )
        throw new Error('account_pagination_schema_changed');
      const more = items.hasNextPage();
      if (typeof more !== 'boolean')
        throw new Error('account_pagination_schema_changed');
      result.hasNextPage = more;
      result.fetching = items.isLoadingNextPage;
      result.itemCount = items.length;
      result.nextOffset = Math.min(items.length, offset + 500);
      for (const item of items.slice(offset, result.nextOffset)) {
        const file =
          item.folderItemFile?.file ||
          item.userRecentResourceFile?.file ||
          item.sharedWithYouFile?.file ||
          item.sharedWithYouRepo?.repo?.sourceFile;
        if (file && !file.deletedAt && !file.trashedAt) {
          if (
            !/^[A-Za-z0-9]{6,100}$/.test(file.key || '') ||
            typeof file.name !== 'string' ||
            !file.name.trim()
          )
            throw new Error('account_file_schema_changed');
          result.files.push({
            fileKey: file.key,
            name: file.name,
            editorType: file.editorType,
            url: file.editUrl || file.url,
            thumbnailUrl: file.thumbnailUrl,
            updatedAt: date(
              item.folderItemFile ? item.touchedAt : file.touchedAt,
            ),
            createdAt: date(file.createdAt),
            lastViewedAt: date(
              item.userRecentResourceFile ? item.actionAt : null,
            ),
            folderId: String(file.folderId || ''),
            teamId: String(file.teamId || ''),
          });
        }
        const folder =
          item.folderItemFolder?.folder || item.sharedWithYouFolder?.folder;
        if (folder && !folder.deletedAt && !folder.trashedAt) {
          const name = folder.name ?? folder.path;
          if (
            !/^\d+$/.test(String(folder.id || '')) ||
            typeof name !== 'string'
          )
            throw new Error('account_folder_schema_changed');
          result.folders.push({ id: String(folder.id), name });
        }
        if (item.team && !item.team.deletedAt) {
          if (!/^\d+$/.test(String(item.team.id || '')))
            throw new Error('account_team_schema_changed');
          result.teams.push(String(item.team.id));
        }
      }
      if (loadNext && more && !items.isLoadingNextPage) {
        items.loadNext();
        result.fetching = true;
      }
      result.ready = true;
      return result;
    },
    close,
  };
}
if (typeof module !== 'undefined') module.exports = { createAccountReader };
