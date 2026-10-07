const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const test = require('node:test');
test('the emitted authenticated browser worker compiles, including its diagnostic reporter', () => {
  const program = require('../scripts/catalog-sync.cjs').browserProgram();
  new Function('return (async()=>{' + program + '})();');
});
const { createCatalog, normalizeFile } = require('../scripts/catalog.cjs');
const { readAccountView } = require('../src/account-reader.js');
const file = (fileKey = 'FileAlpha12', name = 'Same name') => ({
  fileKey,
  name,
  url: 'https://www.figma.com/design/' + fileKey,
  thumbnailUrl: 'https://s3-alpha.figma.com/thumbnails/example.png',
  sessionToken: 'never-export',
});
test('catalog persists unopened files, excludes unneeded metadata and protects the private file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'catalog.json'),
    catalog = createCatalog(filename);
  catalog.update({
    status: 'ready',
    accountId: '12345678',
    files: [file(), file('FileBravo12')],
  });
  const reopened = createCatalog(filename).view();
  assert.equal(reopened.files.length, 2);
  assert.equal(reopened.status, 'ready');
  assert.doesNotMatch(
    fs.readFileSync(filename, 'utf8'),
    /never-export|sessionToken/,
  );
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});
test('catalog retains Figma creation and view timestamps, while missing or invalid fields remain unknown', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-catalog-times-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'catalog.json'),
    catalog = createCatalog(filename);
  const times = {
    updatedAt: '2024-03-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    lastViewedAt: '2024-02-01T00:00:00Z',
  };
  catalog.update({
    status: 'ready',
    accountId: '123',
    files: [{ ...file(), ...times }],
  });
  const reopened = createCatalog(filename).view().files[0];
  for (const field of Object.keys(times))
    assert.equal(reopened[field], times[field]);
  const absent = normalizeFile({
    ...file(),
    updatedAt: 'invalid',
    createdAt: null,
    lastViewedAt: 42,
  });
  for (const field of Object.keys(times)) assert.equal(absent[field], null);
});
function directoryFixture(name, data, args = {}) {
  const current = { status: 'loaded', data },
    subscription = {
      viewDef: { name },
      context: { viewArgs: args },
      subscriptions: [{}],
    };
  const session = {
    viewSubscriptions: new Map([['active', subscription]]),
    getViewResultByViewNameAndArgs: () => current,
  };
  const context = require('node:vm').createContext({
    window: {
      INITIAL_OPTIONS: { user_data: { id: '123', name: 'Fixture' } },
      LIVEGRAPH: { client: { session } },
    },
    location: { pathname: '/files/fixture', search: '' },
  });
  const read = async (next = false, source) =>
    JSON.parse(
      JSON.stringify(
        await require('node:vm').runInContext(
          '(' +
            readAccountView.toString() +
            ')(' +
            JSON.stringify({ loadNext: next, source }) +
            ')',
          context,
        ),
      ),
    );
  return { read, current, subscription, session, context };
}
test('a requested directory cannot complete from a stale loaded subscription during navigation', async () => {
  const f = directoryFixture('FileBrowserRecentResourcesGlobalView', {
    currentUser: {
      recentResources: pages([
        {
          userRecentResourceFile: {
            file: { key: 'OldFile123', name: 'Old recent file' },
          },
        },
      ]),
    },
  });
  const current = { status: 'loading', data: { folderItems: pages([]) } };
  const subscription = {
    viewDef: { name: 'FileBrowserDraftsPageV2View' },
    context: { viewArgs: {} },
    subscriptions: [{}],
  };
  f.session.viewSubscriptions.set('drafts', subscription);
  f.session.getViewResultByViewNameAndArgs = (name) =>
    name === subscription.viewDef.name ? current : f.current;
  const source = { kind: 'drafts', route: '/files/fixture' };
  assert.equal((await f.read(false, source)).ready, false);
  current.status = 'loaded';
  const result = await f.read(false, source);
  assert.equal(result.ready, true);
  assert.deepEqual(result.files, []);
  assert.equal(result.itemCount, 0);
  assert.equal(
    (await f.read(false, { ...source, route: '/files/new-route' })).ready,
    false,
  );
});
test('shared file and folder subscriptions do not borrow each other or unrelated loading state', async () => {
  const f = directoryFixture(
    'SharedWithYouResources',
    { sharedWithYouResourcesV2: pages([]) },
    { resourceTypes: ['folder'] },
  );
  const shared = {
    status: 'loading',
    data: {
      sharedWithYouResourcesV2: pages([
        {
          sharedWithYouFile: {
            file: { key: 'Shared12345', name: 'Shared file' },
          },
        },
      ]),
    },
  };
  const subscription = {
    viewDef: { name: 'SharedWithYouResources' },
    context: {
      viewArgs: { resourceTypes: ['file', 'file_repo', 'prototype'] },
    },
    subscriptions: [{}],
  };
  f.session.viewSubscriptions.set('files', subscription);
  f.session.getViewResultByViewNameAndArgs = (_, args) =>
    args === subscription.context.viewArgs ? shared : f.current;
  assert.equal((await f.read(false, { kind: 'shared_files' })).ready, false);
  const folders = await f.read(false, { kind: 'shared_folders' });
  assert.equal(folders.ready, true);
  assert.deepEqual(folders.files, []);
  shared.status = 'loaded';
  assert.deepEqual(
    (await f.read(false, { kind: 'shared_files' })).files.map(
      (file) => file.fileKey,
    ),
    ['Shared12345'],
  );
  assert.deepEqual((await f.read(false, { kind: 'shared_folders' })).files, []);
});
test('folder reads require the exact parent and primary directory, not only a child-folder subscription', async () => {
  const f = directoryFixture(
    'FileBrowserFolderPageV2View',
    { folderItems: pages([]) },
    { folderId: '456' },
  );
  assert.equal(
    (await f.read(false, { kind: 'folder', folderId: '123' })).ready,
    false,
  );
  assert.equal(
    (await f.read(false, { kind: 'folder', folderId: '456' })).ready,
    true,
  );
  f.subscription.viewDef.name = 'FileBrowserFolderPageChildFoldersView';
  assert.equal(
    (await f.read(false, { kind: 'folder', folderId: '456' })).ready,
    false,
  );
});
function pages(items, more = false, next = () => {}) {
  return Object.assign(items, {
    hasNextPage: () => more,
    isLoadingNextPage: false,
    loadNext() {
      next();
      more = false;
    },
  });
}
test('directory arrays provide exact timestamps and end cursors without React or DOM state', async () => {
  const fileData = {
    key: 'FileAlpha12',
    editorType: 'design',
    name: 'Example',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-02-01'),
  };
  const item = {
    folderItemFile: { file: fileData },
    touchedAt: '2024-03-01T00:00:00.123456Z',
  };
  const f = directoryFixture('FileBrowserDraftsPageV2View', {
    folderItems: pages([item]),
    project: { activeProjectResourceConnections: [] },
  });
  let view = await f.read(),
    data = view.files[0];
  assert.equal(view.ready, true);
  assert.equal(view.hasNextPage, false);
  assert.equal(data.updatedAt, '2024-03-01T00:00:00.123Z');
  assert.equal(data.createdAt, '2024-01-01T00:00:00.000Z');
  assert.equal(data.lastViewedAt, null);
  delete item.touchedAt;
  delete fileData.createdAt;
  data = (await f.read()).files[0];
  assert.equal(data.updatedAt, null);
  assert.equal(data.createdAt, null, 'metadata updatedAt is not a substitute');
  fileData.touchedAt = '2024-03-02T00:00:00Z';
  const recent = directoryFixture('FileBrowserRecentResourcesGlobalView', {
    currentUser: {
      recentResources: pages([
        {
          userRecentResourceFile: { file: fileData },
          actionAt: new Date('2024-04-01'),
        },
      ]),
    },
  });
  data = (await recent.read()).files[0];
  assert.equal(data.lastViewedAt, '2024-04-01T00:00:00.000Z');
  assert.equal(data.updatedAt, '2024-03-02T00:00:00.000Z');
});
test('pagination loads the real next page and treats loaded empty directories as complete', async () => {
  let calls = 0;
  const items = pages([], true, () => {
    calls++;
    items.push({
      folderItemFile: {
        file: { key: 'FileAlpha12', name: 'Next page', editorType: 'design' },
      },
    });
  });
  const f = directoryFixture('FileBrowserFolderPageV2View', {
    folderItems: items,
  });
  assert.equal((await f.read()).hasNextPage, true);
  assert.equal(calls, 0);
  assert.equal((await f.read(true)).fetching, true);
  assert.equal(calls, 1);
  const end = await f.read();
  assert.equal(end.hasNextPage, false);
  assert.equal(end.files.length, 1);
  assert.equal(end.itemCount, 1);
  const empty = await directoryFixture('SharedWithYouResources', {
    sharedWithYouResourcesV2: pages([]),
  }).read();
  assert.equal(empty.ready, true);
  assert.equal(empty.hasNextPage, false);
  assert.equal(empty.files.length, 0);
});
test('loading, inactive, filtered and changed directory schemas cannot claim account completeness', async () => {
  const f = directoryFixture('FileBrowserDraftsPageV2View', {
    folderItems: pages([]),
  });
  f.current.status = 'loading';
  assert.equal((await f.read()).ready, false);
  f.current.status = 'loaded';
  f.subscription.subscriptions = [];
  assert.equal((await f.read()).ready, false);
  await assert.rejects(
    directoryFixture('FileBrowserDraftsPageV2View', { folderItems: [] }).read(),
    /pagination_schema_changed/,
  );
  await assert.rejects(
    directoryFixture('FileBrowserDraftsPageV2View', { changed: 42 }).read(),
    /directory_schema_changed/,
  );
  await assert.rejects(
    directoryFixture(
      'SharedWithYouResources',
      { sharedWithYouResourcesV2: pages([]) },
      { fileType: 'design' },
    ).read(),
    /filtered/,
  );
});
test('shared files and child folders use actual Figma relations while deleted items are omitted', async () => {
  const f = directoryFixture('SharedWithYouResources', {
    sharedWithYouResourcesV2: pages([
      {
        sharedWithYouFile: {
          file: {
            key: 'FileAlpha12',
            name: 'Shared',
            editorType: 'design',
            touchedAt: '2024-03-01T00:00:00Z',
          },
        },
      },
      {
        sharedWithYouFile: {
          file: { key: 'FileBravo12', name: 'Deleted', deletedAt: new Date() },
        },
      },
      { sharedWithYouFolder: { folder: { id: '456', path: 'Folder title' } } },
    ]),
  });
  const view = await f.read();
  assert.equal(view.files.length, 1);
  assert.equal(view.files[0].name, 'Shared');
  assert.equal(view.files[0].lastViewedAt, null);
  assert.deepEqual(view.folders, [{ id: '456', name: 'Folder title' }]);
});
test('partial sync cannot remove old files; complete sync and account changes replace the directory', () => {
  const catalog = createCatalog();
  catalog.update({
    status: 'ready',
    accountId: '123',
    files: [file(), file('FileBravo12')],
  });
  catalog.update({
    status: 'incomplete',
    accountId: '123',
    files: [file('FileCharlie12')],
  });
  assert.equal(catalog.view().files.length, 3);
  catalog.update({
    status: 'ready',
    accountId: '123',
    files: [file('FileCharlie12')],
  });
  assert.equal(catalog.view().files.length, 1);
  catalog.update({ status: 'syncing', accountId: '456', files: [] });
  assert.equal(catalog.view().files.length, 0);
  assert.equal(catalog.view().bindings.length, 0);
});
test('a new refresh clears old coverage, and completed browser cleanup removes the stale recovery handle', () => {
  const catalog = createCatalog();
  catalog.update({
    status: 'ready',
    accountId: '123',
    files: [file()],
    coverage: [{ route: '/old', complete: true, fileCount: 1 }],
    browserSpace: 68,
  });
  let value = catalog.update({ status: 'syncing' });
  assert.deepEqual(value.coverage, []);
  assert.equal(value.files.length, 1);
  catalog.update({
    status: 'syncing',
    coverage: [{ route: '/new', complete: true, fileCount: 1 }],
  });
  assert.equal(catalog.update({ status: 'syncing' }).coverage[0].route, '/new');
  value = catalog.update({
    status: 'ready',
    fileKeys: ['FileAlpha12'],
    browserSpace: null,
  });
  assert.equal(value.browserSpace, null);
  assert.equal(value.coverage[0].route, '/new');
});
test('same-name files require an exact document, client and verified cloud URL; reconnect never falls back to title', () => {
  const catalog = createCatalog(),
    documentId = 'a'.repeat(32);
  catalog.update({
    status: 'ready',
    accountId: '123',
    files: [file(), file('FileBravo12')],
  });
  const client = {
    id: 'client-exact',
    instanceId: 'c'.repeat(32),
    documentId,
    connected: true,
    fileName: 'Same name',
  };
  const binding = {
    fileKey: 'FileBravo12',
    clientId: client.id,
    documentId,
    verifiedUrl: 'https://www.figma.com/design/FileBravo12',
  };
  assert.throws(
    () =>
      catalog.bind(
        { ...binding, verifiedUrl: 'https://www.figma.com/design/FileAlpha12' },
        [client],
      ),
    /exact|exact requested|requested fileKey/,
  );
  assert.throws(
    () => catalog.bind(binding, [{ ...client, documentId: 'b'.repeat(32) }]),
    /exact/,
  );
  catalog.bind(binding, [client]);
  assert.equal(catalog.decorate([client])[0].fileKey, 'FileBravo12');
  assert.equal(
    catalog.decorate([{ ...client, id: 'another-client' }])[0].fileKey,
    undefined,
  );
  assert.equal(
    catalog.decorate([{ ...client, documentId: 'b'.repeat(32) }])[0].fileKey,
    undefined,
  );
  assert.equal(
    catalog.decorate([{ ...client, instanceId: 'd'.repeat(32) }])[0].fileKey,
    undefined,
  );
});
test('catalog rejects external file links, ambiguous identities and external cover fetches', () => {
  for (const extra of [
    { url: 'https://example.com/design/FileAlpha12' },
    { url: 'https://www.figma.com/design/FileBravo12' },
    { thumbnailUrl: 'http://127.0.0.1/private' },
    { thumbnailUrl: 'https://s3-alpha.figma.com@evil.example/thumbnails/x' },
  ])
    assert.throws(() => normalizeFile({ ...file(), ...extra }));
});
test('failed catalog persistence does not publish a cloud binding or partially update the directory', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-catalog-write-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'catalog.json'),
    catalog = createCatalog(filename);
  catalog.update({ status: 'ready', accountId: '123', files: [file()] });
  const before = catalog.view(),
    client = {
      id: 'exact-client',
      documentId: 'a'.repeat(32),
      instanceId: 'b'.repeat(32),
      connected: true,
    };
  fs.unlinkSync(filename);
  fs.mkdirSync(filename);
  assert.throws(
    () =>
      catalog.bind(
        {
          fileKey: 'FileAlpha12',
          clientId: client.id,
          documentId: client.documentId,
          verifiedUrl: file().url,
        },
        [client],
      ),
    /EISDIR/,
  );
  assert.deepEqual(catalog.view(), before);
  assert.equal(catalog.decorate([client])[0].fileKey, undefined);
  assert.throws(
    () => catalog.update({ status: 'ready', files: [file('FileBravo12')] }),
    /EISDIR/,
  );
  assert.deepEqual(catalog.view(), before);
});
test('stopping the companion stops its owned account worker and marks an interrupted crawl incomplete', async (t) => {
  const cp = require('node:child_process'),
    spawn = cp.spawn;
  let worker;
  t.mock.method(cp, 'spawn', () => {
    worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    return worker;
  });
  const { createBridgeServer } = require('../scripts/bridge-server.cjs'),
    bridge = createBridgeServer({ port: 0 });
  const { url } = await bridge.start();
  t.after(() => bridge.stop());
  const response = await fetch(url + '/v1/catalog/sync', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bridge.token },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'syncing');
  await bridge.stop();
  assert.notEqual(worker.signalCode, null);
  assert.throws(() => process.kill(worker.pid, 0), /ESRCH/);
});
test('paged catalog updates finalize by exact key set without one oversized metadata request', () => {
  const catalog = createCatalog();
  catalog.update({
    status: 'ready',
    accountId: '123',
    files: [file('DeletedFile12')],
  });
  for (let offset = 0; offset < 1500; offset += 500)
    catalog.update({
      status: 'syncing',
      files: Array.from({ length: 500 }, (_, index) =>
        file('CatalogKey' + String(offset + index).padStart(8, '0')),
      ),
    });
  const fileKeys = catalog
    .view()
    .files.map((file) => file.fileKey)
    .filter((key) => key !== 'DeletedFile12');
  const before = catalog.view();
  assert.throws(
    () =>
      catalog.update({
        status: 'ready',
        accountId: '456',
        files: [file('Replacement12')],
        fileKeys: ['MissingKey12'],
      }),
    /missing/,
  );
  assert.deepEqual(catalog.view(), before);
  assert.throws(
    () => catalog.update({ status: 'ready', fileKeys: ['MissingKey12'] }),
    /missing/,
  );
  catalog.update({ status: 'ready', fileKeys });
  assert.equal(catalog.view().files.length, 1500);
  assert.equal(catalog.view().status, 'ready');
});
test('account catalog routes remain admin-only, even for a paired native plugin', async (t) => {
  const { createBridgeServer } = require('../scripts/bridge-server.cjs');
  const { BRIDGE_RUNTIME_VERSION } = require('../src/core.js');
  const bridge = createBridgeServer({ port: 0 }),
    { url } = await bridge.start();
  t.after(() => bridge.stop());
  const anonymous = await fetch(url + '/v1/catalog');
  assert.equal(anonymous.status, 401);
  const pairing = bridge.createPairing();
  const r = await fetch(url + '/v1/pair', {
    method: 'POST',
    body: JSON.stringify({
      code: pairing.code,
      clientId: 'test-client',
      fileName: 'Test',
      runtimeVersion: BRIDGE_RUNTIME_VERSION,
    }),
  });
  const { token } = await r.json();
  assert.equal(
    (
      await fetch(url + '/v1/catalog', {
        headers: { authorization: 'Bearer ' + token },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + '/v1/catalog', {
        headers: { authorization: 'Bearer ' + bridge.token },
      })
    ).status,
    200,
  );
});

test('a verified new file binds without waiting for the account cache; conflicts report the actual condition', () => {
  const catalog = createCatalog(),
    client = {
      id: 'native-client',
      documentId: 'a'.repeat(32),
      instanceId: 'b'.repeat(32),
      connected: true,
      fileName: 'Created in Figma',
      editorType: 'figma',
    };
  const input = {
    fileKey: 'NewCloudFile12',
    clientId: client.id,
    documentId: client.documentId,
    verifiedUrl: 'https://www.figma.com/design/NewCloudFile12',
  };
  assert.throws(() => catalog.bind(input, []), /clientId.*disconnected/);
  assert.throws(
    () => catalog.bind(input, [{ ...client, fileKey: 'OtherFile12' }]),
    /another fileKey/,
  );
  catalog.bind(input, [client]);
  assert.equal(catalog.view().files[0].name, client.fileName);
  assert.equal(catalog.decorate([client])[0].fileKey, input.fileKey);
});
test('a failed sync can retry after cooldown; it is not permanently suppressed as incomplete', async (t) => {
  const cp = require('node:child_process'),
    spawn = cp.spawn;
  const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'figma-catalog-retry-'),
    ),
    filename = path.join(directory, 'catalog.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const catalog = createCatalog(filename);
  catalog.update({ status: 'incomplete', accountId: '123' });
  let count = 0;
  t.mock.method(cp, 'spawn', () => {
    count++;
    return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
  });
  const { createBridgeServer } = require('../scripts/bridge-server.cjs'),
    bridge = createBridgeServer({ port: 0, catalogPath: filename }),
    { url } = await bridge.start();
  t.after(() => bridge.stop());
  const response = await fetch(url + '/v1/catalog/sync', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bridge.token },
    body: '{}',
  });
  assert.equal((await response.json()).status, 'syncing');
  assert.equal(count, 1);
  const again = await fetch(url + '/v1/catalog/sync', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + bridge.token },
    body: '{}',
  });
  assert.equal((await again.json()).status, 'syncing');
  assert.equal(count, 1);
});
