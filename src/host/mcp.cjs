#!/usr/bin/env node
// Small stdio MCP server: newline JSON-RPC, no external runtime dependencies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureCompanion } = require('./companion.cjs');
const { bridgeStateDirectory } = require('./state.cjs');
const { bridgeRequest } = require('./bridge-client.cjs');
const {
  uploadAssets,
  saveExports,
  readExport,
} = require('./artifact-client.cjs');
const terminal = new Set(['succeeded', 'failed', 'outcome_unknown']);
const {
  resolveTarget,
  parseFigmaUrl,
  matchingClients,
} = require('./targets.cjs');
const app = require('./app.cjs');
const version = require('../../package.json').version;
const object = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$' };
const fileKey = { type: 'string', pattern: '^[A-Za-z0-9]{6,100}$' };
const target = {
  clientId: id,
  fileKey,
  fileName: { type: 'string', minLength: 1, maxLength: 1000 },
  figmaUrl: { type: 'string', minLength: 1, maxLength: 3000 },
};
const operation = { operationId: id };
const nodeId = {
  type: 'string',
  pattern: '^(?:I)?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$',
};
const integer = (minimum, maximum, value) => ({
  type: 'integer',
  minimum,
  maximum,
  default: value,
});
const scope = { type: 'string', enum: ['page', 'file'], default: 'page' };
const cursor = { type: 'string', minLength: 1, maxLength: 1048576 };
const svgOptions = {
  svgIdAttribute: { type: 'boolean' },
  svgOutlineText: { type: 'boolean' },
};
const search = {
  ...target,
  rootId: nodeId,
  pageId: nodeId,
  query: { type: 'string', maxLength: 200 },
  scope,
  cursor,
  limit: integer(1, 500, 100),
  maxVisited: integer(1, 20000, 5000),
};
const queries = {
  figma_canvas: 'canvas',
  figma_inspect: 'inspect',
  figma_design_context: 'context',
  figma_screenshot: 'screenshot',
  figma_variables: 'variables',
  figma_components: 'components',
  figma_find_nodes: 'findNodes',
  figma_export_node: 'exportNode',
  figma_capabilities: 'capabilities',
  figma_design_system: 'designSystem',
  figma_download_assets: 'downloadAssets',
  figma_upload_assets: 'importAssets',
  figma_motion: 'motion',
};
const images = Symbol('inline MCP image content');
// Results retain extensible native receipts; schemas describe the stable
// envelopes rather than pretending arbitrary returned scripts are statically typed.
const resultSchema = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true,
});
const fileListSchema = resultSchema({
  files: {
    type: 'array',
    items: resultSchema({
      id: { type: 'string' },
      fileKey,
      name: { type: 'string' },
    }),
  },
  catalog: { type: 'object' },
  cursor: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
});
const outputSchemas = {
  figma_open: fileListSchema,
  figma_watch: fileListSchema,
  figma_status: resultSchema({
    clients: { type: 'array', items: { type: 'object' } },
    version: { type: 'string' },
    jobCount: { type: 'integer' },
  }),
  figma_connect: resultSchema({
    state: { type: 'string', enum: ['connected', 'pairing_required'] },
    manifestPath: { type: 'string' },
  }),
  figma_file: {
    type: 'object',
    anyOf: [
      fileListSchema,
      resultSchema({
        state: { type: 'string', enum: ['opened', 'connection_required'] },
      }),
    ],
  },
};
const receiptSchema = resultSchema({
  job: resultSchema({
    id,
    status: {
      type: 'string',
      enum: ['queued', 'running', 'succeeded', 'failed', 'outcome_unknown'],
    },
  }),
});
function toolError(error, input = {}) {
  const detail = String(error.message || error);
  const code =
    error.phase === 'delivery'
      ? 'ARTIFACT_DELIVERY_FAILED'
      : error.code === 'FILE_AMBIGUOUS'
        ? error.code
        : error.receipt?.job.status === 'outcome_unknown'
          ? 'OUTCOME_NEEDS_REVIEW'
          : error.receipt?.job.status === 'failed'
            ? 'FIGMA_OPERATION_FAILED'
            : /No matching connected|no matching connected|open the plugin and pair/.test(
                  detail,
                )
              ? 'FIGMA_NOT_CONNECTED'
              : /Several Figma|multiple matching/.test(detail)
                ? 'FILE_AMBIGUOUS'
                : /outcome_unknown|uncertain|reconcil/i.test(detail)
                  ? 'OUTCOME_NEEDS_REVIEW'
                  : /outdated|version mismatch|update the plugin/i.test(detail)
                    ? 'PLUGIN_UPDATE_REQUIRED'
                    : /ECONN|fetch failed|timeout|not running|could not start|Port 38491/i.test(
                          detail,
                        )
                      ? 'CONNECTION_UNAVAILABLE'
                      : 'FIGMA_OPERATION_FAILED';
  const messages = {
    FIGMA_NOT_CONNECTED: '目标 Figma 文件尚未连接。',
    FILE_AMBIGUOUS: '存在多个可能的 Figma 实例，需要明确目标文件和客户端。',
    OUTCOME_NEEDS_REVIEW: '上次操作的结果尚未确认，需要先核对设计。',
    PLUGIN_UPDATE_REQUIRED: 'Figma 中的 ysun figma 需要更新并重新打开。',
    CONNECTION_UNAVAILABLE: '连接暂时不可用，可以重试或让 Codex 恢复连接。',
    FIGMA_OPERATION_FAILED: '操作未完成，请查看原始错误和执行回执。',
    ARTIFACT_DELIVERY_FAILED: '预览或文件交付失败，原始 Figma 执行回执已保留。',
  };
  const blockingOperationIds = error.body?.blockingOperationIds;
  const operationId =
    error.receipt?.job.id ||
    blockingOperationIds?.[0] ||
    error.operationId ||
    input.operationId;
  const submitted =
    error.phase !== 'preflight' &&
    (['submitted', 'execution', 'delivery', 'receipt'].includes(error.phase) ||
      !!error.receipt ||
      code === 'OUTCOME_NEEDS_REVIEW');
  // Rejection of this request does not resolve an older uncertain write. Derive
  // retry guidance once, so a preflight branch cannot override the ledger.
  const safeToRetryWithoutCanvasRead =
    blockingOperationIds || code === 'OUTCOME_NEEDS_REVIEW'
      ? false
      : error.receipt
        ? error.receipt.job.status === 'failed'
        : !submitted && operationId
          ? true
          : undefined;
  return {
    code,
    message:
      error.phase === 'preflight' && !blockingOperationIds
        ? '请求未提交到 Figma，请根据具体错误修正后继续。'
        : messages[code],
    error: detail,
    ...(error.phase ? { phase: error.phase } : {}),
    ...(error.clients || error.body?.clients
      ? { clients: error.clients || error.body.clients }
      : {}),
    ...(error.body?.expected && error.body?.actual
      ? {
          targetChange: {
            expected: error.body.expected,
            actual: error.body.actual,
          },
        }
      : {}),
    ...(blockingOperationIds ? { blockingOperationIds } : {}),
    ...(error.receipt
      ? { receipt: error.receipt, nativeStatus: error.receipt.job.status }
      : {}),
    ...(safeToRetryWithoutCanvasRead !== undefined
      ? { safeToRetryWithoutCanvasRead }
      : {}),
    ...(operationId
      ? {
          operationId,
          next: blockingOperationIds
            ? 'This request was not submitted. Inspect each blocking operation ID and reconcile its actual outcome before another write.'
            : error.phase === 'delivery'
              ? 'Read figma_job with includePreviews=false for this original operation ID, or retry figma_export to an empty directory. Do not rerun the native script.'
              : submitted
                ? 'Inspect this original operation ID before retrying.'
                : 'No native job was submitted. Correct the request before retrying.',
        }
      : {}),
  };
}
const tools = [
  [
    'figma_open',
    'Open the account file browser and design preview inside Codex. Automatically refreshes the authenticated account directory in the background. Catalog files remain visible while disconnected. Read and edit through local native tools without official remote MCP usage quotas.',
    object(),
    true,
  ],
  [
    'figma_watch',
    'Wait for actual workbench connection, catalog or native revision changes. App-only; preserves the same file identities and snapshot cursor without polling or submitting a native operation.',
    object(
      {
        cursor: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        waitMs: integer(0, 25000, 20000),
      },
      ['cursor'],
    ),
    true,
  ],
  [
    'figma_status',
    'Read connected files, page/selection and their unresolved operations. Filter by exact clientId/fileKey. Global counts always remain visible; scope=all includes disconnected historical unresolved jobs. Read an original receipt with figma_job, never discard history to clear a blocker.',
    object({
      clientId: id,
      fileKey,
      scope: {
        type: 'string',
        enum: ['connected', 'all'],
        default: 'connected',
      },
    }),
    true,
  ],
  [
    'figma_connect',
    'Prepare the stable native plugin for agent-managed first connection or recovery. Reuse a connected file by default; newFile=true prepares a code for another file. Reopen the plugin to restore saved authorization before requesting a new code.',
    object({ newFile: { type: 'boolean', default: false } }),
    false,
  ],
  [
    'figma_file',
    'Manage the account directory and Figma Desktop. launch always brings Figma Desktop forward, optionally at an exact fileKey, without pairing or changing the document. sync refreshes account files through the logged-in Figma browser without official MCP quotas. open accepts an exact fileKey from Figma, including a newly created file not yet in the directory; it reuses its connection or opens it for agent-managed native connection; bind only after verifying the actual file URL and current native instance. Never bind by title or present incomplete pagination as the whole account.',
    object(
      {
        action: { type: 'string', enum: ['sync', 'open', 'bind', 'launch'] },
        fileKey,
        clientId: id,
        documentId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
        verifiedUrl: { type: 'string', minLength: 1, maxLength: 3000 },
      },
      ['action'],
    ),
    false,
  ],
  [
    'figma_inspect',
    'Read page roots, page names and selection, or lightweight identities, dimensions and parents for nodeId/nodeIds (up to 20). No vector paths, CSS or screenshots. pageId reads another page without activating it. Available during uncertain-write recovery.',
    object({
      ...target,
      pageId: nodeId,
      nodeId,
      nodeIds: {
        type: 'array',
        items: nodeId,
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      },
    }),
    true,
  ],
  [
    'figma_canvas',
    'Read the selected native page and render it through Figma exportAsync for the local workbench. Preserves the active page, selection and viewport. Requires an exact connected native file; no website login or remote MCP.',
    object(
      {
        clientId: id,
        fileKey,
        pageId: nodeId,
        maxDimension: integer(256, 4096, 2048),
      },
      ['clientId', 'fileKey'],
    ),
    true,
  ],
  [
    'figma_design_context',
    'Read native layout, paints, text runs, CSS, resolved variable/style references, image hashes, FigJam shape/connector relationships and correct component property owners. CSS defaults on in Design; request it explicitly in other editors. Includes a screenshot for a single exportable root by default. Sparse/truncated output must be drilled into before implementation. Returns authoritative data for the project stack; does not claim generated code or hosted Code Connect.',
    object({
      ...target,
      nodeId,
      nodeIds: {
        type: 'array',
        items: nodeId,
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      },
      pageId: nodeId,
      depth: integer(0, 6, 3),
      maxNodes: integer(1, 1000, 200),
      includeCSS: { type: 'boolean' },
      resolveReferences: { type: 'boolean', default: true },
      includeScreenshot: { type: 'boolean', default: true },
      maxDimension: integer(64, 4096, 1600),
    }),
    true,
  ],
  [
    'figma_screenshot',
    'Render one node or a single selection as PNG and return an inline image when <=2 MiB. Does not change selection or viewport. Larger previews remain available with figma_export. Figma and the plugin must be running.',
    object({ ...target, nodeId, maxDimension: integer(64, 4096, 1600) }),
    true,
  ],
  [
    'figma_variables',
    'Read local variable collections, modes, values, aliases, scopes and code syntax. Paginated; does not search cloud libraries.',
    object({
      ...target,
      collectionId: { type: 'string', minLength: 1, maxLength: 200 },
      type: { type: 'string', enum: ['BOOLEAN', 'COLOR', 'FLOAT', 'STRING'] },
      limit: integer(1, 500, 200),
      offset: integer(0, 1000000, 0),
    }),
    true,
  ],
  [
    'figma_components',
    'Find component definitions in a subtree, page or the entire file (scope=file). Returns keys, variants and definitions from the correct owner. Continue bounded searches with the returned cursor and identical query; document edits expire cursors. Does not enumerate arbitrary cloud libraries.',
    object(search),
    true,
  ],
  [
    'figma_find_nodes',
    'Find nodes by literal name substring and optional native types in a page, subtree or entire file (scope=file). Bounded traversal; continue with the returned cursor and identical query. Edits expire cursors. No selection or viewport change.',
    object({
      ...search,
      types: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 60 },
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      },
    }),
    true,
  ],
  [
    'figma_export_node',
    'Export PNG/JPG/SVG/PDF, or native MP4/GIF/WEBM from an animated top-level frame when Figma enables it. SVG options are explicit; omitted options use native defaults. Verify bytes and optionally save locally. Native video fps is format-specific; unsupported permissions/features are reported, never bypassed. No file or viewport edits.',
    object({
      ...target,
      ...svgOptions,
      nodeId,
      format: {
        type: 'string',
        enum: ['PNG', 'JPG', 'SVG', 'PDF', 'MP4', 'GIF', 'WEBM'],
        default: 'PNG',
      },
      fps: integer(8, 60, 24),
      quality: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
      loopCount: integer(0, 1000, 0),
      maxDimension: integer(64, 8192, 1600),
      scale: { type: 'number', minimum: 0.01, maximum: 4, default: 1 },
      outputDirectory: { type: 'string', minLength: 1 },
    }),
    false,
  ],
  [
    'figma_capabilities',
    'Inspect this live editor API, enabled motion styles and available shaders. nodeId or a single selection identifies node-method checks; without a target those checks are unknown, not false. Optional methods checks exact dotted figma/node paths. Method presence is not permission or plan entitlement. No monthly local plugin quota.',
    object({
      ...target,
      nodeId,
      methods: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
        items: {
          type: 'string',
          pattern: '^(figma|node)(\\.[A-Za-z_$][A-Za-z0-9_$]*)+$',
        },
      },
    }),
    true,
  ],
  [
    'figma_design_system',
    'Search file components/instances, variables and paint/text/effect/grid styles in one batch. Optionally list enabled variable libraries and search one accessible library collection. Does not import assets, enable libraries or pretend to enumerate all cloud components.',
    object({
      ...target,
      rootId: nodeId,
      pageId: nodeId,
      scope,
      cursor,
      maxVisited: integer(1, 20000, 5000),
      includeLibraries: { type: 'boolean', default: false },
      libraryCollectionKey: { type: 'string', minLength: 1, maxLength: 200 },
      queries: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: object(
          {
            entity: {
              type: 'string',
              enum: ['component', 'variable', 'style'],
            },
            query: { type: 'string', maxLength: 200 },
            limit: integer(1, 500, 100),
          },
          ['entity', 'query'],
        ),
      },
    }),
    true,
  ],
  [
    'figma_download_assets',
    'Batch download up to 20 nodes, their original image-fill bytes and native VECTOR/BOOLEAN_OPERATION SVGs. Explicit format/scale overrides native export settings; otherwise configured exports take precedence over the bounded fallback (4096 px). SVG options can be chosen explicitly. Raw sources are not re-rendered. Reports traversal/image/vector limits; exports use the verified local artifact channel. outputDirectory writes local files without overwriting existing files; never edits the Figma document.',
    object({
      ...target,
      ...svgOptions,
      nodeId,
      nodeIds: {
        type: 'array',
        items: nodeId,
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      },
      pageId: nodeId,
      includeRender: { type: 'boolean', default: true },
      includeRaw: { type: 'boolean', default: true },
      includeVectors: { type: 'boolean', default: true },
      format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF'] },
      scale: { type: 'number', minimum: 0.01, maximum: 4 },
      maxDimension: integer(64, 8192, 4096),
      maxRawImages: integer(1, 100, 20),
      maxVectorAssets: integer(1, 100, 20),
      maxVisited: integer(1, 20000, 20000),
      outputDirectory: { type: 'string', minLength: 1 },
    }),
    false,
  ],
  [
    'figma_upload_assets',
    'Import 1–20 local raster/SVG assets with actual assetName/nodeId/type/bounds. Unicode aliases are supported. Both dimensions set exact bounds; one preserves aspect ratio; neither preserves intrinsic size. Image-fill replacement preserves geometry, other paints and the original image mode/crop; choose fillIndex for ambiguity or replaceAllFills explicitly. scaleMode and spacing are configurable. SVG stays vector. Stable operationId receipts support recovery; selection/viewport remain unchanged.',
    object(
      {
        ...target,
        ...operation,
        nodeId,
        parentId: nodeId,
        x: { type: 'number' },
        y: { type: 'number' },
        width: integer(1, 8192),
        height: integer(1, 8192),
        scaleMode: { type: 'string', enum: ['FILL', 'FIT', 'CROP', 'TILE'] },
        fillIndex: integer(0, 100),
        replaceAllFills: { type: 'boolean', default: false },
        spacing: { type: 'number', minimum: 0, maximum: 8192 },
        assetPaths: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        waitMs: integer(0, 30000, 20000),
      },
      ['operationId', 'assetPaths'],
    ),
    false,
  ],
  [
    'figma_motion',
    'Read actual native keyframes, animation styles, timeline durations and prototype reactions in a bounded subtree/file. Returns typed values/easing and issues as facts; no guessed animation snippets. Continue with its cursor; feature availability varies by account/editor.',
    object({
      ...target,
      nodeId,
      rootId: nodeId,
      pageId: nodeId,
      scope,
      cursor,
      maxNodes: integer(1, 1000, 200),
      maxVisited: integer(1, 20000, 5000),
    }),
    true,
  ],
  [
    'figma_run',
    'Run a native async JavaScript body with figma, args, bridge and returned console logs. Helpers: bridge.autoLayout, set, loadFonts, screenshot, assetText and exportFile. Supply a stable operationId; inspect it after a lost response. Waits briefly for the original receipt; queued jobs remain available through figma_job. readOnly=true is a trusted declaration, not a sandbox.',
    object(
      {
        ...target,
        ...operation,
        source: { type: 'string', minLength: 1, maxLength: 1048576 },
        args: { type: 'object' },
        assetPaths: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        readOnly: { type: 'boolean', default: false },
        waitMs: integer(0, 30000, 20000),
        commitUndo: { type: 'boolean', default: true },
      },
      ['operationId', 'source'],
    ),
    false,
  ],
  [
    'figma_job',
    'Read an original operation receipt. includePreviews=false reads it without downloading images. An uncertain outcome must be inspected, not repeated.',
    object(
      {
        ...operation,
        includePreviews: { type: 'boolean', default: true },
        waitMs: { type: 'integer', minimum: 0, maximum: 30000, default: 0 },
      },
      ['operationId'],
    ),
    true,
  ],
  [
    'figma_export',
    'Download verified exported files from an existing job to a local directory; refuses overwriting files.',
    object(
      { ...operation, outputDirectory: { type: 'string', minLength: 1 } },
      ['operationId', 'outputDirectory'],
    ),
    false,
  ],
  [
    'figma_reconcile',
    'After inspecting the actual canvas, record whether an uncertain operation applied, partially applied, or did not apply. Unblocks later writes; does not replay, roll back, or change the original receipt.',
    object(
      {
        ...operation,
        outcome: {
          type: 'string',
          enum: ['applied', 'partially_applied', 'not_applied'],
        },
        note: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      ['operationId', 'outcome', 'note'],
    ),
    false,
  ],
].map(([name, description, inputSchema, readOnlyHint]) => ({
  name,
  description,
  inputSchema,
  outputSchema: outputSchemas[name] || receiptSchema,
  annotations: {
    readOnlyHint,
    destructiveHint: ['figma_run', 'figma_upload_assets'].includes(name),
    openWorldHint: ['figma_open', 'figma_file', 'figma_run'].includes(name),
    ...(['figma_run', 'figma_upload_assets'].includes(name)
      ? { idempotentHint: true }
      : {}),
  },
}));
Object.assign(tools[0], {
  title: 'ysun figma',
  icons: app.icons,
  _meta: app.metadata,
});
for (const name of ['figma_canvas', 'figma_watch'])
  tools.find((tool) => tool.name === name)._meta = {
    ui: { visibility: ['app'] },
  };
