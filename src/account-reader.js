// Read the authenticated file browser's active LiveGraph directory views.
// Their paginated arrays supply data and end cursors; no DOM/React guessing
// or separate account credentials/query transport is used.
function readAccountView({ loadNext = false, source } = {}) {
  const user = window.INITIAL_OPTIONS?.user_data;
  const result = {
    accountId: user?.id ? String(user.id) : null,
    accountName: user?.name || '',
    route: location.pathname + location.search,
    files: [],
    folders: [],
    ready: false,
    hasNextPage: false,
    fetching: false,
    itemCount: 0,
  };
  const session = window.LIVEGRAPH?.client?.session;
  if (!session) return result;
  if (source?.route && source.route !== result.route) return result;
  const names = {
    drafts: ['FileBrowserDraftsPageV2View'],
    folders: ['FileBrowserTeamPageFolderItemsView'],
    folder: [
      'FileBrowserFolderPageV2View',
      'FileBrowserFolderPageChildFoldersView',
    ],
    recent: ['FileBrowserRecentResourcesGlobalView'],
    shared_files: ['SharedWithYouResources'],
    shared_folders: ['SharedWithYouResources'],
  };
  if (source && !Object.hasOwn(names, source.kind))
    throw new Error('unknown_account_directory_source');
  const expectedNames = source
    ? names[source.kind]
    : Object.values(names).flat();
  // Navigation changes the URL before old subscriptions are released. Only
  // the requested directory may supply its files or pagination completion.
  const roots = [...session.viewSubscriptions.values()].filter(
    (view) =>
      view.subscriptions.length &&
      expectedNames.includes(view.viewDef.name) &&
      (!source?.folderId ||
        String(view.context.viewArgs.folderId) === source.folderId ||
        view.context.viewArgs.compositeParentResourceId ===
          'folder:' + source.folderId) &&
      (!source?.kind.startsWith('shared_') ||
        (source.kind === 'shared_folders'
          ? view.context.viewArgs.resourceTypes?.length === 1 &&
            view.context.viewArgs.resourceTypes[0] === 'folder'
          : view.context.viewArgs.resourceTypes?.includes('file') &&
            !view.context.viewArgs.resourceTypes.includes('folder'))),
  );
  if (!roots.length) return result;
  if (
    source?.kind === 'folder' &&
    !roots.some((view) => view.viewDef.name === names.folder[0])
  )
    return result;
  const files = new Map(),
    folders = new Map(),
    collections = [];
  const date = (value) => {
    try {
      const n = typeof value === 'string' ? Date.parse(value) : Number(value);
      return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
    } catch {
      return null;
    }
  };
  for (const view of roots) {
    const current = session.getViewResultByViewNameAndArgs(
      view.viewDef.name,
      view.context.viewArgs,
    );
    if (current.status !== 'loaded') return result;
    const items =
      current.data?.folderItems ??
      current.data?.currentUser?.recentResources ??
      current.data?.sharedWithYouResourcesV2;
    if (!Array.isArray(items))
      throw new Error('account_directory_schema_changed');
    if (
      typeof items.hasNextPage !== 'function' ||
      typeof items.loadNext !== 'function' ||
      typeof items.isLoadingNextPage !== 'boolean'
    )
      throw new Error('account_pagination_schema_changed');
    collections.push(items);
    if (
      view.viewDef.name === 'SharedWithYouResources' &&
      (view.context.viewArgs.fileType ||
        view.context.viewArgs.planId ||
        view.context.viewArgs.sharedBy ||
        view.context.viewArgs.sharedToFilter ||
        view.context.viewArgs.sharedToUserGroupIdFilter?.length)
    )
      throw new Error('account_directory_filtered');
  }
  for (const items of collections) {
    const more = items.hasNextPage();
    if (typeof more !== 'boolean')
      throw new Error('account_pagination_schema_changed');
    result.hasNextPage ||= more;
    result.fetching ||= items.isLoadingNextPage;
    result.itemCount += items.length;
    for (const item of items) {
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
        files.set(file.key, {
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
        if (!/^\d+$/.test(String(folder.id || '')) || typeof name !== 'string')
          throw new Error('account_folder_schema_changed');
        folders.set(String(folder.id), { id: String(folder.id), name });
      }
    }
    if (loadNext && more && !items.isLoadingNextPage) {
      // Figma's native loadNext registers pagination synchronously; its own
      // array exposes loading and end state. Network waits belong to the
      // worker's polling loop, not a pending browser evaluation.
      items.loadNext();
      result.fetching = true;
    }
  }
  result.files = [...files.values()];
  result.folders = [...folders.values()];
  result.ready = true;
  return result;
}
if (typeof module !== 'undefined') module.exports = { readAccountView };
