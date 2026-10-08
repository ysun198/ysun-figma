import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { createCanvasView } from './canvas-view.js';
import { newer } from '../shared/version.js';
const app = new App(
  { name: 'ysun-figma-files', version: APP_VERSION },
  { availableDisplayModes: ['inline', 'fullscreen'] },
);
const $ = (id) => document.getElementById(id);
let files = [],
  fileId,
  initialized = false,
  refreshing = false,
  catalog = { status: 'empty' };
let watchCursor,
  watching = false,
  watchTimer,
  snapshotEpoch = 0;
let replacing = false;
const navigation = globalThis.__ysunFigmaNavigation;
delete globalThis.__ysunFigmaNavigation;
let query = '',
  view = 'cards',
  contextKey,
  contextSending = false;
const canvas = createCanvasView(app, $, () => void syncContext());
const timeFields = ['lastViewedAt', 'updatedAt', 'createdAt'];
let listSort = { field: 'updatedAt', direction: 'desc' };
const scrollPositions = { cards: 0, list: 0 },
  cardCache = new Map();
let noticeTimer,
  noticeKey = '';
try {
  if (localStorage.getItem('ysun-figma-view') === 'list') view = 'list';
} catch {}
try {
  const saved = JSON.parse(localStorage.getItem('ysun-figma-list-sort'));
  if (
    timeFields.includes(saved?.field) &&
    ['asc', 'desc'].includes(saved.direction)
  )
    listSort = saved;
} catch {}
const currentFile = () => files.find((file) => file.id === fileId);
function visibleFiles() {
  const selected = files.filter((file) =>
    file.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  if (view === 'list')
    selected.sort((a, b) => {
      const left = Date.parse(a[listSort.field]),
        right = Date.parse(b[listSort.field]);
      if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
      if (!Number.isFinite(right)) return -1;
      return (left - right) * (listSort.direction === 'asc' ? 1 : -1);
    });
  return selected;
}
function notice(text = '', retry = false) {
  if (replacing) return;
  const key = JSON.stringify([text, retry]);
  if (noticeKey === key) return;
  noticeKey = key;
  clearTimeout(noticeTimer);
  $('notice-text').textContent = text;
  $('retry').hidden = !retry;
  $('notice').hidden = !text;
  if (text) noticeTimer = setTimeout(dismissNotice, 5000);
}
function dismissNotice() {
  clearTimeout(noticeTimer);
  $('notice').hidden = true;
}
async function syncContext() {
  if (
    replacing ||
    !app.getHostCapabilities()?.updateModelContext ||
    contextSending
  )
    return;
  const file = currentFile();
  const context = {
    version: APP_VERSION,
    accountId: catalog.accountId || null,
    fileKey: file?.fileKey || null,
    connected: !!file?.connected,
    clientId: canvas.target?.clientId || file?.clientId || null,
    fileName: file?.name || null,
    pageId: canvas.target?.pageId || null,
    nodeId: null,
    nodeName: null,
    sessions: file?.sessions || [],
    preview: canvas.context,
    catalog,
  };
  // Navigation is exact even while its image loads; panning selects no nodes.
  const key = JSON.stringify(context);
  if (contextKey === key) return;
  contextSending = true;
  let delivered = false;
  try {
    await app.updateModelContext({ structuredContent: context });
    contextKey = key;
    delivered = true;
  } catch (error) {
    notice('文件上下文未送达：' + errorText(error), false);
  } finally {
    contextSending = false;
  }
  // A file may change while the host acknowledges. Failures retry on the next
  // snapshot; successful delivery immediately follows the latest context.
  if (delivered) void syncContext();
}
function applyHostContext(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context?.safeAreaInsets)
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      document.documentElement.style.setProperty(
        '--safe-area-' + edge,
        `${context.safeAreaInsets[edge]}px`,
      );
    }
}
function resultData(result) {
  if (result.isError)
    throw new Error(result.structuredContent?.message || '连接暂时不可用');
  return result.structuredContent;
}
function errorText(error) {
  return /Transport closed|not connected|connection closed/i.test(error.message)
    ? '工具连接已断开'
    : error.message;
}
function timeLabel(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 43200) return `${Math.floor(minutes / 1440)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(time);
}
function card(file) {
  const key = JSON.stringify([file.name, file.thumbnailUrl]);
  const cached = cardCache.get(file.id);
  if (cached?.key === key) {
    updateTimes(cached.times, file);
    return cached.button;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card';
  button.dataset.fileId = file.id;
  button.setAttribute('aria-label', file.name || '未命名');
  button.title = file.name || '未命名';
  const thumbnail = document.createElement('span');
  thumbnail.className = 'thumbnail';
  if (file.thumbnailUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = file.thumbnailUrl;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      const label = document.createElement('span');
      label.textContent = '预览暂不可用';
      thumbnail.replaceChildren(label);
    };
    thumbnail.append(img);
  } else {
    const label = document.createElement('span');
    label.textContent = '暂无封面';
    thumbnail.append(label);
  }
  const caption = document.createElement('span');
  caption.className = 'caption';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = file.name || '未命名';
  const times = Object.fromEntries(
    timeFields.map((field) => {
      const span = document.createElement('span');
      span.className = field;
      return [field, span];
    }),
  );
  updateTimes(times, file);
  caption.append(name, ...Object.values(times));
  button.append(thumbnail, caption);
  button.onclick = () => openFile(file.id);
  cardCache.set(file.id, { key, button, times });
  return button;
}
function updateTimes(times, file) {
  for (const field of timeFields) {
    const label = timeLabel(file[field]);
    times[field].textContent = label || '—';
    times[field].dataset.empty = String(!label);
    times[field].title = label
      ? new Date(file[field]).toLocaleString('zh-CN')
      : '';
  }
}
function draw() {
  const file = currentFile(),
    selected = visibleFiles();
  $('location').hidden = !file;
  $('file-name').textContent = file?.name || '';
  $('search-field').hidden = !!file;
  $('view-switch').hidden = !!file;
  $('workspace').hidden = !!file;
  $('viewer').hidden = !file;
  $('clear-search').hidden = !query;
  $('search').value = query;
  $('gallery').dataset.view = view;
  $('list-header').hidden = view !== 'list';
  $('workspace').dataset.view = view;
  for (const mode of ['cards', 'list'])
    $('view-' + mode).setAttribute('aria-pressed', String(view === mode));
  for (const field of timeFields) {
    const selected = listSort.field === field,
      button = $('sort-' + field);
    button.setAttribute('aria-pressed', String(selected));
    button.dataset.direction = selected ? listSort.direction : '';
    button.title = selected
      ? listSort.direction === 'desc'
        ? '从新到旧，点击反向排序'
        : '从旧到新，点击反向排序'
      : '从新到旧排序';
  }
  canvas.update(file, catalog.accountId);
  if (file) return;
  const gallery = $('gallery'),
    cards = selected.map(card);
  if (
    cards.length !== gallery.children.length ||
    cards.some((card, index) => card !== gallery.children[index])
  ) {
    const focusedFileId = document.activeElement?.dataset.fileId;
    gallery.replaceChildren(...cards);
    if (focusedFileId)
      cards
        .find((card) => card.dataset.fileId === focusedFileId)
        ?.focus({ preventScroll: true });
  }
  $('workspace').scrollTop = query
    ? $('workspace').scrollTop
    : scrollPositions[view];
  $('empty').hidden = !!selected.length;
  $('empty-text').textContent = !initialized
    ? '正在载入…'
    : files.length && query.trim()
      ? '没有匹配的项目'
      : catalog.status === 'syncing'
        ? '正在同步文件…'
        : catalog.status === 'ready'
          ? '暂无文件'
          : catalog.status === 'desktop_restart_required'
            ? '请让 Codex 重新连接 Figma 桌面端'
            : catalog.status === 'desktop_required'
              ? '请让 Codex 安装 Figma 桌面端'
              : catalog.status === 'login_required'
                ? '请在 Figma 桌面端登录'
                : '暂时无法读取文件';
  $('connect').hidden =
    !initialized ||
    files.length > 0 ||
    ['syncing', 'ready'].includes(catalog.status);
}
function openFile(id) {
  const file = files.find((item) => item.id === id);
  if (!file) return;
  fileId = file.id;
  draw();
  void syncContext();
  if (!file.connected) {
    const accountId = catalog.accountId,
      epoch = snapshotEpoch;
    void app
      .callServerTool(
        {
          name: 'figma_file',
          arguments: { action: 'open', fileKey: file.fileKey },
        },
        { timeout: 15000 },
      )
      .then(resultData)
      .then((data) => {
        if (
          fileId === file.id &&
          catalog.accountId === accountId &&
          epoch === snapshotEpoch
        )
          render(data);
      })
      .catch((error) => {
        if (fileId === file.id && catalog.accountId === accountId)
          notice(errorText(error));
      });
  }
}
function render(data, force = false) {
  if (replacing) return;
  if (!Array.isArray(data?.files)) return;
  if (
    data.version &&
    data.version !== APP_VERSION &&
    /^\d+\.\d+\.\d+$/.test(data.version)
  ) {
    if (!newer(data.version, APP_VERSION)) return;
    void replaceWorkbench().catch((error) => {
      replacing = false;
      notice('工作台更新未完成：' + errorText(error), true);
      scheduleWatch(1000);
    });
    return;
  }
  snapshotEpoch++;
  if (typeof data.cursor === 'string') watchCursor = data.cursor;
  const previousStatus = catalog.status;
  const incoming = data.files.map((file) => ({
    ...file,
    id: file.id || file.fileKey,
    name: file.name || '未命名',
    connected: !!file.connected,
  }));
  const unchanged =
    initialized &&
    JSON.stringify(files) === JSON.stringify(incoming) &&
    JSON.stringify(catalog) === JSON.stringify(data.catalog || catalog);
  if (
    catalog.accountId &&
    data.catalog?.accountId &&
    catalog.accountId !== data.catalog.accountId
  ) {
    fileId = undefined;
    scrollPositions.cards = scrollPositions.list = 0;
    cardCache.clear();
  }
  files = incoming;
  catalog = data.catalog || catalog;
  initialized = true;
  if (force) cardCache.clear();
  for (const id of cardCache.keys())
    if (!files.some((file) => file.id === id)) cardCache.delete(id);
  if (fileId && !currentFile()) fileId = undefined;
  if (!unchanged || force) draw();
  void syncContext();
  const incomplete = ['incomplete', 'interrupted'].includes(catalog.status);
  if (incomplete && previousStatus === 'syncing')
    notice('未能更新文件目录', true);
}
async function replaceWorkbench() {
  replacing = true;
  const result = await app.readServerResource({
    uri: 'ui://figma-plugin/files',
  });
  const html = result.contents.find(
    (item) =>
      item.uri === 'ui://figma-plugin/files' && typeof item.text === 'string',
  )?.text;
  if (!html) throw new Error('未收到新版工作台');
  globalThis.__ysunFigmaNavigation = {
    fileId,
    query,
    scrollPositions: { ...scrollPositions },
    canvas: canvas.state,
  };
  clearTimeout(watchTimer);
  clearTimeout(noticeTimer);
  canvas.dispose();
  await app.close();
  document.open();
  document.write(html);
  document.close();
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  const epoch = ++snapshotEpoch;
  try {
    const data = resultData(
      await app.callServerTool(
        { name: 'figma_open', arguments: {} },
        { timeout: 15000 },
      ),
    );
    if (epoch === snapshotEpoch) render(data, force);
  } catch (error) {
    if (!replacing && !initialized) {
      initialized = true;
      draw();
    }
    notice(errorText(error), true);
  } finally {
    refreshing = false;
    scheduleWatch();
  }
}
function scheduleWatch(delay = 0) {
  clearTimeout(watchTimer);
  if (
    !replacing &&
    watchCursor &&
    !watching &&
    !refreshing &&
    document.visibilityState === 'visible'
  )
    watchTimer = setTimeout(() => void watch(), delay);
}
async function watch() {
  if (
    watching ||
    refreshing ||
    !watchCursor ||
    document.visibilityState !== 'visible'
  )
    return;
  watching = true;
  const epoch = snapshotEpoch;
  let failed = false;
  try {
    const data = resultData(
      await app.callServerTool(
        {
          name: 'figma_watch',
          arguments: { cursor: watchCursor, waitMs: 20000 },
        },
        { timeout: 25000 },
      ),
    );
    if (epoch === snapshotEpoch && document.visibilityState === 'visible')
      render(data);
  } catch (error) {
    failed = true;
    if (epoch === snapshotEpoch) notice(errorText(error), true);
  } finally {
    watching = false;
    scheduleWatch(failed ? 1000 : 0);
  }
}
document.addEventListener('visibilitychange', () => scheduleWatch());
$('back').onclick = () => {
  fileId = undefined;
  draw();
  void syncContext();
};
$('search').oninput = () => {
  query = $('search').value;
  $('workspace').scrollTop = 0;
  draw();
};
$('clear-search').onclick = () => {
  query = '';
  draw();
  $('search').focus();
};
for (const mode of ['cards', 'list'])
  $('view-' + mode).onclick = () => {
    if (view === mode) return;
    view = mode;
    if (query) $('workspace').scrollTop = 0;
    try {
      localStorage.setItem('ysun-figma-view', view);
    } catch {}
    draw();
  };
for (const field of timeFields)
  $('sort-' + field).onclick = () => {
    listSort = {
      field,
      direction:
        listSort.field === field && listSort.direction === 'desc'
          ? 'asc'
          : 'desc',
    };
    scrollPositions.list = 0;
    $('workspace').scrollTop = 0;
    try {
      localStorage.setItem('ysun-figma-list-sort', JSON.stringify(listSort));
    } catch {}
    draw();
  };
$('workspace').onscroll = () => {
  if (!query) scrollPositions[view] = $('workspace').scrollTop;
};
$('desktop').onclick = async () => {
  if ($('desktop').disabled) return;
  notice();
  $('desktop').disabled = true;
  try {
    resultData(
      await app.callServerTool(
        {
          name: 'figma_file',
          arguments: {
            action: 'launch',
            ...(currentFile()?.fileKey
              ? { fileKey: currentFile().fileKey }
              : {}),
          },
        },
        { timeout: 15000 },
      ),
    );
  } catch (error) {
    notice(errorText(error), false);
  } finally {
    if (!replacing) $('desktop').disabled = false;
  }
};
$('retry').onclick = async () => {
  if ($('retry').disabled) return;
  notice();
  $('retry').disabled = $('connect').disabled = true;
  try {
    resultData(
      await app.callServerTool({
        name: 'figma_file',
        arguments: { action: 'sync' },
      }),
    );
    await refresh(true);
  } catch (error) {
    notice(errorText(error), true);
  } finally {
    if (!replacing) $('retry').disabled = $('connect').disabled = false;
  }
};
$('connect').onclick = () => $('retry').onclick();
$('dismiss-notice').onclick = dismissNotice;
app.ontoolresult = (result) => {
  try {
    render(resultData(result));
  } catch (error) {
    notice(error.message, true);
  }
};
app.ontoolcancelled = () => notice('已取消', true);
app.addEventListener('hostcontextchanged', applyHostContext);
void (async () => {
  try {
    if (navigation) {
      fileId = navigation.fileId;
      query = navigation.query;
      $('search').value = query;
      Object.assign(scrollPositions, navigation.scrollPositions);
      canvas.navigate(navigation.canvas);
    }
    await app.connect();
    applyHostContext(app.getHostContext());
    if (!initialized || !watchCursor) await refresh();
    scheduleWatch();
  } catch (error) {
    notice(`无法打开文件界面：${error.message}`, true);
  }
})();
