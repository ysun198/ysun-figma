#!/usr/bin/env node
// Small stdio MCP server: newline JSON-RPC, no external runtime dependencies.
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureCompanion } = require('./companion.cjs');
const { bridgeStateDirectory } = require('./state.cjs');
const { bridgeRequest } = require('./bridge-client.cjs');
const { readAPIReference } = require('./api-reference.cjs');
const {
  uploadAssets,
  saveExports,
  readExport,
} = require('./artifact-client.cjs');
const terminal = new Set(['succeeded', 'failed', 'outcome_unknown']);
const { resolveTarget, parseFigmaUrl } = require('./targets.cjs');
const version = require('../../package.json').version;
const { queries, tools, validate, toolError } = require('./mcp-contract.cjs');
const images = Symbol('inline MCP image content');
async function withPreviews(connection, record, signal, explicit = false) {
  if (record.job.status !== 'succeeded') return record;
  explicit ||=
    !!record.job.result?.value?.preview ||
    record.job.result?.value?.format === 'PNG';
  const previews = (record.job.result?.exports || []).filter(
    (file) =>
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        file.mimeType,
      ) &&
      (explicit || file.name.startsWith('preview-')),
  );
  record[images] = [];
  for (const preview of previews.slice(0, 2)) {
    if (preview.size > 2 * 1024 * 1024) {
      record.previewHint =
        'Save the original export with figma_export, or request a smaller preview.';
      continue;
    }
    record[images].push({
      type: 'image',
      data: (
        await readExport(connection, record.job.id, preview, signal)
      ).toString('base64'),
      mimeType: preview.mimeType,
    });
  }
  return record;
}
async function deliverResult(
  connection,
  record,
  { signal, outputDirectory, includePreviews = true, explicit = false } = {},
) {
  try {
    if (outputDirectory)
      record.exportedFiles = await saveExports(
        connection,
        record.job,
        outputDirectory,
        signal,
      );
    return includePreviews
      ? await withPreviews(connection, record, signal, explicit)
      : record;
  } catch (error) {
    if (error.exportedFiles) record.exportedFiles = error.exportedFiles;
    error.phase = 'delivery';
    error.receipt = record;
    throw error;
  }
}
function compactSuccess(record) {
  if (record.job.status !== 'succeeded') return record;
  const { id, status, target, result } = record.job;
  const details = { ...result };
  for (const key of ['operationId', 'editorType', 'apiVersion', 'elapsedMs'])
    delete details[key];
  if (!details.logs?.length) delete details.logs;
  if (
    !details.logLimits?.droppedEntries &&
    !details.logLimits?.truncatedMessages
  )
    delete details.logLimits;
  if (!details.exports?.length) delete details.exports;
  return {
    ...record,
    job: { id, status, target, result: details },
  };
}
async function callRest(name, input, { connection, request, signal }) {
  const rest = require('./rest.cjs');
  rest.prepare(input);
  const result = await request('/v1/rest', {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: 125000,
  }).catch((error) => {
    if (error.body?.code === 'CLOUD_RECEIPT_UNAVAILABLE') {
      error.phase = 'receipt';
      error.operationId = input.operationId;
    }
    throw error;
  });
  if (['failed', 'outcome_unknown'].includes(result.job?.status))
    throw Object.assign(
      new Error(result.job.error || 'Figma REST request failed'),
      {
        code:
          result.job.status === 'outcome_unknown'
            ? 'REST_OUTCOME_UNKNOWN'
            : 'REST_REQUEST_FAILED',
        phase: 'execution',
        receipt: result,
      },
    );
  return compactSuccess(
    await deliverResult(connection, result, {
      signal,
      outputDirectory: input.outputDirectory,
    }),
  );
}

async function callCommunity(name, input, { connection, request, signal }) {
  const result = await request('/v1/community', {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: 45000,
  });
  if (result.image) {
    result[images] = [
      {
        type: 'image',
        data: result.image.data,
        mimeType: result.image.mimeType,
      },
    ];
    delete result.image;
  }
  return result;
}

async function callStatus(name, input, { connection, request, signal }) {
  return {
    updates: require('./updates.cjs').updateStatus(version),
    ...(await request(
      '/v1/status?' + new URLSearchParams({ summary: '1', ...input }),
    )),
    skillRootPath: path.join(
      bridgeStateDirectory(),
      'companion/current/skills',
    ),
    apiReferencePath: path.join(
      bridgeStateDirectory(),
      'companion/current/skills/ysun-figma/references/plugin-api.d.ts',
    ),
  };
}

