// The evaluate/wait callbacks execute in the authenticated Figma Home page.
/* global document, location, NodeFilter */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { bridgeStateDirectory } = require('./state.cjs');
const { bridgeRequest, readConnection } = require('./bridge-client.cjs');
const { readAccountView } = require('./account-reader.js');
const root = path.join(__dirname, '../..');
async function syncAccount(
  taskSpace,
  {
    existingSpace = process.env.YSUN_FIGMA_BROWSER_SPACE,
    report = (input) =>
      bridgeRequest(readConnection(), '/v1/catalog', {
        method: 'POST',
        body: JSON.stringify(input),
        timeoutMs: 30000,
      }),
  } = {},
) {
  const task = await taskSpace(
    existingSpace ? Number(existingSpace) : 'ysun figma account sync',
  );
  const page = task.page('p1');
  let spaceActive = true;
  await report({ status: 'syncing', browserSpace: task.spaceId });
  const all = new Map(),
    coverage = [],
    visited = new Set();
  let identity;
  const read = (source, loadNext = false) =>
    page.evaluate(readAccountView, { source, loadNext });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
  async function settled(source, previousCount) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const view = await read(source);
      if (
        view.accountId &&
        view.ready &&
        !view.fetching &&
        (previousCount === undefined ||
          !view.hasNextPage ||
          view.itemCount > previousCount)
      )
        return view;
      if (
        !view.accountId &&
        /login|signup/.test(new URL(await page.url()).pathname)
      )
        throw new Error('login_required');
      await pause();
    }
    throw new Error('file_browser_not_ready');
  }
  async function crawl(source) {
    const url = new URL(await page.url());
    source = { ...source, route: url.pathname + url.search };
    let view = await settled(source);
    const folders = new Map(),
      local = new Map();
    for (;;) {
      if (view.accountId !== identity.accountId) {
        identity = { accountId: view.accountId, accountName: view.accountName };
        all.clear();
        coverage.length = 0;
        await report({ status: 'syncing', ...identity, files: [], coverage });
        throw new Error('account_changed');
      }
      for (const file of view.files) {
        // Folder/shared views may omit the recent-view relation already read from Recents.
        const merged = {
          ...file,
          lastViewedAt:
            file.lastViewedAt || all.get(file.fileKey)?.lastViewedAt || null,
        };
        all.set(file.fileKey, merged);
        local.set(file.fileKey, merged);
      }
      for (const folder of view.folders) folders.set(folder.id, folder);
      if (!view.hasNextPage) break;
      const previousCount = view.itemCount;
      await read(source, true);
      view = await settled(source, previousCount);
    }
    const route = view.route;
    coverage.push({ route, complete: true, fileCount: local.size });
    const batch = [...local.values()];
    for (let offset = 0; offset < batch.length; offset += 500)
      await report({
        status: 'syncing',
        ...identity,
        files: batch.slice(offset, offset + 500),
      });
    await report({ status: 'syncing', ...identity, coverage });
    for (const folder of folders.values()) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      await page.goto('https://www.figma.com' + route, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await settled(source);
      const parentId = await page.evaluate((name) => {
        const matches = [
          ...document.querySelectorAll('[data-card-main-action]'),
        ].filter(
          (el) =>
            el.parentElement
              .querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')
              ?.textContent.trim() === name,
        );
        return matches.length === 1
          ? matches[0].getAttribute('data-items-view-parent-id')
          : null;
      }, folder.name);
      if (!parentId) throw new Error('folder_navigation_changed');
      // The preview contains separate Create anchors. Activate the actual folder
      // button by keyboard so its center never opens one of those anchors.
      await page.press(
        '[data-card-main-action][data-items-view-parent-id=' +
          JSON.stringify(parentId) +
          ']',
        'Enter',
      );
      await page.waitForFunction(
        (previous) => location.pathname + location.search !== previous,
        route,
      );
      if (!new URL(await page.url()).pathname.split('/').includes(folder.id))
        throw new Error('folder_identity_mismatch');
      await crawl({ kind: 'folder', folderId: folder.id });
    }
  }
  try {
    await page.goto('https://www.figma.com/files', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    let view = await settled();
    identity = { accountId: view.accountId, accountName: view.accountName };
    await report({ status: 'syncing', ...identity });
    // Read the same plan directory used by Figma Home, within its own origin.
    const plans = await page.evaluate(async () => {
      const r = await fetch('/api/user/plans', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error('plan_directory_unavailable');
      const value = await r.json();
      return (value.meta?.plans || []).map((p) => ({
        name: p.plan_name,
        drafts: p.has_drafts,
      }));
    });
    if (!plans.length) throw new Error('plan_directory_empty');
    if (new Set(plans.map((plan) => plan.name)).size !== plans.length)
      throw new Error('ambiguous_plan_directory');
    await page.waitForSelector('button[aria-label^="Plan:"]', {
      state: 'visible',
      timeout: 45000,
    });
    for (const plan of plans) {
      // Select every account plan using the actual menu instead of inventing
      // org/team routing variants. Directory subscriptions can be ready before
      // the sidebar; select the menu's radio item, never its obscured trigger.
      await page.click('button[aria-label^="Plan:"]');
      const matches = await page.evaluate(
        (name) =>
          [
            ...document.querySelectorAll(
              '[role="menu"] [role="menuitemradio"]',
            ),
          ].flatMap((el, index) => {
            const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            while (text.nextNode())
              if (text.currentNode.textContent.trim() === name) return [index];
            return [];
          }),
        plan.name,
      );
      if (matches.length !== 1) throw new Error('plan_navigation_changed');
      await page.click(
        '[role="menu"] [role="menuitemradio"] >> nth=' + matches[0],
      );
      await page.waitForFunction(
        (name) =>
          document
            .querySelector('button[aria-label^="Plan:"]')
            ?.getAttribute('aria-label') ===
          'Plan: ' + name,
        plan.name,
      );
      for (const name of [...(plan.drafts ? ['Drafts'] : []), 'All folders']) {
        const before = (await read()).route;
        await page.click('loc=role:button[name=' + JSON.stringify(name) + ']');
        if (!before.includes(name === 'Drafts' ? '/drafts' : '/all-folders'))
          await page.waitForFunction(
            (previous) => location.pathname + location.search !== previous,
            before,
          );
        await crawl({ kind: name === 'Drafts' ? 'drafts' : 'folders' });
      }
    }
    await page.click('loc=role:button[name="Recents"]');
    await page.waitForFunction(() =>
      location.pathname.includes('/recents-and-sharing'),
    );
    await page.waitForSelector('[role="tab"]', {
      state: 'visible',
      timeout: 45000,
    });
    const tabCount = await page.evaluate(
      () => document.querySelectorAll('[role="tab"]').length,
    );
    if (tabCount !== 3) throw new Error('sharing_directory_unavailable');
    for (let index = 0; index < tabCount; index++) {
      const before = await page.evaluate(
        (index) => ({
          route: location.pathname + location.search,
          selected:
            document
              .querySelectorAll('[role="tab"]')
              .item(index)
              ?.getAttribute('aria-selected') === 'true',
        }),
        index,
      );
      await page.click('[role="tab"] >> nth=' + index);
      await page.waitForFunction(
        ({ index, before }) =>
          document
            .querySelectorAll('[role="tab"]')
            .item(index)
            ?.getAttribute('aria-selected') === 'true' &&
          (before.selected ||
            location.pathname + location.search !== before.route),
        { index, before },
      );
      await crawl({
        kind: ['recent', 'shared_files', 'shared_folders'][index],
      });
    }
    await task.finish({ keep: [] });
    spaceActive = false;
    await report({
      status: 'ready',
      ...identity,
      fileKeys: [...all.keys()],
      coverage,
      error: null,
      browserSpace: null,
    });
    return { ok: true, fileCount: all.size, sources: coverage.length };
  } catch (error) {
    const code =
      error.message === 'login_required' ? 'login_required' : 'incomplete';
    const diagnostic = String(error.message || error)
      .replace(/https?:\/\/\S+/g, '[url]')
      .slice(0, 300);
    const browserSpace = spaceActive ? task.spaceId : null;
    await report({
      status: code,
      ...(identity || {}),
      coverage,
      error: diagnostic,
      browserSpace,
    });
    // Keep the same space for agent-managed login/recovery. Never create another
    // browser to evade an interrupted or blocked session.
    return { ok: false, state: code, browserSpace, diagnostic };
  }
}

function browserProgram() {
  // Run the same module that is reviewed and tested; the browser only needs a
  // small ESM entry point, not a second implementation hidden in a string.
  return `
const { createRequire } = await import('node:module');
const require = createRequire(${JSON.stringify(__filename)});
process.env.FIGMA_PLUGIN_STATE_DIR = ${JSON.stringify(bridgeStateDirectory())};
const result = await require('./catalog-sync.cjs').syncAccount(taskSpace);
console.log(JSON.stringify(result));
`;
}
async function run() {
  const connection = readConnection();
  try {
    await bridgeRequest(connection, '/v1/catalog', {
      method: 'POST',
      body: JSON.stringify({ status: 'syncing' }),
    });
    const standard = path.join(os.homedir(), '.local/bin/ego-browser');
    const child = spawn(
      fs.existsSync(standard) ? standard : 'ego-browser',
      ['nodejs'],
      { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stop = () => {
      child.kill('SIGTERM');
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    let output = '';
    child.stdout.on('data', (data) => {
      if (output.length < 20000) output += data;
    });
    child.stderr.on('data', (data) => {
      if (output.length < 20000) output += data;
    });
    child.stdin.end(browserProgram());
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
    if (code !== 0) throw new Error('browser worker exited with code ' + code);
    if (require.main === module && process.env.YSUN_FIGMA_BROWSER_SPACE)
      process.stdout.write(output);
  } catch (error) {
    await bridgeRequest(connection, '/v1/catalog', {
      method: 'POST',
      body: JSON.stringify({
        status: error.code === 'ENOENT' ? 'browser_required' : 'incomplete',
        error: String(error.message || error)
          .replace(/https?:\/\/\S+/g, '[url]')
          .slice(0, 300),
      }),
    }).catch(() => {});
  }
}
if (require.main === module)
  run().catch(() => {
    process.exitCode = 1;
  });
module.exports = { browserProgram, syncAccount };
