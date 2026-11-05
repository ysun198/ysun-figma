const { topics, workflows } = require('./api-reference.cjs');

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
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
  profile: { type: 'string', enum: ['default', 'dev', 'widget'] },
  fileKey,
  fileName: { type: 'string', minLength: 1, maxLength: 1000 },
  figmaUrl: { type: 'string', minLength: 1, maxLength: 3000 },
};
const operation = { operationId: id };
const ifUnchanged = {
  type: 'array',
  items: id,
  minItems: 1,
  maxItems: 20,
  uniqueItems: true,
};
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
  figma_navigate: 'navigate',
  figma_inspect: 'inspect',
  figma_snapshot: 'snapshot',
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
});
const outputSchemas = {
  figma_rest: { type: 'object', additionalProperties: true },
  figma_api: resultSchema({ reference: { type: 'object' } }),
  figma_community: resultSchema({ source: { type: 'object' } }),
  figma_status: resultSchema({
    clients: { type: 'array', items: { type: 'object' } },
    version: { type: 'string' },
    jobCount: { type: 'integer' },
    scopedUnresolvedJobCount: { type: 'integer' },
    globalUnresolvedJobCount: { type: 'integer' },
  }),
  figma_connect: resultSchema({
    state: {
      type: 'string',
      enum: ['connected', 'connection_required', 'pairing_required'],
    },
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
const errorSchema = resultSchema({
  code: { type: 'string' },
  message: { type: 'string' },
  error: { type: 'string' },
});
function classifyError(error, detail, precondition) {
  const serviceCode = error.code || error.body?.code || '';
  if (/^(REST|CLOUD)_/.test(serviceCode)) return serviceCode;
  if (precondition?.code === 'WRITE_CONFLICT') return 'FIGMA_WRITE_CONFLICT';
  if (precondition) return 'FIGMA_PRECONDITION_FAILED';
  if (error.phase === 'delivery') return 'ARTIFACT_DELIVERY_FAILED';
  if (error.code === 'FILE_AMBIGUOUS') return error.code;
  if (error.receipt?.job.status === 'outcome_unknown')
    return 'OUTCOME_NEEDS_REVIEW';
  if (error.receipt?.job.status === 'failed') return 'FIGMA_OPERATION_FAILED';
  const patterns = [
    [/desktop_required/, 'FIGMA_DESKTOP_REQUIRED'],
    [/desktop_restart_required/, 'FIGMA_DESKTOP_RESTART_REQUIRED'],
    [/login_required/, 'FIGMA_LOGIN_REQUIRED'],
    [/desktop_plugin_not_imported/, 'FIGMA_NATIVE_IMPORT_REQUIRED'],
    [
      /desktop_\w*schema_changed|desktop_(?:launcher|state|widget)_ambiguous/,
      'FIGMA_DESKTOP_ADAPTER_UNAVAILABLE',
    ],
    [/desktop_file_ambiguous|desktop_native_frame_ambiguous/, 'FILE_AMBIGUOUS'],
    [
      /No matching connected|no matching connected|open the plugin and pair/,
      'FIGMA_NOT_CONNECTED',
    ],
    [/Several Figma|multiple matching/, 'FILE_AMBIGUOUS'],
    [/outcome_unknown|uncertain|reconcil/i, 'OUTCOME_NEEDS_REVIEW'],
    [/outdated|version mismatch|update the plugin/i, 'PLUGIN_UPDATE_REQUIRED'],
    [
      /ECONN|fetch failed|timeout|not running|could not start|Port 38491/i,
      'CONNECTION_UNAVAILABLE',
    ],
  ];
  return (
    patterns.find(([pattern]) => pattern.test(detail))?.[1] ||
    'FIGMA_OPERATION_FAILED'
  );
}

function recoveryAdvice(
  error,
  { blockingOperationIds, precondition, submitted, operationId },
) {
  if (blockingOperationIds)
    return 'This request was not submitted. Inspect each blocking operation ID and reconcile its actual outcome before another write.';
  if (precondition)
    return 'Read the current resources with figma_snapshot, review the changes, then submit a new conditional edit. The original user script did not run.';
  if (error.phase === 'preflight')
    return (
      'No native job was submitted. ' +
      (setupRecovery(String(error.message || error)) ||
        (error.toolName
          ? `Correct the concrete error; figma_api(query=${JSON.stringify(error.toolName)}) gives its current inputSchema.`
          : 'Correct the request before retrying.'))
    );
  if (error.phase === 'delivery')
    return 'Read figma_job with includePreviews=false for this original operation ID, or retry figma_export to an empty directory. Do not rerun the native script.';
  if (submitted) return 'Inspect this original operation ID before retrying.';
  if (operationId)
    return 'No native job was submitted. Correct the request before retrying.';
}

function setupRecovery(detail) {
  const actions = [
    [
      /desktop_required/,
      'Install signed Figma Desktop from its official download for this user, then use figma_file(action="launch") and reconnect the intended exact file. See the packaged setup skill.',
    ],
    [
      /desktop_restart_required/,
      'Inspect pending operations and Desktop save state, quit normally only when safe, then relaunch through figma_file(action="launch") and reconnect the exact file. Preserve the login and designs.',
    ],
    [
      /login_required/,
      'Have the user complete ordinary Figma sign-in, then resume this file connection. Native work needs no REST credential JSON or custom OAuth app.',
    ],
    [
      /desktop_plugin_not_imported/,
      'Read figma_connect for the stable manifest path, import only that missing manifest once through app automation, then retry figma_file(action="connect", fileKey=...). No manual pairing code is needed.',
    ],
    [
      /desktop_\w*schema_changed|desktop_(?:launcher|state|widget)_ambiguous/,
      'Keep the exact Desktop adapter diagnostic and observed file/target identities; use the setup/files skill to repair or choose a supported fallback. Do not guess module IDs or bind by title.',
    ],
    [
      /outdated|version mismatch|update the plugin/i,
      'Read original pending/uncertain operations first. When they are finished or reconciled, use figma_file(action="connect", fileKey=...) and its returned current client/instance.',
    ],
    [
      /No matching connected|no matching connected/,
      'Read figma_status and figma_file(action="status") for current exact identities, then open/connect the intended file with figma_file. A profile switch can retire the previous client.',
    ],
  ];
  return actions.find(([pattern]) => pattern.test(detail))?.[1];
}

function operationContext(error, input, code) {
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
  return { blockingOperationIds, operationId, submitted };
}
function retrySafety(
  error,
  { code, precondition, blockingOperationIds, operationId, submitted },
) {
  // Rejection of this request does not resolve an older uncertain write. Derive
  // retry guidance once, so a preflight branch cannot override the ledger.
  if (
    precondition ||
    blockingOperationIds ||
    code === 'OUTCOME_NEEDS_REVIEW' ||
    code === 'CLOUD_RECEIPT_UNAVAILABLE'
  )
    return false;
  if (error.receipt) return error.receipt.job.status === 'failed';
  if (!submitted && operationId) return true;
}
function toolError(error, input = {}) {
  const detail = String(error.message || error);
  const precondition = error.receipt?.job.result?.precondition;
  const code = classifyError(error, detail, precondition);
  const messages = {
    FIGMA_WRITE_CONFLICT: '目标内容已变化，本次脚本尚未执行。',
    FIGMA_PRECONDITION_FAILED: '无法核对写入条件，本次脚本尚未执行。',
    FIGMA_NOT_CONNECTED: '目标 Figma 文件尚未连接。',
    FILE_AMBIGUOUS: '存在多个可能的 Figma 实例，需要明确目标文件和客户端。',
    OUTCOME_NEEDS_REVIEW: '上次操作的结果尚未确认，需要先核对设计。',
    PLUGIN_UPDATE_REQUIRED: 'Figma 中的 ysun figma 需要更新并恢复连接。',
    FIGMA_DESKTOP_REQUIRED: '需要先安装 Figma 桌面端。',
    FIGMA_DESKTOP_RESTART_REQUIRED: '需要由 Codex 安全重连 Figma 桌面端。',
    FIGMA_LOGIN_REQUIRED: '需要先完成 Figma 自己的登录。',
    FIGMA_NATIVE_IMPORT_REQUIRED: '需要先导入一次原生插件。',
    FIGMA_DESKTOP_ADAPTER_UNAVAILABLE: '当前 Figma 桌面接口需要兼容性处理。',
    CONNECTION_UNAVAILABLE: '连接暂时不可用，可以重试或让 Codex 恢复连接。',
    FIGMA_OPERATION_FAILED: '操作未完成，请查看原始错误和执行回执。',
    ARTIFACT_DELIVERY_FAILED: '预览或文件交付失败，原始 Figma 执行回执已保留。',
  };
  const context = operationContext(error, input, code);
  const { blockingOperationIds, operationId, submitted } = context;
  const safeToRetryWithoutCanvasRead = retrySafety(error, {
    ...context,
    code,
    precondition,
  });
  const result = {
    code,
    message:
      error.phase === 'preflight' && !blockingOperationIds
        ? '请求未提交到 Figma，请根据具体错误修正后继续。'
        : messages[code] || detail,
    error: detail,
    phase: error.phase || undefined,
    clients: error.clients || error.body?.clients || undefined,
    targetChange:
      error.body?.expected && error.body?.actual
        ? { expected: error.body.expected, actual: error.body.actual }
        : undefined,
    blockingOperationIds: blockingOperationIds || undefined,
    precondition,
    receipt: error.receipt || undefined,
    nativeStatus: error.receipt?.job.status,
    safeToRetryWithoutCanvasRead,
    operationId: operationId || undefined,
    toolName: error.toolName,
    next: recoveryAdvice(error, {
      blockingOperationIds,
      precondition,
      submitted,
      operationId,
    }),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  );
}
const tools = [
  [
    'figma_rest',
    'Optional direct REST, Discovery and SCIM endpoints. Native canvas work needs no REST token; supported cloud authoring reuses the host’s official Figma connection. Read figma_api(topic="cloud") before adding credentials. list/describe work offline. auth_status reports only credential metadata; configure accepts a private credential-file path, never a token in tool arguments. request validates path/query/body, authenticates only to fixed official REST/SCIM origins and records operations in the existing ledger. Mutations require a stable operationId; inspect uncertain original receipts before retrying. Cloud resources and permissions change only with user authorization. Native canvas editing remains in figma_run.',
    object(
      {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'auth_status', 'configure', 'request'],
        },
        endpoint: { type: 'string', minLength: 1, maxLength: 120 },
        query: { type: 'object', additionalProperties: true },
        pathParams: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        body: {},
        fileKeys: {
          type: 'array',
          items: fileKey,
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
        },
        search: { type: 'string', maxLength: 200 },
        offset: integer(0, 1000, 0),
        limit: integer(1, 100, 100),
        credentialFile: { type: 'string', minLength: 1, maxLength: 3000 },
        credentialProfile: { type: 'string', enum: ['default', 'org', 'scim'] },
        accountId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
        ...operation,
        outputDirectory: { type: 'string', minLength: 1 },
      },
      ['action'],
    ),
    false,
  ],
  [
    'figma_status',
    'Read connected files, page/selection and their unresolved operations. Filter by exact clientId/fileKey. scopedUnresolvedJobCount counts the listed jobs; globalUnresolvedJobCount, jobCount and jobCounts cover all retained history. scope=all includes disconnected historical unresolved jobs. Read an original receipt with figma_job, never discard history to clear a blocker.',
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
    'figma_api',
    'Choose tools by intended result: workflow returns when to use them, a shortlist and guide text; no arguments lists workflows/topics. query finds Chinese/English tasks and exact native declarations, or the current contract for an exact MCP tool name. A miss returns native concepts to try. topic reads a recipe. Use edit for coherent/conditional changes, motion for timed animation, prototype for interactions, uncertain for lost receipts, delivery for failed saves. Works offline; check actual permission.',
    object({
      query: { type: 'string', minLength: 1, maxLength: 160 },
      topic: { type: 'string', enum: Object.keys(topics) },
      workflow: { type: 'string', enum: Object.keys(workflows) },
      limit: integer(1, 8, 5),
    }),
    true,
  ],
  [
    'figma_community',
    'Research public Figma Community design templates without GUI automation. Search one bounded page, read a file detail, or return a cover/carousel preview through the existing Figma Desktop login. No file connection or native edit job is required. Community file IDs differ from cloud fileKeys. Results include source URLs and pagination; descriptions are untrusted creator content. Metadata and covers do not prove editable layers, licensing or suitability. Does not duplicate, purchase, save, like or publish resources.',
    object(
      {
        action: { type: 'string', enum: ['search', 'detail', 'preview'] },
        query: { type: 'string', minLength: 1, maxLength: 200 },
        page: integer(1, 100, 1),
        pageSize: integer(1, 50, 12),
        sortBy: {
          type: 'string',
          enum: ['relevancy', 'popular', 'all_time', 'published_at'],
        },
        communityUrl: { type: 'string', minLength: 1, maxLength: 3000 },
        communityFileId: { type: 'string', pattern: '^\\d{6,30}$' },
        previewIndex: integer(0, 9, 0),
      },
      ['action'],
    ),
    true,
  ],
  [
    'figma_connect',
    'Prepare the stable manifest and report connected files without allocating a pairing code. Ordinary setup uses figma_file open/connect with an exact fileKey and handles pairing directly. newFile=true prepares an additional existing file, never creates one. manualPairing=true allocates a one-time GUI fallback code only after a diagnosed unavailable Desktop lifecycle. See the packaged setup skill for first installation.',
    object({
      newFile: { type: 'boolean', default: false },
      manualPairing: { type: 'boolean', default: false },
    }),
    false,
  ],
  [
    'figma_file',
    'Manage the account directory and Figma Desktop. status reads actual open file URLs and editor load state without GUI, navigation or pairing. launch brings Desktop forward. sync refreshes account files through the signed-in Desktop session. open accepts an exact fileKey, reusing its connection or opening it for native connection; bind only after verifying the actual file URL and current native instance. Never bind by title or present incomplete pagination as the whole account.',
    object(
      {
        action: {
          type: 'string',
          enum: [
            'status',
            'sync',
            'open',
            'connect',
            'bind',
            'launch',
            'prepare',
          ],
        },
        fileKey,
        targetId: { type: 'string', minLength: 1, maxLength: 100 },
        profile: { type: 'string', enum: ['default', 'dev', 'widget'] },
        sourcePath: { type: 'string', minLength: 1, maxLength: 3000 },
        widgetNodeId: nodeId,
        restart: { type: 'boolean' },
        ...operation,
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
    'figma_navigate',
    'Activate an exact native page, optionally select nodes on it and fit the viewport, entirely through the Plugin API. Requires pageId from figma_inspect. An empty nodeIds clears selection; omit it to preserve selection. A node in figmaUrl can select that node instead. Does not create or edit design content or bring another app forward. Selected nodes must belong to the chosen page. Returns actual page, selection and viewport. Use a stable operationId; if a selection fails, inspect the current page through figma_status instead of clicking the GUI.',
    object(
      {
        ...target,
        ...operation,
        pageId: nodeId,
        nodeIds: {
          type: 'array',
          items: nodeId,
          maxItems: 20,
          uniqueItems: true,
        },
        zoomToFit: { type: 'boolean', default: false },
        waitMs: integer(0, 30000, 20000),
      },
      ['operationId', 'pageId'],
    ),
    false,
  ],
  [
    'figma_snapshot',
    'Read exact selected properties for a conditional edit. Resources may be nodes, variables, collections or styles. rootId pins the workspace without navigating. Pass this returned job.id in figma_run/figma_upload_assets ifUnchanged; only these observed fields and node ancestry are protected. Independent workspaces do not invalidate each other. Re-read on conflict; this is not a transaction or a JavaScript sandbox.',
    object(
      {
        ...target,
        rootId: nodeId,
        resources: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: object(
            {
              kind: {
                type: 'string',
                enum: ['node', 'variable', 'collection', 'style'],
              },
              id: { type: 'string', minLength: 1, maxLength: 200 },
              fields: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
            ['kind', 'id', 'fields'],
          ),
        },
      },
      ['resources'],
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
    'Read local variable collections, modes, values, aliases, scopes and code syntax, including EASING and TIMING motion variables. Paginated; does not search cloud libraries.',
    object({
      ...target,
      collectionId: { type: 'string', minLength: 1, maxLength: 200 },
      type: {
        type: 'string',
        enum: ['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING'],
      },
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
    'Find lightweight node identities by literal name and optional types in a page, subtree or file (scope=file). Does not resolve instance masters by default; includeComponentMetadata=true adds that detail, or use figma_components/design_context. Bounded traversal; continue with its cursor and identical options. Edits expire cursors. No selection/viewport change.',
    object({
      ...search,
      includeComponentMetadata: { type: 'boolean', default: false },
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
    'Export PNG/JPG/SVG/PDF, native REST-shaped JSON_REST_V1 node data, or MP4/GIF/WEBM from an animated top-level frame when Figma enables it. JSON is not a .fig file or guaranteed round-trip backup. SVG options are explicit; omitted options use native defaults. PNG exports report actual image dimensions and fullyTransparent (null when alpha inspection is unavailable); empty renders warn without blocking delivery. Verify bytes and optionally save locally. Native video fps is format-specific; unsupported permissions/features are reported, never bypassed. No file or viewport edits.',
    object({
      ...target,
      ...svgOptions,
      nodeId,
      format: {
        type: 'string',
        enum: [
          'PNG',
          'JPG',
          'SVG',
          'PDF',
          'MP4',
          'GIF',
          'WEBM',
          'JSON_REST_V1',
        ],
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
    'Probe callable methods on this live editor without enumerating resources. Optional methods checks exact dotted figma/node paths; global-only checks do not load nodes. nodeId or a single selection identifies node-method checks; without a target those checks are unknown, not false. includeResources=true additionally lists requested motion styles/shaders and can wait for the cloud. Method presence is not permission or plan entitlement.',
    object({
      ...target,
      nodeId,
      includeResources: { type: 'boolean', default: false },
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
        ifUnchanged,
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
    'Read actual keyframes, animation styles and prototype reactions in a bounded subtree/file. Static default timelines are omitted except for an explicit root; includeStaticTimelines=true includes them. Returns typed values/easing, current-page counts, issues and a cursor. No guessed animation snippets. Continue with the same options; feature availability varies by account/editor.',
    object({
      ...target,
      nodeId,
      rootId: nodeId,
      pageId: nodeId,
      scope,
      cursor,
      maxNodes: integer(1, 1000, 200),
      maxVisited: integer(1, 20000, 5000),
      includeStaticTimelines: { type: 'boolean', default: false },
    }),
    true,
  ],
  [
    'figma_run',
    'Run a native async JavaScript body. Prefer one live read/compute/write for coherent edits. For decisions based on earlier tool reads, ifUnchanged accepts figma_snapshot IDs and rejects changed fields before the body runs. rootId (or a unique snapshot root) supplies bridge.root and scopes autoLayout/import creation without navigating. Helpers: set, loadFonts, screenshot, assetText, exportFile. Use stable operationId; inspect after a lost response. Native code retains full API access; root/readOnly are not a sandbox.',
    object(
      {
        ...target,
        ...operation,
        rootId: nodeId,
        ifUnchanged,
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
  title: name.replace(/^figma_/, 'Figma ').replaceAll('_', ' '),
  description,
  inputSchema,
  outputSchema: {
    type: 'object',
    anyOf: [outputSchemas[name] || receiptSchema, errorSchema],
  },
  annotations: {
    readOnlyHint,
    destructiveHint: [
      'figma_run',
      'figma_upload_assets',
      'figma_rest',
    ].includes(name),
    openWorldHint: [
      'figma_file',
      'figma_run',
      'figma_community',
      'figma_rest',
    ].includes(name),
    ...(['figma_run', 'figma_upload_assets', 'figma_navigate'].includes(name)
      ? { idempotentHint: true }
      : {}),
  },
}));
function validateObject(value, schema, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of schema.required || [])
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  for (const [key, item] of Object.entries(value)) {
    const rule =
      schema.properties && Object.hasOwn(schema.properties, key)
        ? schema.properties[key]
        : (schema.additionalProperties ?? true);
    if (rule === false || rule === undefined)
      throw new Error(`unexpected ${label}.${key}`);
    if (typeof rule === 'object') validate(item, rule, `${label}.${key}`);
  }
}
function validateArray(value, schema, label) {
  if (
    !Array.isArray(value) ||
    (schema.minItems !== undefined && value.length < schema.minItems) ||
    (schema.maxItems !== undefined && value.length > schema.maxItems) ||
    (schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
  )
    throw new Error(`invalid ${label}`);
  value.forEach((item, index) =>
    validate(item, schema.items, `${label}[${index}]`),
  );
}
function validateScalar(value, schema, label) {
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
function validate(value, schema, label = 'arguments') {
  // Empty schemas accept any JSON; endpoint-specific REST validation follows.
  if (!Object.keys(schema).length) return;
  if (schema.type === 'object') validateObject(value, schema, label);
  else if (schema.type === 'array') validateArray(value, schema, label);
  else validateScalar(value, schema, label);
}
module.exports = { isRecord, queries, tools, validate, toolError };
