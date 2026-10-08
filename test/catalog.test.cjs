const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const test = require('node:test');
const { createCatalog, normalizeFile } = require('../src/host/catalog.cjs');
const { createAccountReader } = require('../src/host/account-reader.js');
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
function directoryFixture(t, data, args = {}) {
  const current = { status: 'loaded', data },
    calls = [],
    cancellations = [];
  let observer;
  const client = {
    viewRegistry: {
      get: () => ({ args: Object.keys(args).map((name) => ({ name })) }),
    },
    subscribe(ref, requested, callback) {
      calls.push({ ref, args: requested });
      observer = callback;
      callback(current);
      return () => cancellations.push(ref._name);
    },
  };
  let expiry;
  const context = require('node:vm').createContext({
    window: {
      INITIAL_OPTIONS: { user_data: { id: '123', name: 'Fixture' } },
      LIVEGRAPH: { client },
    },
    setTimeout: (callback) => {
      expiry = callback;
      return 1;
    },
    clearTimeout: () => {},
    fetch: async () => ({
      ok: true,
      json: async () => ({
        meta: {
          plans: [
            {
              plan_id: '456',
              plan_type: 'team',
              has_drafts: true,
              draft_folder_id: '789',
            },
          ],
        },
      }),
    }),
    AbortSignal,
  });
  const reader = require('node:vm').runInContext(
    '(' + createAccountReader.toString() + ')()',
    context,
  );
  t.after(() => reader.close());
  reader.open('FileBrowserDraftsPageV2View', args);
  return {
    reader,
    read: (next) => JSON.parse(JSON.stringify(reader.read(next))),
    current,
    calls,
    cancellations,
    context,
    publish: () => observer(current),
    expire: () => expiry(),
  };
}
test('owned directory subscriptions ignore navigation filters, use live argument definitions and clean up only their own views', (t) => {
  const f = directoryFixture(
    t,
    { folderItems: pages([]) },
    { compositeParentResourceId: 'folder:456' },
  );
  assert.equal(f.read().ready, true);
  assert.deepEqual(f.calls[0].ref._argKeys, ['compositeParentResourceId']);
  assert.equal(
    f.calls[0].ref._hash,
    undefined,
    'no stale Figma build hash is captured',
  );
  f.reader.open('FileBrowserFolderPageV2View', {
    compositeParentResourceId: 'folder:789',
  });
  assert.deepEqual(f.cancellations, ['FileBrowserDraftsPageV2View']);
  f.reader.close();
  assert.deepEqual(f.cancellations, [
    'FileBrowserDraftsPageV2View',
    'FileBrowserFolderPageV2View',
  ]);
});
test('Figma timestamps and original relation metadata remain exact; missing timestamps stay unknown', (t) => {
  const fileData = {
    key: 'FileAlpha12',
    name: 'Example',
    editorType: 'design',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-02-01'),
  };
  const item = {
    folderItemFile: { file: fileData },
    touchedAt: '2024-03-01T00:00:00.123456Z',
  };
  const f = directoryFixture(t, { folderItems: pages([item]) });
  let data = f.read().files[0];
  assert.equal(data.updatedAt, '2024-03-01T00:00:00.123Z');
  assert.equal(data.createdAt, '2024-01-01T00:00:00.000Z');
  assert.equal(data.lastViewedAt, null);
  delete item.touchedAt;
  delete fileData.createdAt;
  data = f.read().files[0];
  assert.equal(data.updatedAt, null);
  assert.equal(data.createdAt, null);
  fileData.touchedAt = '2024-03-02T00:00:00Z';
  f.current.data = {
    currentUser: {
      recentResources: pages([
        {
          userRecentResourceFile: { file: fileData },
          actionAt: new Date('2024-04-01'),
        },
      ]),
    },
  };
  data = f.read().files[0];
  assert.equal(data.lastViewedAt, '2024-04-01T00:00:00.000Z');
  assert.equal(data.updatedAt, '2024-03-02T00:00:00.000Z');
});
test('pagination uses Figma end cursors, including next-page loading and complete empty directories', (t) => {
  let calls = 0;
  const items = pages([], true, () => {
    calls++;
    items.push({
      folderItemFile: { file: { key: 'FileAlpha12', name: 'Next page' } },
    });
  });
  const f = directoryFixture(t, { folderItems: items });
  assert.equal(f.read().hasNextPage, true);
  assert.equal(f.read(true).fetching, true);
  assert.equal(calls, 1);
  const end = f.read();
  assert.equal(end.hasNextPage, false);
  assert.equal(end.itemCount, 1);
  f.current.data = { sharedWithYouResourcesV2: pages([]) };
  assert.deepEqual(f.read().files, []);
  assert.equal(f.read().ready, true);
});
test('loading, request failures and changed schemas cannot report a complete directory', (t) => {
  const f = directoryFixture(t, { folderItems: pages([]) });
  f.current.status = 'loading';
  assert.equal(f.read().ready, false);
  f.current.status = 'loaded';
  f.current.errors = [new Error('permission denied')];
  assert.throws(() => f.read(), /request_failed/);
  delete f.current.errors;
  f.current.data = { folderItems: [] };
  assert.throws(() => f.read(), /pagination_schema_changed/);
  f.current.data = { unknown: 42 };
  assert.throws(() => f.read(), /directory_schema_changed/);
  f.current.data = {
    folderItems: pages([
      { folderItemFile: { file: { key: 'bad', name: 'Invalid' } } },
    ]),
  };
  assert.throws(() => f.read(), /file_schema_changed/);
});
test('shared relations, folders and organization teams omit deleted resources', (t) => {
  const f = directoryFixture(t, {
    sharedWithYouResourcesV2: pages([
      { sharedWithYouFile: { file: { key: 'FileAlpha12', name: 'Shared' } } },
      {
        sharedWithYouFile: {
          file: { key: 'FileBravo12', name: 'Deleted', deletedAt: new Date() },
        },
      },
      { sharedWithYouFolder: { folder: { id: '456', path: 'Folder title' } } },
    ]),
  });
  assert.equal(f.read().files.length, 1);
  assert.deepEqual(f.read().folders, [{ id: '456', name: 'Folder title' }]);
  f.current.data = {
    orgJoinedTeams: pages([
      { team: { id: '789' } },
      { team: { id: '900', deletedAt: new Date() } },
    ]),
  };
  assert.deepEqual(f.read().teams, ['789']);
});
test('account changes and abandoned readers release subscriptions before any further metadata is read', (t) => {
  const f = directoryFixture(t, { folderItems: pages([]) });
  f.context.window.INITIAL_OPTIONS.user_data.id = '456';
  assert.throws(() => f.read(), /account_changed/);
  assert.equal(f.cancellations.length, 1);
  const abandoned = directoryFixture(t, { folderItems: pages([]) });
  abandoned.expire();
  assert.throws(() => abandoned.read(), /reader_closed/);
  assert.equal(abandoned.cancellations.length, 1);
});
test('plan discovery uses actual identifiers and rejects incomplete API responses', async (t) => {
  const f = directoryFixture(t, { folderItems: pages([]) });
  assert.deepEqual(JSON.parse(JSON.stringify(await f.reader.plans())), [
    { id: '456', type: 'team', draftFolderId: '789' },
  ]);
  f.context.fetch = async () => ({
    ok: true,
    json: async () => ({ meta: {} }),
  });
  await assert.rejects(f.reader.plans(), /plan_directory_empty/);
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
test('a new refresh clears old coverage and retains files until successful completion', () => {
  const catalog = createCatalog();
  catalog.update({
    status: 'ready',
    accountId: '123',
    files: [file()],
    coverage: [{ route: '/old', complete: true, fileCount: 1 }],
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
  });
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
  const { createBridgeServer } = require('../src/host/bridge-server.cjs'),
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
  const { createBridgeServer } = require('../src/host/bridge-server.cjs');
  const { BRIDGE_RUNTIME_VERSION } = require('../src/shared/core.js');
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
  const { createBridgeServer } = require('../src/host/bridge-server.cjs'),
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

test('large directory results cross the pipe in bounded batches without dropping a final page', (t) => {
  const items = pages(
    Array.from({ length: 1201 }, (_, i) => ({
      folderItemFile: { file: { key: 'FileKey' + i, name: 'File ' + i } },
    })),
  );
  const f = directoryFixture(t, { folderItems: items });
  let offset = 0;
  const keys = new Set(),
    sizes = [];
  do {
    const view = JSON.parse(JSON.stringify(f.reader.read(false, offset)));
    view.files.forEach((file) => keys.add(file.fileKey));
    sizes.push(view.files.length);
    offset = view.nextOffset;
  } while (offset < items.length);
  assert.deepEqual(sizes, [500, 500, 201]);
  assert.equal(keys.size, 1201);
});

test('full account scan follows exact nested folder IDs, preserves recent times and finalizes only after every source', async () => {
  const { syncAccount } = require('../src/host/catalog-sync.cjs');
  const catalog = createCatalog(),
    calls = [];
  let name, args;
  const reader = {
    identity: async () => ({ accountId: '123', accountName: 'Fixture' }),
    plans: async () => [{ id: '789', type: 'team', draftFolderId: '456' }],
    open: async (n, a) => {
      name = n;
      args = a;
      calls.push({ name, args });
    },
    read: async () => {
      let files = [],
        folders = [];
      if (name === 'FileBrowserRecentResourcesGlobalView')
        files = [{ ...file(), lastViewedAt: '2024-01-01T00:00:00Z' }];
      if (
        name === 'FileBrowserFolderPageV2View' &&
        args.compositeParentResourceId === 'folder:456'
      )
        files = [file()];
      if (name === 'FileBrowserTeamPageFolderItemsView')
        folders = [{ id: '999', name: 'Same name' }];
      if (
        name === 'FileBrowserFolderPageChildFoldersView' &&
        args.compositeParentResourceId === 'folder:999'
      )
        folders = [{ id: '1000', name: 'Same name' }];
      if (
        name === 'FileBrowserFolderPageV2View' &&
        args.compositeParentResourceId === 'folder:1000'
      )
        files = [file('FileBravo12')];
      if (
        name === 'SharedWithYouResources' &&
        args.resourceTypes[0] === 'folder'
      )
        folders = [{ id: '999', name: 'Same name' }];
      return {
        accountId: '123',
        ready: true,
        files,
        folders,
        teams: [],
        hasNextPage: false,
        fetching: false,
        itemCount: files.length + folders.length,
        nextOffset: files.length + folders.length,
      };
    },
  };
  const result = await syncAccount(reader, {
    report: async (input) => catalog.update(input),
  });
  assert.equal(result.fileCount, 2);
  assert.equal(catalog.view().status, 'ready');
  assert.equal(catalog.view().files[0].lastViewedAt, '2024-01-01T00:00:00Z');
  assert.equal(
    calls.filter(
      (call) =>
        call.name === 'FileBrowserFolderPageV2View' &&
        call.args.compositeParentResourceId === 'folder:999',
    ).length,
    1,
  );
  assert(
    calls.some((call) => call.args.compositeParentResourceId === 'folder:1000'),
  );
  assert(catalog.view().coverage.every((source) => source.complete));
});

function desktopTargets(accounts, authenticated = accounts.map(() => true)) {
  const attached = new Set();
  let closed = false,
    readers = 0;
  return {
    attached,
    closed: () => closed,
    readers: () => readers,
    async connect() {
      return {
        close() {
          closed = true;
        },
        async call(method, params, sessionId) {
          if (method === 'Target.getTargets')
            return {
              targetInfos: accounts.map((accountId, i) => ({
                targetId: String(i),
                type: 'page',
                title: 'Figma',
                url: i
                  ? 'https://www.figma.com/files/feed'
                  : 'https://www.figma.com/files/team/456/drafts',
              })),
            };
          if (method === 'Target.attachToTarget') {
            attached.add(params.targetId);
            return { sessionId: params.targetId };
          }
          if (method === 'Target.detachFromTarget') {
            attached.delete(params.sessionId);
            return {};
          }
          if (method === 'Runtime.evaluate') {
            if (params.returnByValue)
              return {
                result: {
                  value: {
                    ready: true,
                    accountId: accounts[Number(sessionId)],
                    authenticated: authenticated[Number(sessionId)],
                  },
                },
              };
            readers++;
            return { result: { objectId: sessionId } };
          }
          if (method === 'Runtime.callFunctionOn')
            return {
              result: { value: { accountId: accounts[Number(sessionId)] } },
            };
          if (method === 'Runtime.releaseObject') return {};
          throw new Error('Unexpected CDP call ' + method);
        },
      };
    },
  };
}
test('Desktop Feed and directory renderers of one authenticated account are one source and release all owned sessions', async () => {
  const { desktopReader } = require('../src/host/catalog-sync.cjs');
  const targets = desktopTargets(['123', '123']);
  const reader = await desktopReader({ connect: () => targets.connect() });
  assert.equal((await reader.identity()).accountId, '123');
  assert.equal(targets.readers(), 1);
  assert.equal(targets.attached.size, 1);
  await reader.close();
  assert.equal(targets.attached.size, 0);
  assert(targets.closed());
});
test('different authenticated Desktop accounts are never selected by title or target order', async () => {
  const { desktopReader } = require('../src/host/catalog-sync.cjs');
  const targets = desktopTargets(['123', '789']);
  await assert.rejects(
    desktopReader({ connect: () => targets.connect() }),
    /ambiguous_desktop_account/,
  );
  assert.equal(targets.readers(), 0);
  assert.equal(targets.attached.size, 0);
  assert(targets.closed());
});
test('Desktop directory reads use the authenticated connection instead of a disconnected preload of the same account', async () => {
  const { desktopReader } = require('../src/host/catalog-sync.cjs');
  const targets = desktopTargets(['123', '123'], [false, true]);
  const reader = await desktopReader({ connect: () => targets.connect() });
  assert.equal((await reader.identity()).accountId, '123');
  assert.deepEqual([...targets.attached], ['1']);
  await reader.close();
  assert.equal(targets.attached.size, 0);
  assert(targets.closed());
});
