const byId = (id) => document.getElementById(id);
const relayOrigin = 'http://localhost:38491';
const newClientId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
const direct = {
  instanceId: newClientId(),
  token: '',
  grantToken: '',
  context: null,
  clientId: newClientId(),
  pending: null,
  enabled: false,
  running: false,
  heartbeat: null,
  blockedJobId: null,
  closed: false,
  heartbeatBusy: false,
  heartbeatAgain: false,
  epoch: 0,
  pollController: null,
  recovering: null,
  expiresAt: 0,
};
const post = (message) => parent.postMessage({ pluginMessage: message }, '*');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function status(message, tone = 'neutral') {
  byId('status').textContent = message;
  byId('status').dataset.tone = tone;
}
function busy(value) {
  byId('close').disabled = value || !!direct.pending;
  byId('disconnect').disabled = value || !!direct.pending;
}
function updateContext(value) {
  if (!value) return;
  const fields = [
    'fileName',
    'fileKey',
    'editorType',
    'pageName',
    'pageId',
    'selection',
    'pluginId',
    'documentId',
    'runtimeVersion',
    'protocolVersion',
    'nativeBuild',
    'documentRevision',
  ];
  direct.context = {
    ...direct.context,
    ...Object.fromEntries(
      fields
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, value[key]]),
    ),
  };
  byId('target-file').textContent = direct.context.fileName;
  byId('target-page').textContent =
    `${direct.context.pageName} · 已选 ${(direct.context.selection || []).length} 项`;
}
async function rawRequest(
  path,
  body,
  authenticated = true,
  timeout = 35000,
  method,
  binary = false,
) {
  const controller = new AbortController();
  if (path.includes('/jobs/next')) direct.pollController = controller;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(relayOrigin + path, {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      keepalive: path.endsWith('/suspend'),
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${direct.token}` } : {}),
        ...(body !== undefined
          ? {
              'Content-Type': binary
                ? 'application/octet-stream'
                : 'application/json',
            }
          : {}),
      },
      ...(body !== undefined
        ? { body: binary ? body : JSON.stringify(body) }
        : {}),
    }).catch((error) => {
      error.transportFailure = true;
      throw error;
    });
    if (response.status === 204) return null;
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error || `HTTP ${response.status}`), {
        statusCode: response.status,
      });
    return value;
  } finally {
    clearTimeout(timer);
    if (direct.pollController === controller) direct.pollController = null;
  }
}
function recoveryState(reply) {
  const recovery = reply.recovery;
  if (
    !recovery ||
    !Array.isArray(recovery.active) ||
    !Array.isArray(recovery.unresolved)
  )
    throw new Error('Relay recovery information is unavailable.');
  const active = recovery.active.filter(
    (id) => !direct.pending || id !== direct.pending.id,
  );
  direct.blockedJobId = recovery.unresolved[0] || active[0] || null;
  if (active.length)
    throw new Error(
      `Operation ${active[0]} is still running. Waiting for its original outcome; it will not be repeated.`,
    );
}
function readyStatus() {
  if (direct.blockedJobId)
    status(
      `上次操作需要 Codex 核对：${direct.blockedJobId}。仍可以读取设计。`,
      'error',
    );
  else
    status(
      `已连接「${direct.context.fileName}」，可以回到 Codex 使用。`,
      'success',
    );
}

async function restoreConnection() {
  if (direct.recovering) return direct.recovering;
  direct.recovering = (async () => {
    if (!direct.grantToken || !direct.context)
      throw new Error('Enter a pairing code to authorize this file.');
    const reply = await rawRequest(
      '/v1/resume',
      {
        clientId: direct.clientId,
        grantToken: direct.grantToken,
        ...direct.context,
        instanceId: direct.instanceId,
      },
      false,
      5000,
    );
    if (reply.protocolVersion !== direct.context.protocolVersion)
      throw new Error(
        'Companion version mismatch. Update the companion and reopen the plugin.',
      );
    direct.token = reply.token;
    direct.expiresAt = reply.expiresAt;
    recoveryState(reply);
    return reply;
  })();
  try {
    return await direct.recovering;
  } finally {
    direct.recovering = null;
  }
}
async function restoreOnOpen() {
  const deadline = Date.now() + 50000;
  while (!direct.closed) {
    try {
      return await restoreConnection();
    } catch (error) {
      // Figma's force-close can omit beforeunload. Wait for the old presence
      // lease rather than asking for a code or taking over a live instance.
      if (
        error.statusCode !== 409 ||
        !/already connected in another/.test(error.message) ||
        Date.now() >= deadline
      )
        throw error;
      status('正在恢复连接…');
      await delay(1000);
    }
  }
  throw new Error('Connection recovery stopped.');
}
async function request(...args) {
  const previousToken = direct.token;
  try {
    return await rawRequest(...args);
  } catch (error) {
    if (error.statusCode !== 401 || args[2] === false || !direct.grantToken)
      throw error;
    if (direct.token === previousToken) await restoreConnection();
    return rawRequest(...args);
  }
}
const transient = (error) =>
  error.transportFailure === true ||
  error.statusCode === 429 ||
  error.statusCode >= 500;
const retryDelay = (attempt) =>
  Math.min(10000, 500 * 2 ** Math.min(attempt, 5));
async function retryTransport(operation, allowed = () => !direct.closed) {
  let attempt = 0;
  while (allowed()) {
    try {
      return await operation();
    } catch (error) {
      if (!transient(error)) throw error;
      status('正在恢复连接…');
      await delay(retryDelay(attempt++));
    }
  }
  throw new Error('Connection recovery stopped.');
}
async function pollNext(epoch) {
  let attempt = 0;
  while (direct.enabled && !direct.closed && epoch === direct.epoch) {
    try {
      return await request(
        `/v1/jobs/next?clientId=${encodeURIComponent(direct.clientId)}&wait=25000`,
      );
    } catch (error) {
      if (epoch !== direct.epoch || !direct.enabled || direct.closed)
        return null;
      if (!transient(error)) throw error;
      status('正在恢复连接并核对上次操作…');
      await delay(retryDelay(attempt++));
      if (epoch !== direct.epoch || !direct.enabled || direct.closed)
        return null;
      recoveryState(
        await retryTransport(
          () => request('/v1/clients/heartbeat', direct.context, true, 5000),
          () => direct.enabled && !direct.closed && epoch === direct.epoch,
        ),
      );
    }
  }
  return null;
}
async function heartbeat() {
  if (direct.closed || !direct.token) return;
  if (direct.heartbeatBusy) {
    direct.heartbeatAgain = true;
    return;
  }
  direct.heartbeatBusy = true;
  post({ type: 'GET_CONTEXT' });
  try {
    if (direct.grantToken && direct.expiresAt - Date.now() < 30 * 60 * 1000)
      await restoreConnection();
    const reply = await request(
      '/v1/clients/heartbeat',
      direct.context,
      true,
      5000,
    );
    if (!direct.pending) {
      const previous = direct.blockedJobId;
      recoveryState(reply);
      if (previous !== direct.blockedJobId) readyStatus();
    }
    if (!direct.enabled && !direct.pending) {
      startPolling();
      connected();
    }
  } catch (error) {
    if (transient(error)) status('等待 Codex 恢复连接…');
    else pause(connectionError(error));
  } finally {
    direct.heartbeatBusy = false;
    if (direct.heartbeatAgain) {
      direct.heartbeatAgain = false;
      void heartbeat();
    }
  }
}
function pause(message) {
  direct.enabled = false;
  status(message, 'error');
  busy(false);
  post({ type: 'SHOW_UI' });
  byId('resume').hidden = !direct.token || !!direct.pending;
  byId('retry-receipt').hidden = !direct.pending || !direct.pending.message;
  byId('pair-form').hidden = !!direct.blockedJobId;
  byId('disconnect').hidden = !direct.token && !direct.grantToken;
}
function connectionError(error) {
  const message = String(error.message || error);
  if (/invalid or expired pairing code/.test(message))
    return '连接码已失效，请让 Codex 获取新码后重试。';
  if (/revoked or expired|pair again/.test(message))
    return '授权已失效，请回到 Codex 重新连接。';
  if (/already connected in another/.test(message))
    return '这个文件已在另一个插件窗口连接，可以关闭当前窗口。';
  if (/version mismatch|update the plugin|outdated/.test(message))
    return '插件已更新，请让 Codex 重新打开此插件。';
  if (transient(error)) return '等待 Codex 恢复连接…';
  return message;
}
function startPolling() {
  direct.enabled = true;
  direct.epoch++;
  if (direct.pollController) direct.pollController.abort();
  byId('resume').hidden = true;
  if (!direct.running && !direct.pending) void run();
}
function connected() {
  clearInterval(direct.heartbeat);
  direct.heartbeat = setInterval(() => {
    void heartbeat();
  }, 15000);
  byId('pair-form').hidden = true;
  byId('disconnect').hidden = false;
  post({ type: 'HIDE_UI' });
  readyStatus();
}
async function deliverReceipt() {
  const pending = direct.pending;
  if (!pending || !pending.message || pending.sending) return;
  pending.sending = true;
  try {
    const message = pending.message;
    const result = message.result;
    if (result && Array.isArray(result.exports)) {
      for (let i = 0; i < result.exports.length; i++) {
        const file = result.exports[i];
        const saved = await retryTransport(
          () =>
            request(
              `/v1/jobs/${encodeURIComponent(pending.id)}/exports/${encodeURIComponent(file.name)}`,
              file.bytes,
              true,
              120000,
              'POST',
              true,
            ),
          () => direct.pending === pending && !direct.closed,
        );
        result.exports[i] = { ...saved, mimeType: file.mimeType };
      }
    }
    await retryTransport(
      () =>
        request(`/v1/jobs/${encodeURIComponent(pending.id)}/result`, {
          clientId: direct.clientId,
          ok: message.type === 'APPLIED',
          outcomeUnknown: message.outcomeUnknown === true,
          context: message.context,
          result,
          error: message.type === 'ERROR' ? message.message : undefined,
        }),
      () => direct.pending === pending && !direct.closed,
    );
    clearTimeout(pending.timer);
    direct.pending = null;
    pending.resolve();
    post({ type: 'RECEIPT_DELIVERED', requestId: pending.id });
    busy(false);
    byId('retry-receipt').hidden = true;
    if (message.outcomeUnknown) {
      direct.blockedJobId = pending.id;
      status(
        `${message.message}\n请让 Codex 核对上次操作：${pending.id}。仍可以读取设计。`,
        'error',
      );
    } else if (!direct.enabled) {
      status('结果已发送，可以恢复连接。', 'success');
      byId('resume').hidden = false;
    } else readyStatus();
  } catch (error) {
    pending.sending = false;
    pause(`Result retained for ${pending.id}. ${error.message}`);
    pending.reject(error);
  }
}
function execute(job) {
  return new Promise((resolve, reject) => {
    const pending = {
      id: job.id,
      resolve,
      reject,
      message: null,
      sending: false,
    };
    direct.pending = pending;
    busy(true);
    pending.timer = setTimeout(
      () => {
        if (direct.pending !== pending || pending.message) return;
        pause(
          `Still waiting for ${job.id}. Inspect its outcome; it will not be repeated.`,
        );
        reject(new Error('Figma execution deadline exceeded'));
      },
      10 * 60 * 1000,
    );
    const launch = () => {
      if (direct.pending !== pending || pending.message || direct.closed)
        return;
      post({
        type: 'RUN_JOB',
        requestId: job.id,
        kind: job.kind,
        options: job.options,
        source: job.source,
        args: job.args,
        assets: job.assets,
      });
    };
    if (Object.keys(job.assets || {}).length) {
      void loadAssets(job).then(launch, (error) => {
        // A claimed job owns the Close guard during asset transfer as well.
        // No native code has run, so its failed receipt is safe to retain/retry.
        pending.message = {
          type: 'ERROR',
          requestId: job.id,
          message: error.message,
        };
        void deliverReceipt();
      });
    } else launch();
  });
}
async function loadAssets(job) {
  for (const name of Object.keys(job.assets || {})) {
    const response = await fetch(
      `${relayOrigin}/v1/jobs/${encodeURIComponent(job.id)}/assets/${encodeURIComponent(name)}`,
      {
        headers: { Authorization: `Bearer ${direct.token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Could not load asset ${name}; the job was not executed.`,
      );
    job.assets[name] = new Uint8Array(await response.arrayBuffer());
  }
}
async function run() {
  if (direct.running || direct.pending) return;
  direct.running = true;
  direct.enabled = true;
  const epoch = direct.epoch;
  try {
    while (direct.enabled && !direct.closed && epoch === direct.epoch) {
      const payload = await pollNext(epoch);
      if (!payload) continue;
      // A claimed job remains this instance's responsibility even if its poll was cancelled.
      if (direct.closed) break;
      status('Codex 正在处理设计…');
      await execute(payload.job);
      busy(false);
    }
  } catch (error) {
    pause(connectionError(error));
  } finally {
    direct.running = false;
    if (
      direct.enabled &&
      epoch !== direct.epoch &&
      !direct.pending &&
      !direct.closed
    )
      void run();
  }
}
async function pair() {
  const code = byId('pair-code').value.trim();
  if (!code || !direct.context || direct.pending) return;
  byId('pair').disabled = true;
  try {
    const documentId = direct.context.documentId || newClientId();
    const reply = await rawRequest(
      '/v1/pair',
      {
        code,
        clientId: direct.clientId,
        ...direct.context,
        documentId,
        instanceId: direct.instanceId,
      },
      false,
    );
    if (reply.protocolVersion !== direct.context.protocolVersion)
      throw new Error('Companion version mismatch.');
    direct.token = reply.token;
    direct.grantToken = reply.grantToken;
    direct.expiresAt = reply.expiresAt;
    direct.context.documentId = documentId;
    post({
      type: 'SAVE_CONNECTION',
      documentId,
      connection: { clientId: direct.clientId, grantToken: direct.grantToken },
    });
    byId('pair-code').value = '';
    recoveryState(reply);
    connected();
    startPolling();
  } catch (error) {
    pause(connectionError(error));
  } finally {
    byId('pair').disabled = false;
  }
}
byId('pair').addEventListener('click', pair);
byId('pair-code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void pair();
  }
});
byId('resume').addEventListener('click', async () => {
  try {
    recoveryState(await request('/v1/clients/heartbeat', direct.context));
    startPolling();
    connected();
  } catch (error) {
    pause(connectionError(error));
  }
});
byId('retry-receipt').addEventListener('click', () => {
  void deliverReceipt();
});
function closePlugin() {
  if (direct.pending) return;
  if (direct.token)
    void rawRequest('/v1/clients/suspend', {}, true, 2000).catch(() => {});
  direct.closed = true;
  direct.enabled = false;
  clearInterval(direct.heartbeat);
  if (direct.pollController) direct.pollController.abort();
  post({ type: 'CLOSE' });
}
byId('close').addEventListener('click', closePlugin);
byId('disconnect').addEventListener('click', async () => {
  if (direct.pending || !direct.token) return;
  try {
    await request(
      `/v1/clients/${encodeURIComponent(direct.clientId)}`,
      undefined,
      true,
      5000,
      'DELETE',
    );
    post({ type: 'CLEAR_CONNECTION' });
    direct.grantToken = '';
    closePlugin();
  } catch (error) {
    pause(`Could not revoke authorization: ${error.message}`);
  }
});
function trustedHostMessage(event) {
  if (event.source === parent) return true;
  if (!['https://www.figma.com', 'https://figma.com'].includes(event.origin))
    return false;
  let ancestor = parent;
  for (let depth = 0; depth < 3; depth++) {
    if (event.source === ancestor) return true;
    const next = ancestor.parent;
    if (!next || next === ancestor) break;
    ancestor = next;
  }
  return false;
}
onmessage = (event) => {
  if (!trustedHostMessage(event)) return;
  const message = event.data && event.data.pluginMessage;
  if (!message) return;
  if (message.type === 'READY') {
    updateContext(message);
    if (message.connection && message.connection.grantToken) {
      direct.clientId = message.connection.clientId;
      direct.grantToken = message.connection.grantToken;
      status('正在恢复连接…');
      byId('pair-form').hidden = true;
      clearInterval(direct.heartbeat);
      direct.heartbeat = setInterval(() => {
        void heartbeat();
      }, 15000);
      void retryTransport(restoreOnOpen)
        .then(() => {
          connected();
          startPolling();
        })
        .catch((error) => pause(connectionError(error)));
    } else {
      status('等待 Codex 连接此文件。');
      post({ type: 'SHOW_UI' });
    }
  }
  if (message.type === 'CONTEXT') {
    const previous = JSON.stringify(direct.context);
    updateContext(message);
    if (previous !== JSON.stringify(direct.context)) void heartbeat();
  }
  if (message.type === 'STORAGE_ERROR') {
    status('已连接，但授权未能保存。下次打开时由 Codex 重新连接。');
    post({ type: 'SHOW_UI' });
  }
  if (message.type === 'APPLYING') {
    busy(true);
    status('Codex 正在处理设计…');
  }
  if (message.type === 'APPLIED' || message.type === 'ERROR') {
    updateContext(message.context);
    if (direct.pending && message.requestId === direct.pending.id) {
      direct.pending.message = message;
      clearTimeout(direct.pending.timer);
      void deliverReceipt();
    }
  }
};
addEventListener('beforeunload', () => {
  if (direct.token && !direct.closed)
    void rawRequest('/v1/clients/suspend', {}, true, 2000).catch(() => {});
  direct.closed = true;
  direct.enabled = false;
  clearInterval(direct.heartbeat);
});
post({ type: 'UI_READY' });
