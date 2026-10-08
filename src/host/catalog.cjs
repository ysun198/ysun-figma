const fs = require('node:fs');
const { writePrivateJson } = require('./state.cjs');
const { parseFigmaUrl } = require('./targets.cjs');
const keyPattern = /^[A-Za-z0-9]{6,100}$/;
const timestamp = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;
function normalizeFile(file) {
  if (
    !file ||
    !keyPattern.test(file.fileKey || '') ||
    typeof file.name !== 'string' ||
    !file.name.trim() ||
    file.name.length > 1000
  )
    throw new Error('invalid catalog file');
  const url = file.url || `https://www.figma.com/design/${file.fileKey}`;
  if (parseFigmaUrl(url).fileKey !== file.fileKey)
    throw new Error('catalog URL does not match its file key');
  let thumbnailUrl;
  if (file.thumbnailUrl) {
    const thumbnail = new URL(file.thumbnailUrl);
    if (
      thumbnail.protocol !== 'https:' ||
      thumbnail.hostname !== 's3-alpha.figma.com' ||
      thumbnail.port ||
      thumbnail.username ||
      thumbnail.password ||
      !thumbnail.pathname.startsWith('/thumbnails/')
    )
      throw new Error('unsupported file cover URL');
    thumbnailUrl = thumbnail.href;
  }
  return {
    fileKey: file.fileKey,
    name: file.name,
    url,
    editorType:
      typeof file.editorType === 'string' ? file.editorType : 'design',
    thumbnailUrl,
    updatedAt: timestamp(file.updatedAt),
    createdAt: timestamp(file.createdAt),
    lastViewedAt: timestamp(file.lastViewedAt),
    folderId: /^\d+$/.test(file.folderId || '') ? file.folderId : '',
    teamId: /^\d+$/.test(file.teamId || '') ? file.teamId : '',
  };
}
function createCatalog(filename) {
  let state = {
    schemaVersion: 1,
    accountId: null,
    accountName: '',
    files: [],
    bindings: [],
    coverage: [],
    status: 'empty',
    syncedAt: null,
    lastAttemptAt: null,
    error: null,
  };
  if (filename && fs.existsSync(filename)) {
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (
      saved.schemaVersion !== 1 ||
      !Array.isArray(saved.files) ||
      !Array.isArray(saved.bindings)
    )
      throw new Error('unsupported account catalog');
    for (const key of Object.keys(state))
      if (Object.hasOwn(saved, key)) state[key] = saved[key];
    state.files = saved.files.map(normalizeFile);
    if (state.status === 'syncing') state.status = 'interrupted';
  }
  function save() {
    if (!filename) return;
    writePrivateJson(filename, state);
  }
  function view() {
    return JSON.parse(JSON.stringify(state));
  }
  function update(input) {
    const statuses = [
      'syncing',
      'ready',
      'incomplete',
      'login_required',
      'desktop_required',
      'desktop_restart_required',
      'interrupted',
    ];
    if (!statuses.includes(input.status))
      throw new Error('invalid catalog status');
    let next = { ...state };
    if (input.accountId !== undefined) {
      if (!/^\d+$/.test(input.accountId || ''))
        throw new Error('invalid account identity');
      if (next.accountId !== input.accountId)
        next = {
          ...next,
          accountId: input.accountId,
          accountName: '',
          files: [],
          bindings: [],
          coverage: [],
          syncedAt: null,
        };
    }
    if (input.files !== undefined) {
      if (!Array.isArray(input.files) || input.files.length > 100000)
        throw new Error('invalid account file list');
      const files = input.files.map(normalizeFile);
      // Partial syncs merge; only a verified complete crawl removes stale entries.
      const merged = new Map(
        (input.status === 'ready' ? [] : next.files).map((file) => [
          file.fileKey,
          file,
        ]),
      );
      for (const file of files) merged.set(file.fileKey, file);
      next.files = [...merged.values()];
      if (input.status === 'ready')
        next.bindings = next.bindings.filter((binding) =>
          merged.has(binding.fileKey),
        );
    }
    if (input.fileKeys !== undefined) {
      if (
        input.status !== 'ready' ||
        !Array.isArray(input.fileKeys) ||
        input.fileKeys.length > 100000 ||
        input.fileKeys.some((key) => !keyPattern.test(key))
      )
        throw new Error('invalid completed catalog keys');
      const keys = new Set(input.fileKeys),
        known = new Set(next.files.map((file) => file.fileKey));
      if ([...keys].some((key) => !known.has(key)))
        throw new Error('completed catalog includes missing file metadata');
      next.files = next.files.filter((file) => keys.has(file.fileKey));
      next.bindings = next.bindings.filter((binding) =>
        keys.has(binding.fileKey),
      );
    }
    next.status = input.status;
    if (input.status === 'syncing' && state.status !== 'syncing') {
      next.lastAttemptAt = new Date().toISOString();
      next.coverage = [];
    }
    if (typeof input.accountName === 'string')
      next.accountName = input.accountName.slice(0, 1000);
    if (Array.isArray(input.coverage))
      next.coverage = input.coverage.map((source) => ({
        route: String(source.route || '').slice(0, 2000),
        complete: source.complete === true,
        fileCount: Number(source.fileCount) || 0,
      }));
    next.error =
      typeof input.error === 'string' ? input.error.slice(0, 300) : null;
    if (input.status === 'ready') next.syncedAt = new Date().toISOString();
    const previous = state;
    state = next;
    try {
      save();
    } catch (error) {
      state = previous;
      throw error;
    }
    return view();
  }
  function bind(input, clients) {
    if (parseFigmaUrl(input.verifiedUrl).fileKey !== input.fileKey)
      throw new Error('verifiedUrl must identify the exact requested fileKey.');
    const client = clients.find(
      (client) => client.connected && client.id === input.clientId,
    );
    if (!client)
      throw new Error(
        'The exact clientId is disconnected; run the plugin and read figma_status again.',
      );
    if (
      !/^[a-f0-9]{32}$/.test(input.documentId || '') ||
      client.documentId !== input.documentId
    )
      throw new Error(
        'documentId does not match the exact live client; use the value from figma_status.',
      );
    if (!/^[a-f0-9]{32}$/.test(client.instanceId || ''))
      throw new Error(
        'The live plugin has no instance identity; reopen it and read figma_status again.',
      );
    if (client.fileKey && client.fileKey !== input.fileKey)
      throw new Error(
        'The live client belongs to another fileKey; verify its actual Figma URL.',
      );
    const known = state.files.find((file) => file.fileKey === input.fileKey);
    const file =
      known ||
      normalizeFile({
        fileKey: input.fileKey,
        name: client.fileName,
        url: input.verifiedUrl,
        editorType: client.editorType,
      });
    const previous = state;
    state = {
      ...state,
      files: known ? state.files : [...state.files, file],
      bindings: [
        ...state.bindings.filter(
          (binding) =>
            binding.fileKey !== file.fileKey && binding.clientId !== client.id,
        ),
        {
          fileKey: file.fileKey,
          clientId: client.id,
          documentId: client.documentId,
          instanceId: client.instanceId,
        },
      ],
    };
    try {
      save();
    } catch (error) {
      state = previous;
      throw error;
    }
    return view();
  }
  function decorate(clients) {
    return clients.map((client) => {
      const binding = state.bindings.find(
        (binding) =>
          binding.clientId === client.id &&
          binding.documentId === client.documentId &&
          binding.instanceId &&
          binding.instanceId === client.instanceId,
      );
      return binding && (!client.fileKey || client.fileKey === binding.fileKey)
        ? { ...client, fileKey: binding.fileKey }
        : client;
    });
  }
  return { view, update, bind, decorate };
}
module.exports = { createCatalog, normalizeFile };