async function callConnect(name, input, { connection, request, signal }) {
  const state = await request('/v1/status?summary=1');
  const files = state.clients;
  const manifestPath = path.join(
    bridgeStateDirectory(),
    'plugin/manifest.json',
  );
  if (input.manualPairing)
    return {
      state: 'pairing_required',
      manifestPath,
      ...(await request('/v1/pairings', { method: 'POST', body: '{}' })),
      next: 'Manual fallback only after the direct Desktop lifecycle is diagnosed as unavailable. Import this stable manifest only if absent, run its Connect command and enter this one-time code using available app automation. Verify the exact file/client with figma_status. Ordinary setup uses figma_file(action="open" or "connect", fileKey=...) without a connection code.',
    };
  if (files.length && !input.newFile)
    return {
      state: files.some((file) => !file.needsPluginUpdate)
        ? 'connected'
        : 'connection_required',
      manifestPath,
      files,
      next: 'Reuse the exact intended file/client, without a new pairing. If needsPluginUpdate, finish or reconcile its original operations, then use figma_file(action="connect", fileKey=...) to verify and recover its actual native instance. Dev/Widget profile changes can replace the previous iframe; read the returned client identity again before submitting work. For an additional existing file, use figma_file(action="open", fileKey=...).',
    };
  return {
    state: 'connection_required',
    manifestPath,
    files,
    next: 'Use the requested Figma URL/fileKey with figma_file(action="open", fileKey=...), or inspect actual open editors with figma_file(action="status") and connect the intended exact file. Direct connection handles saved authorization and owned-frame pairing without GUI or a code. Only desktop_plugin_not_imported requires a one-time import of this stable manifest using app automation; retry the same direct connection afterward. This preparation does not create a Figma file. See the packaged ysun-figma-setup skill for missing Node/Desktop, sign-in or safe Desktop restart.',
  };
}

