const { connectDesktop } = require('./desktop.cjs');
const { bridgeRequest, readConnection } = require('./bridge-client.cjs');
const { createAccountReader } = require('./account-reader.js');
const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
async function desktopReader({ connect = connectDesktop } = {}) {
  const connection = await connect();
  const sessions = new Set();
  let sessionId, objectId;
  const detach = async (id) => {
    await connection.call('Target.detachFromTarget', { sessionId: id });
    sessions.delete(id);
  };
  const close = async () => {
    try {
      if (objectId) {
        await connection.call(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: 'function(){this.close()}',
            returnByValue: true,
          },
          sessionId,
        );
        await connection.call('Runtime.releaseObject', { objectId }, sessionId);
      }
    } catch {
    } finally {
      for (const id of sessions) await detach(id).catch(() => {});
      connection.close();
    }
  };
  const value = (result) => {
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description
          ?.split('\n')[0]
          .replace(/^Error: /, '') || 'account_directory_unavailable',
      );
    return result.result;
  };
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const { targetInfos } = await connection.call('Target.getTargets');
      const homes = targetInfos.filter((t) => {
        if (t.type !== 'page') return false;
        try {
          const url = new URL(t.url);
          return (
            ['figma.com', 'www.figma.com'].includes(url.hostname) &&
            /^\/(files|login|signup)(\/|$)/.test(url.pathname)
          );
        } catch {
          return false;
        }
      });
      const available = [];
      let loginCount = 0;
      for (const home of homes) {
        const { sessionId: id } = await connection.call(
          'Target.attachToTarget',
          {
            targetId: home.targetId,
            flatten: true,
          },
        );
        sessions.add(id);
        const state = value(
          await connection.call(
            'Runtime.evaluate',
            {
              expression:
                '({login:/\\/(login|signup)(\\/|$)/.test(location.pathname),ready:!!window.LIVEGRAPH?.client,accountId:window.INITIAL_OPTIONS?.user_data?.id,authenticated:window.LIVEGRAPH?.client?.connection?.isAuthenticated?.() === true})',
              returnByValue: true,
            },
            id,
          ),
        ).value;
        if (state.login) loginCount++;
        if (state.ready && state.accountId)
          available.push({
            id,
            accountId: String(state.accountId),
            authenticated: state.authenticated,
          });
        else await detach(id);
      }
      if (new Set(available.map((home) => home.accountId)).size > 1)
        throw new Error('ambiguous_desktop_account');
      const connected = available.find((home) => home.authenticated);
      if (connected) {
        // Desktop can preload Feed and file-browser pages for the same account.
        // Their authenticated identity, rather than their title, defines one source.
        sessionId = connected.id;
        for (const home of available)
          if (home.id !== sessionId) await detach(home.id);
        break;
      }
      for (const home of available) await detach(home.id);
      if (homes.length && loginCount === homes.length)
        throw new Error('login_required');
      await pause();
    }
    if (!sessionId) throw new Error('account_directory_unavailable');
    objectId = value(
      await connection.call(
        'Runtime.evaluate',
        {
          expression: '(' + createAccountReader.toString() + ')()',
          returnByValue: false,
        },
        sessionId,
      ),
    ).objectId;
    if (!objectId) throw new Error('account_directory_unavailable');
    const invoke = async (method, ...args) =>
      value(
        await connection.call(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration:
              'function(method,args){return this[method](...args)}',
            arguments: [{ value: method }, { value: args }],
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId,
        ),
      ).value;
    return {
      identity: () => invoke('identity'),
      plans: () => invoke('plans'),
      open: (...args) => invoke('open', ...args),
      read: (next, offset) => invoke('read', next, offset),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
async function syncAccount(reader, { report } = {}) {
  const coverage = [],
    all = new Map(),
    visited = new Set();
  const identity = await reader.identity();
  await report({ status: 'syncing', ...identity });
  const paging = {
    firstPageSize: 25,
    sortOrder: 'DESC',
    sortColumn: 'touchedAt',
  };
  async function crawl(name, args) {
    await reader.open(name, args);
    const deadline = () => Date.now() + 45000;
    let until = deadline(),
      previousCount = -1,
      offset = 0;
    const folders = new Set(),
      teams = new Set(),
      local = new Map();
    while (true) {
      const view = await reader.read(false, offset);
      if (view.accountId !== identity.accountId)
        throw new Error('account_changed');
      if (
        !view.ready ||
        view.fetching ||
        (view.hasNextPage && view.itemCount <= previousCount)
      ) {
        if (Date.now() >= until) throw new Error('account_directory_timeout');
        await pause();
        continue;
      }
      for (const file of view.files) {
        const merged = {
          ...file,
          lastViewedAt:
            file.lastViewedAt || all.get(file.fileKey)?.lastViewedAt || null,
        };
        all.set(file.fileKey, merged);
        local.set(file.fileKey, merged);
      }
      for (const folder of view.folders) folders.add(folder.id);
      for (const team of view.teams) teams.add(team);
      offset = view.nextOffset;
      if (offset < view.itemCount) continue;
      if (!view.hasNextPage) break;
      previousCount = view.itemCount;
      await reader.read(true, offset);
      until = deadline();
    }
    coverage.push({
      route:
        name +
        ':' +
        (args.compositeParentResourceId ||
          args.orgId ||
          args.resourceTypes.join(',')),
      complete: true,
      fileCount: local.size,
    });
    const batch = [...local.values()];
    for (let offset = 0; offset < batch.length; offset += 500)
      await report({
        status: 'syncing',
        ...identity,
        files: batch.slice(offset, offset + 500),
      });
    await report({ status: 'syncing', ...identity, coverage });
    return { folders, teams };
  }
  async function folder(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const args = { ...paging, compositeParentResourceId: 'folder:' + id };
    await crawl('FileBrowserFolderPageV2View', {
      ...args,
      resourceType: 'file',
    });
    const children = await crawl('FileBrowserFolderPageChildFoldersView', args);
    for (const child of children.folders) await folder(child);
  }
  async function team(id) {
    const result = await crawl('FileBrowserTeamPageFolderItemsView', {
      ...paging,
      compositeParentResourceId: 'team:' + id,
      resourceType: 'folder',
    });
    for (const id of result.folders) await folder(id);
  }
  await crawl('FileBrowserRecentResourcesGlobalView', {
    firstPageSize: 25,
    resourceTypes: ['file', 'repo', 'prototype'],
  });
  const plans = await reader.plans();
  for (const plan of plans) {
    if (!/^\d+$/.test(plan.id))
      throw new Error('plan_directory_schema_changed');
    if (plan.draftFolderId) {
      if (!/^\d+$/.test(plan.draftFolderId))
        throw new Error('plan_directory_schema_changed');
      await folder(plan.draftFolderId);
    }
    if (plan.type === 'team') await team(plan.id);
    else if (plan.type === 'org') {
      const teams = new Set();
      for (const name of [
        'FileBrowserOrgPageAllTeamsView',
        'FileBrowserOrgPageJoinedTeamsView',
      ]) {
        const result = await crawl(name, { orgId: plan.id, firstPageSize: 25 });
        result.teams.forEach((id) => teams.add(id));
      }
      for (const id of teams) await team(id);
    } else throw new Error('plan_directory_schema_changed');
  }
  const shared = {
    firstPageSize: 25,
    sortOrder: 'desc',
    cursorColumn: 'shared_at',
    sharedBy: null,
    planId: null,
    planType: null,
    fileType: null,
    orgDeletedDrafts: null,
    sharedToFilter: null,
    sharedToUserGroupIdFilter: [],
  };
  await crawl('SharedWithYouResources', {
    ...shared,
    resourceTypes: ['file', 'file_repo', 'prototype'],
  });
  const folders = await crawl('SharedWithYouResources', {
    ...shared,
    resourceTypes: ['folder'],
  });
  for (const id of folders.folders) await folder(id);
  // Validate that the same desktop account supplied the entire scan.
  if ((await reader.identity()).accountId !== identity.accountId)
    throw new Error('account_changed');
  await report({
    status: 'ready',
    ...identity,
    fileKeys: [...all.keys()],
    coverage,
    error: null,
  });
  return { ok: true, fileCount: all.size, sources: coverage.length };
}
async function run() {
  const connection = readConnection();
  const report = (input) =>
    bridgeRequest(connection, '/v1/catalog', {
      method: 'POST',
      body: JSON.stringify(input),
      timeoutMs: 30000,
    });
  let reader;
  const stop = () => {
    reader?.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    reader = await desktopReader();
    await syncAccount(reader, { report });
  } catch (error) {
    const status = [
      'login_required',
      'desktop_required',
      'desktop_restart_required',
    ].includes(error.message)
      ? error.message
      : 'incomplete';
    await report({
      status,
      error: String(error.message || error)
        .replace(/https?:\/\/\S+/g, '[url]')
        .slice(0, 300),
    }).catch(() => {});
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await reader?.close();
  }
}
if (require.main === module)
  run().catch(() => {
    process.exitCode = 1;
  });
module.exports = { desktopReader, syncAccount };