function validate(value, schema, label = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${label} must be an object`);
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        throw new Error(`${label}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      const rule =
        (schema.properties && schema.properties[key]) ??
        schema.additionalProperties ??
        true;
      if (rule === false || rule === undefined)
        throw new Error(`unexpected ${label}.${key}`);
      if (typeof rule === 'object') validate(item, rule, `${label}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems) ||
      (schema.uniqueItems &&
        new Set(value.map((item) => JSON.stringify(item))).size !==
          value.length)
    )
      throw new Error(`invalid ${label}`);
    value.forEach((item, index) =>
      validate(item, schema.items, `${label}[${index}]`),
    );
  } else {
    if (
      schema.type === 'integer'
        ? !Number.isInteger(value)
        : typeof value !== schema.type
    )
      throw new Error(`invalid ${label}`);
    if (
      (schema.enum && !schema.enum.includes(value)) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value)) ||
      (schema.minLength && value.length < schema.minLength) ||
      (schema.maxLength && value.length > schema.maxLength) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )
      throw new Error(`invalid ${label}`);
  }
}
async function launchDesktop(
  key,
  run = require('node:util').promisify(require('node:child_process').execFile),
  platform = process.platform,
) {
  if (platform !== 'darwin')
    throw new Error('Figma Desktop launch currently requires macOS.');
  if (key && !/^[A-Za-z0-9]{6,100}$/.test(key))
    throw new Error('Invalid Figma file key.');
  await run('open', ['-a', 'Figma', ...(key ? [`figma://file/${key}`] : [])], {
    timeout: 10000,
  });
  return { state: 'opened', fileKey: key || null };
}
async function withPreviews(connection, record, signal, explicit = false) {
  if (record.job.status !== 'succeeded') return record;
  explicit ||=
    !!record.job.result?.value?.preview ||
    record.job.result?.value?.format === 'PNG';
  const previews = (record.job.result?.exports || []).filter(
    (file) =>
      ['image/png', 'image/jpeg', 'image/gif'].includes(file.mimeType) &&
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
async function callTool(name, input, signal) {
  let phase = 'preflight',
    receipt,
    submittedId;
  try {
    const definition = tools.find((tool) => tool.name === name);
    if (!definition)
      throw Object.assign(new Error('unknown tool'), { code: -32602 });
    validate(input, definition.inputSchema);
    if (
      [input.nodeId, input.nodeIds, input.pageId].filter(Boolean).length > 1 ||
      (input.rootId && (input.pageId || input.nodeId)) ||
      (input.nodeId && input.parentId) ||
      (input.scope === 'file' && (input.rootId || input.pageId || input.nodeId))
    )
      throw new Error('choose one node/root targeting option');
    if (
      name === 'figma_upload_assets' &&
      (!Object.keys(input.assetPaths).length ||
        Object.keys(input.assetPaths).length > 20)
    )
      throw new Error('Choose 1–20 assetPaths');
    if (
      name === 'figma_upload_assets' &&
      input.fillIndex !== undefined &&
      (!(
        input.nodeId ||
        (input.figmaUrl && parseFigmaUrl(input.figmaUrl).nodeId)
      ) ||
        input.replaceAllFills)
    )
      throw new Error(
        'fillIndex requires a target and cannot be combined with replaceAllFills',
      );
    if (
      name === 'figma_upload_assets' &&
      (input.nodeId ||
        (input.figmaUrl && parseFigmaUrl(input.figmaUrl).nodeId)) &&
      ['x', 'y', 'width', 'height'].some((key) => input[key] !== undefined)
    )
      throw new Error(
        'An image-fill replacement preserves node position and size; omit x, y, width and height',
      );
    if (
      name === 'figma_status' &&
      input.scope === 'all' &&
      (input.clientId || input.fileKey)
    )
      throw new Error('choose all history or one connected file');
    if (name === 'figma_file' && input.action === 'launch' && !input.fileKey)
      return launchDesktop();
    const connection = await ensureCompanion();
    const request = (route, options) =>
      bridgeRequest(connection, route, { ...options, signal });
    if (name === 'figma_status')
      return {
        updates: require('./updates.cjs').updateStatus(),
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
    if (name === 'figma_open') {
      await request('/v1/catalog/sync', {
        method: 'POST',
        body: '{}',
      });
      return request('/v1/app');
    }
    if (name === 'figma_watch') {
      return request(
        '/v1/app?' +
          new URLSearchParams({
            cursor: input.cursor,
            waitMs: input.waitMs ?? 20000,
          }),
      );
    }
    if (name === 'figma_file') {
      if (input.action === 'sync') {
        const catalog = await request('/v1/catalog/sync', {
          method: 'POST',
          body: '{"force":true}',
        });
        return {
          ...(await request('/v1/app')),
          browserSpace: catalog.browserSpace || null,
          next: 'The account sync runs automatically. If login_required, resume this existing browser space and complete ordinary Figma sign-in with the available browser tool, then sync again. Do not ask the user to paste file links or tokens. Preserve login/permission boundaries.',
        };
      }
      if (input.action === 'bind') {
        await request('/v1/catalog/bind', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        return request('/v1/app');
      }
      const catalog = await request('/v1/catalog');
      if (!input.fileKey)
        throw new Error('fileKey is required to open a file.');
      if (
        input.verifiedUrl &&
        parseFigmaUrl(input.verifiedUrl).fileKey !== input.fileKey
      )
        throw new Error('verifiedUrl does not match fileKey.');
      const file = catalog.files.find(
        (file) => file.fileKey === input.fileKey,
      ) || {
        fileKey: input.fileKey,
        url:
          input.verifiedUrl || 'https://www.figma.com/design/' + input.fileKey,
      };
      if (input.action === 'launch') return launchDesktop(file.fileKey);
      const state = await request('/v1/status?summary=1');
      if (
        input.clientId ||
        matchingClients({ fileKey: file.fileKey }, state.clients).length
      ) {
        const selected = resolveTarget(
          { fileKey: file.fileKey, clientId: input.clientId },
          state.clients,
        );
        return {
          state: 'connected',
          file,
          clientId: selected.clientId,
          targeting: selected.targeting,
          ...(await request('/v1/app')),
        };
      }
      await launchDesktop(file.fileKey);
      return {
        state: 'connection_required',
        file,
        next: 'Figma Desktop is opening this exact file. Check figma_status and the actual open file URL first. If its native plugin is already running, verify that exact client/document before binding; otherwise run ysun figma → Connect in this file and compare the fresh instance with prior status. Reuse saved authorization; figma_connect(newFile=true) supplies a code only when needed. Use figma_file(action=bind,fileKey,clientId,documentId,verifiedUrl) for that live instance. Never infer identity from the name or copied plugin data. Keep instructions in the current Codex conversation.',
      };
    }
    if (name === 'figma_connect') {
      const state = await request('/v1/status?summary=1');
      const files = state.clients;
      const manifestPath = path.join(
        bridgeStateDirectory(),
        'plugin/manifest.json',
      );
      if (files.length && !input.newFile)
        return {
          state: 'connected',
          manifestPath,
          files,
          next: 'Reuse the intended connected file. If needsPluginUpdate, wait until no job is queued/running and reopen the native plugin yourself; saved authorization restores. For an additional file call with newFile=true. Do not re-pair a working file.',
        };
      return {
        state: 'pairing_required',
        manifestPath,
        ...(await request('/v1/pairings', { method: 'POST', body: '{}' })),
        next: 'Use available native app automation: open Figma Desktop and the intended file, import this stable manifest only if missing, run ysun figma → Connect, fill the one-time code and click 连接. Verify figma_status. Reopened plugins restore saved authorization without a new code. If automation or a dialog is blocked, state the actual blocker and ask only for the remaining action. The connection panel hides after pairing.',
      };
    }
    if (name === 'figma_reconcile')
      return request(`/v1/jobs/${input.operationId}/reconcile`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    if (name === 'figma_job' || name === 'figma_export') {
      phase = 'receipt';
      submittedId = input.operationId;
      const record = await request(
        `/v1/jobs/${input.operationId}?wait=${input.waitMs || 0}`,
      );
      return await deliverResult(connection, record, {
        signal,
        outputDirectory: input.outputDirectory,
        includePreviews:
          name === 'figma_job' && input.includePreviews !== false,
      });
    }
    signal?.throwIfAborted();
    const state = await request('/v1/status?summary=1');
    const selected = resolveTarget(input, state.clients);
    if (
      selected.nodeId &&
      (input.pageId || input.rootId || input.nodeIds || input.scope === 'file')
    )
      throw new Error('choose one node/root targeting option');
    const assets = await uploadAssets(connection, input.assetPaths);
    const query = queries[name];
    const source = query
      ? `return await bridge.query('${query}', args);`
      : input.source;
    const {
      clientId,
      fileKey,
      fileName,
      figmaUrl,
      operationId,
      waitMs: requestedWait,
      assetPaths,
      outputDirectory,
      ...queryArgs
    } = input;
    // Asset bytes are content-addressed for stable request digests across upload retries.
    signal?.throwIfAborted();
    const readOnly =
      (!!query && name !== 'figma_upload_assets') ||
      name === 'figma_inspect' ||
      (name === 'figma_run' && input.readOnly === true);
    phase = 'submitted';
    submittedId =
      name === 'figma_run'
        ? input.operationId
        : readOnly
          ? crypto.randomUUID()
          : input.operationId;
    const { job } = await request('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'exec',
        operationId: submittedId,
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
        },
      }),
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
      phase = 'execution';
      const error = new Error(
        (result.job.status === 'outcome_unknown' ? 'outcome_unknown: ' : '') +
          (result.job.error || 'Figma operation failed'),
      );
      error.receipt = result;
      throw error;
    }
    result.safeToRetryWithoutCanvasRead =
      readOnly || result.job.status === 'failed';
    return await deliverResult(connection, result, {
      signal,
      outputDirectory: input.outputDirectory,
      explicit: ['figma_screenshot', 'figma_design_context'].includes(name),
    });
  } catch (error) {
    error.phase ||= phase;
    error.operationId ||= submittedId;
    if (receipt) error.receipt ||= receipt;
    throw error;
  }
}
function serve(input = process.stdin, output = process.stdout) {
  let buffer = '',
    phase = 'new';
  const pending = new Map();
  const send = (message) => output.write(JSON.stringify(message) + '\n');
  let runtime, updateTimer;
  function currentRuntime() {
    runtime ||= module.exports;
    let observed;
    try {
      observed = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
      ).version;
    } catch (error) {
      if (error.code === 'ENOENT') return runtime;
      throw error;
    }
    if (observed === runtime.version) return runtime;
    // Managed promotion replaces the one current package atomically. Keep the
    // host's stdio transport alive and discard only this package's module cache.
    const root = path.resolve(__dirname, '../..') + path.sep;
    for (const id of Object.keys(require.cache))
      if (id.startsWith(root)) delete require.cache[id];
    runtime = require(__filename);
    if (phase === 'ready') {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    }
    return runtime;
  }
  async function handle(message) {
    if (
      !message ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') &&
        !['number', 'string'].includes(typeof message.id))
    ) {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }
    if (!Object.hasOwn(message, 'id')) {
      if (
        message.method === 'notifications/initialized' &&
        phase === 'initializing'
      ) {
        phase = 'ready';
        updateTimer = setInterval(() => {
          try {
            currentRuntime();
          } catch (error) {
            process.stderr.write('Update discovery: ' + error.message + '\n');
          }
        }, 1000);
        updateTimer.unref();
      }
      if (message.method === 'notifications/cancelled')
        pending.get(message.params && message.params.requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    pending.set(message.id, controller);
    try {
      const api = currentRuntime();
      let result;
      if (message.method === 'initialize') {
        if (phase !== 'new')
          throw Object.assign(new Error('already initialized'), {
            code: -32600,
          });
        if (
          typeof message.params?.protocolVersion !== 'string' ||
          !message.params.clientInfo ||
          !message.params.capabilities
        )
          throw Object.assign(new Error('invalid initialize parameters'), {
            code: -32602,
          });
        phase = 'initializing';
        result = {
          protocolVersion: '2025-11-25',
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
          },
          serverInfo: {
            name: 'figma-plugin-local',
            title: 'ysun figma',
            version: api.version,
            icons: api.app.icons,
          },
          instructions:
            'Use the ysun-figma skills. Stay in the current conversation. Confirm the exact file/client with figma_status; never choose an ambiguous instance or bind by title. Keep a stable operationId per edit. After interruption or delivery failure, inspect its original figma_job; never replay an uncertain write. Sparse/truncated queries are incomplete evidence. figma_open is the optional design browser. Status provides stable skill/API paths. Native editing requires Figma Desktop and its plugin. Local tools have no monthly plugin quota; Figma permissions, plan features and cloud limits remain. Cloud authoring, Weave, Make and hosted Code Connect are separate services.',
        };
      } else if (message.method === 'ping') result = {};
      else {
        if (phase !== 'ready')
          throw Object.assign(new Error('initialize first'), { code: -32000 });
        if (message.method === 'tools/list') result = { tools: api.tools };
        else if (message.method === 'resources/list')
          result = { resources: [api.app.resource] };
        else if (message.method === 'resources/templates/list')
          result = { resourceTemplates: [] };
        else if (message.method === 'resources/read')
          result = api.app.readResource(message.params?.uri);
        else if (message.method === 'tools/call') {
          try {
            const value = await api.callTool(
              message.params?.name,
              message.params?.arguments || {},
              controller.signal,
            );
            result = {
              content: [
                { type: 'text', text: JSON.stringify(value) },
                ...(value[api.images] || []),
              ],
              structuredContent: value,
              isError: false,
            };
          } catch (error) {
            if (error.code === -32602) throw error;
            const value = api.toolError(error, message.params?.arguments);
            result = {
              content: [{ type: 'text', text: JSON.stringify(value) }],
              structuredContent: value,
              isError: true,
            };
          }
        } else
          throw Object.assign(new Error('Method not found'), { code: -32601 });
      }
      if (!controller.signal.aborted)
        send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: Number.isInteger(error.code) ? error.code : -32603,
          message: error.message,
        },
      });
    } finally {
      pending.delete(message.id);
    }
  }
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 6 * 1024 * 1024) {
      input.destroy();
      process.exitCode = 1;
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        continue;
      }
      void handle(message);
    }
  });
  input.on('end', () => {
    clearInterval(updateTimer);
    for (const controller of pending.values()) controller.abort();
  });
}
module.exports = {
  tools,
  callTool,
  serve,
  validate,
  toolError,
  app,
  version,
  images,
  launchDesktop,
};
if (require.main === module) serve();