async function callReconcile(name, input, { connection, request, signal }) {
  return request(`/v1/jobs/${input.operationId}/reconcile`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

async function callReceipt(name, input, { connection, request, signal }) {
  let phase = 'receipt',
    submittedId = input.operationId;
  try {
    phase = 'receipt';
    submittedId = input.operationId;
    const record = await request(
      `/v1/jobs/${input.operationId}?wait=${input.waitMs || 0}`,
    );
    return await deliverResult(connection, record, {
      signal,
      outputDirectory: input.outputDirectory,
      includePreviews: name === 'figma_job' && input.includePreviews !== false,
    });
  } catch (error) {
    error.phase ||= phase;
    error.operationId ||= submittedId;
    throw error;
  }
}

function validateTargetOptions(name, input) {
  if (
    (name !== 'figma_navigate' &&
      [input.nodeId, input.nodeIds, input.pageId].filter(Boolean).length > 1) ||
    (input.rootId && (input.pageId || input.nodeId)) ||
    (input.nodeId && input.parentId) ||
    (input.scope === 'file' && (input.rootId || input.pageId || input.nodeId))
  )
    throw new Error('choose one node/root targeting option');
}
function validateAssetInput(input) {
  const count = Object.keys(input.assetPaths).length;
  if (!count || count > 20) throw new Error('Choose 1–20 assetPaths');
  const target =
    input.nodeId || (input.figmaUrl && parseFigmaUrl(input.figmaUrl).nodeId);
  if (input.fillIndex !== undefined && (!target || input.replaceAllFills))
    throw new Error(
      'fillIndex requires a target and cannot be combined with replaceAllFills',
    );
  if (
    target &&
    ['x', 'y', 'width', 'height'].some((key) => input[key] !== undefined)
  )
    throw new Error(
      'An image-fill replacement preserves node position and size; omit x, y, width and height',
    );
}
function validateToolInput(name, input) {
  if (
    name === 'figma_file' &&
    input.action === 'status' &&
    ['clientId', 'documentId', 'verifiedUrl'].some(
      (key) => input[key] !== undefined,
    )
  )
    throw new Error('Desktop file status accepts only an optional fileKey');
  validateTargetOptions(name, input);
  if (name === 'figma_upload_assets') validateAssetInput(input);
  if (
    name === 'figma_status' &&
    input.scope === 'all' &&
    (input.clientId || input.fileKey)
  )
    throw new Error('choose all history or one connected file');
  if (name === 'figma_community')
    require('./community.cjs').validateResearch(input);
}
function nativeTarget(name, input, state) {
  const selected = resolveTarget(input, state.clients);
  if (
    state.clients.find((client) => client.id === selected.clientId)
      ?.needsPluginUpdate
  )
    throw new Error(
      'The native plugin is outdated; reconnect it before submitting an operation',
    );
  if (
    selected.nodeId &&
    (name === 'figma_navigate'
      ? input.nodeIds
      : input.pageId || input.rootId || input.nodeIds || input.scope === 'file')
  )
    throw new Error('choose one node/root targeting option');
  return selected;
}
function nativeJob(name, input, selected, assets) {
  const query = queries[name];
  const source = query
    ? query === 'snapshot'
      ? 'return await bridge.observe(args);'
      : `return await bridge.query('${query}', args);`
    : input.source;
  const {
    clientId,
    fileKey,
    fileName,
    figmaUrl,
    operationId,
    waitMs,
    assetPaths,
    outputDirectory,
    ...queryArgs
  } = input;
  const readOnly =
    (!!query && name !== 'figma_upload_assets') ||
    (name === 'figma_run' && input.readOnly === true);
  return {
    readOnly,
    body: {
      kind: 'exec',
      operationId: ['figma_run', 'figma_navigate'].includes(name)
        ? input.operationId
        : readOnly
          ? crypto.randomUUID()
          : input.operationId,
      target: selected.target,
      source,
      assets,
      args: query
        ? {
            ...queryArgs,
            assetNames: Object.keys(assets),
            nodeId: selected.nodeId,
            rootId:
              input.rootId ||
              ([
                'figma_find_nodes',
                'figma_components',
                'figma_design_system',
              ].includes(name)
                ? selected.nodeId
                : undefined),
          }
        : input.args,
      options: {
        readOnly,
        commitUndo: !readOnly && input.commitUndo !== false,
        ...(name === 'figma_snapshot' ? { snapshot: true } : {}),
        ...(input.ifUnchanged ? { ifUnchanged: input.ifUnchanged } : {}),
        ...(name === 'figma_run' && input.rootId
          ? { rootId: input.rootId }
          : {}),
      },
    },
  };
}

async function callNative(name, input, { connection, request, signal }) {
  let phase = 'preflight',
    receipt,
    submittedId;
  try {
    signal?.throwIfAborted();
    // The health check already read this status; submit rechecks exact identity.
    const selected = nativeTarget(name, input, connection.status);
    const assets = await uploadAssets(connection, input.assetPaths, signal);
    // Asset bytes are content-addressed; the same request keeps its digest
    // across upload retries. The operation id is recorded before submission.
    const { readOnly, body } = nativeJob(name, input, selected, assets);
    signal?.throwIfAborted();
    phase = 'submitted';
    submittedId = body.operationId;
    const { job } = await request('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    }).catch((error) => {
      if (error.statusCode) error.phase = 'preflight';
      throw error;
    });
    const waitMs = input.waitMs ?? 20000;
    receipt = { job };
    const result =
      waitMs && !terminal.has(job.status)
        ? await request(`/v1/jobs/${job.id}?wait=${waitMs}`, {
            timeoutMs: waitMs + 2000,
          })
        : { job };
    receipt = result;
    result.targeting = { ...selected.targeting, ...result.job.target };
    if (['failed', 'outcome_unknown'].includes(result.job.status)) {
      phase = result.job.result?.precondition ? 'precondition' : 'execution';
      const error = new Error(
        (result.job.status === 'outcome_unknown' ? 'outcome_unknown: ' : '') +
          (result.job.error || 'Figma operation failed'),
      );
      error.receipt = result;
      throw error;
    }
    result.safeToRetryWithoutCanvasRead =
      readOnly || result.job.status === 'failed';
    return compactSuccess(
      await deliverResult(connection, result, {
        signal,
        outputDirectory: input.outputDirectory,
        explicit: ['figma_screenshot', 'figma_design_context'].includes(name),
      }),
    );
  } catch (error) {
    error.phase ||= phase;
    error.toolName ||= name;
    error.operationId ||= submittedId;
    if (receipt) error.receipt ||= receipt;
    throw error;
  }
}

function restMetadata(input) {
  const rest = require('./rest.cjs');
  if (input.action === 'list')
    return rest.list({
      query: input.search,
      offset: input.offset,
      limit: input.limit,
    });
  if (input.action === 'describe') return rest.describe(input.endpoint);
  if (input.action === 'auth_status')
    return rest.authStatus(input.credentialProfile);
  if (input.action === 'configure') return rest.configure(input);
}

const connectedTools = {
  figma_rest: callRest,
  figma_community: callCommunity,
  figma_status: callStatus,
  figma_connect: callConnect,
  figma_reconcile: callReconcile,
  figma_job: callReceipt,
  figma_export: callReceipt,
  figma_file: (_name, input, context) =>
    require('./file-tools.cjs').callFile(input, context),
};
async function callTool(name, input, signal) {
  try {
    const definition = tools.find((tool) => tool.name === name);
    if (!definition)
      throw Object.assign(new Error('unknown tool'), { code: -32602 });
    validate(input, definition.inputSchema);
    if (name === 'figma_api') {
      const tool = tools.find((entry) => entry.name === input.query?.trim());
      return { version, ...readAPIReference(input), ...(tool ? { tool } : {}) };
    }
    if (name === 'figma_rest' && input.action !== 'request')
      return restMetadata(input);
    validateToolInput(name, input);
    const connection = await ensureCompanion();
    const request = (route, options) =>
      bridgeRequest(connection, route, { ...options, signal });
    const launchDesktop = (fileKey) =>
      request('/v1/desktop', {
        method: 'POST',
        body: JSON.stringify({ fileKey }),
      });
    return await (connectedTools[name] || callNative)(name, input, {
      connection,
      request,
      launchDesktop,
      signal,
    });
  } catch (error) {
    error.phase ||= 'preflight';
    error.toolName ||= name;
    throw error;
  }
}

const { serve } = require('./mcp-transport.cjs');

module.exports = {
  tools,
  callTool,
  serve,
  validate,
  toolError,
  version,
  images,
};
if (require.main === module) serve();
