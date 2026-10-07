// Bundled once in the native plugin. MCP jobs call a named query with JSON args.
// Reads preserve file, selection and viewport.
function createDesignQueries(figma, bridge, log = () => {}) {
  const issues = [];
  let nativeReads = {};
  async function nativeRead(method, targetId, action) {
    const startedAt = Date.now();
    try {
      return await action();
    } catch (error) {
      log({
        nativeRead: method,
        targetId,
        error: String(error.message || error),
      });
      throw error;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const timing = (nativeReads[method] ||= {
        calls: 0,
        elapsedMs: 0,
        maxElapsedMs: 0,
        slowestTarget: null,
      });
      timing.calls++;
      timing.elapsedMs += elapsedMs;
      if (timing.slowestTarget === null || elapsedMs > timing.maxElapsedMs) {
        timing.maxElapsedMs = elapsedMs;
        timing.slowestTarget = targetId || null;
      }
    }
  }
  function complete(value, start = 0) {
    const observed = issues.slice(start);
    const truncated =
      !!(
        value.truncated ||
        value.rawImagesTruncated ||
        value.vectorsTruncated ||
        value.results?.some((result) => result.truncated)
      ) ||
      observed.some((issue) =>
        /truncated|limit reached/.test(issue.reason || ''),
      );
    return {
      ...value,
      truncated,
      sparse: truncated || observed.length > 0,
      issues: observed.slice(0, 100),
      issueCount: observed.length,
      issuesTruncated: observed.length > 100,
      nativeReads,
    };
  }
  const safe = (value, depth = 0) => {
    if (typeof value === 'symbol') return 'mixed';
    if (value === undefined || typeof value === 'function') return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      if (value.length > 8192)
        issues.push({
          field: 'serialization',
          reason: 'text truncated',
          length: value.length,
        });
      return value.slice(0, 8192);
    }
    if (depth > 8) {
      issues.push({ field: 'serialization', reason: 'depth truncated' });
      return '[truncated]';
    }
    if (Array.isArray(value)) {
      if (value.length > 64)
        issues.push({
          field: 'serialization',
          reason: 'array truncated',
          length: value.length,
        });
      return value.slice(0, 64).map((item) => safe(item, depth + 1));
    }
    const keys = Object.keys(value);
    if (keys.length > 100)
      issues.push({
        field: 'serialization',
        reason: 'object truncated',
        length: keys.length,
      });
    return Object.fromEntries(
      keys.slice(0, 100).map((key) => [key, safe(value[key], depth + 1)]),
    );
  };
  const describe = (node) => ({
    id: node.id,
    type: node.type,
    name: node.name,
  });
  const read = (node, keys) => {
    const result = {};
    for (const key of keys) {
      try {
        if (!(key in node)) continue;
        const value = safe(node[key]);
        if (value !== undefined) result[key] = value;
      } catch (error) {
        issues.push({
          nodeId: node.id,
          field: key,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
    return result;
  };
  const identity = () => ({
    name: figma.root.name,
    fileKey: figma.fileKey || null,
    editorType: figma.editorType,
    page: describe(figma.currentPage),
    selection: figma.currentPage.selection.map(describe),
  });
  async function nodeById(id) {
    const node = await nativeRead('getNodeByIdAsync', id, () =>
      figma.getNodeByIdAsync(id),
    );
    if (!node || node.type === 'DOCUMENT')
      throw new Error('Node not found in this file: ' + id);
    return node;
  }
  async function roots(args) {
    if (args.nodeIds?.length) return Promise.all(args.nodeIds.map(nodeById));
    if (args.nodeId) return [await nodeById(args.nodeId)];
    if (args.pageId) {
      const page = await nodeById(args.pageId);
      if (page.type !== 'PAGE') throw new Error('pageId must identify a page');
      await nativeRead('loadAsync', page.id, () => page.loadAsync());
      return [page];
    }
    if (figma.currentPage.selection.length)
      return [...figma.currentPage.selection];
    await nativeRead('loadAsync', figma.currentPage.id, () =>
      figma.currentPage.loadAsync(),
    );
    return [figma.currentPage];
  }
  async function inspect(args = {}) {
    if (args.nodeId || args.nodeIds?.length) {
      const nodes = await roots(args);
      return {
        file: identity(),
        nodes: nodes.map((node) => ({
          ...describe(node),
          ...read(node, ['width', 'height']),
          parent: node.parent ? describe(node.parent) : null,
        })),
      };
    }
    const page = args.pageId ? await nodeById(args.pageId) : figma.currentPage;
    if (page.type !== 'PAGE') throw new Error('pageId must identify a page');
    await nativeRead('loadAsync', page.id, () => page.loadAsync());
    return {
      fileName: figma.root.name,
      editorType: figma.editorType,
      apiVersion: figma.apiVersion,
      pages: figma.root.children.map(describe),
      page: describe(page),
      selection: page.selection.map(describe),
      children: page.children.map(describe),
    };
  }
  async function canvas(args = {}) {
    const page = args.pageId ? await nodeById(args.pageId) : figma.currentPage;
    if (page.type !== 'PAGE') throw new Error('pageId must identify a page');
    await nativeRead('loadAsync', page.id, () => page.loadAsync());
    const boxes = page.children
      .filter((node) => node.visible !== false)
      .map((node) => node.absoluteRenderBounds || node.absoluteBoundingBox)
      .filter((box) => box && box.width > 0 && box.height > 0);
    const value = {
      file: identity(),
      page: describe(page),
      pages: figma.root.children.map(describe),
      revision: bridge.documentRevision,
      backgrounds: safe(page.backgrounds),
      empty: boxes.length === 0,
    };
    if (value.empty) return value;
    const bounds = boxes.reduce(
        (bounds, box) => ({
          left: Math.min(bounds.left, box.x),
          top: Math.min(bounds.top, box.y),
          right: Math.max(bounds.right, box.x + box.width),
          bottom: Math.max(bounds.bottom, box.y + box.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
      ),
      width = bounds.right - bounds.left,
      height = bounds.bottom - bounds.top,
      scale = Math.min(
        1,
        (args.maxDimension ?? 2048) / Math.max(width, height),
      );
    // Figma renders the complete page, including overlaps and connectors. No
    // temporary frames, cloned layers or independently composited exports.
    const bytes = await nativeRead('exportAsync', page.id, () =>
      page.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: scale },
      }),
    );
    bridge.exportFile('preview-canvas.png', bytes, 'image/png');
    return {
      ...value,
      scale,
      bounds: { x: bounds.left, y: bounds.top, width, height },
    };
  }
  async function componentInfo(node) {
    let main = node;
    if (node.type === 'INSTANCE')
      main = await nativeRead('getMainComponentAsync', node.id, () =>
        node.getMainComponentAsync(),
      );
    if (!main || !['COMPONENT', 'COMPONENT_SET'].includes(main.type))
      return null;
    const owner = main.parent?.type === 'COMPONENT_SET' ? main.parent : main;
    return {
      ...describe(main),
      ...read(main, ['key', 'remote', 'description', 'variantProperties']),
      propertyOwner: {
        ...describe(owner),
        ...read(owner, ['key', 'componentPropertyDefinitions']),
      },
    };
  }
  function aliases(value, ids) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string')
      ids.add(value.id);
    else for (const child of Object.values(value)) aliases(child, ids);
  }
  async function references(variableIds, styleIds) {
    const variables = [],
      collections = [],
      styles = [],
      seen = new Set();
    if (styleIds.size > 200)
      issues.push({ field: 'styles', reason: 'reference limit reached' });
    for (const id of [...styleIds].slice(0, 200)) {
      try {
        const style = await nativeRead('getStyleByIdAsync', id, () =>
          figma.getStyleByIdAsync(id),
        );
        if (!style) throw new Error('Style not available');
        const value = read(style, [
          'id',
          'name',
          'key',
          'type',
          'remote',
          'description',
          'paints',
          'effects',
          'fontName',
          'fontSize',
          'lineHeight',
          'letterSpacing',
          'paragraphSpacing',
          'textCase',
          'textDecoration',
          'boundVariables',
        ]);
        styles.push(value);
        aliases(value, variableIds);
      } catch (error) {
        issues.push({
          field: 'style',
          id,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
    const localVariables = new Map(),
      localCollections = new Map();
    if (variableIds.size)
      for (const [method, index] of [
        ['getLocalVariablesAsync', localVariables],
        ['getLocalVariableCollectionsAsync', localCollections],
      ]) {
        try {
          for (const value of await nativeRead(method, figma.root.id, () =>
            figma.variables[method](),
          ))
            index.set(value.id, value);
        } catch (error) {
          issues.push({
            field: 'localReferences',
            method,
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
    let attempted = 0;
    for (const id of variableIds) {
      if (attempted++ >= 200) {
        issues.push({ field: 'variables', reason: 'reference limit reached' });
        break;
      }
      try {
        const variable =
          localVariables.get(id) ||
          (await nativeRead('getVariableByIdAsync', id, () =>
            figma.variables.getVariableByIdAsync(id),
          ));
        if (!variable) throw new Error('Variable not available');
        variables.push(
          read(variable, [
            'id',
            'name',
            'key',
            'remote',
            'description',
            'resolvedType',
            'variableCollectionId',
            'valuesByMode',
            'scopes',
            'codeSyntax',
          ]),
        );
        aliases(variable.valuesByMode, variableIds);
        if (!seen.has(variable.variableCollectionId)) {
          seen.add(variable.variableCollectionId);
          const collection =
            localCollections.get(variable.variableCollectionId) ||
            (await nativeRead(
              'getVariableCollectionByIdAsync',
              variable.variableCollectionId,
              () =>
                figma.variables.getVariableCollectionByIdAsync(
                  variable.variableCollectionId,
                ),
            ));
          if (collection)
            collections.push(
              read(collection, [
                'id',
                'name',
                'key',
                'remote',
                'defaultModeId',
                'modes',
              ]),
            );
        }
      } catch (error) {
        issues.push({
          field: 'variable',
          id,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
    return { variables, collections, styles };
  }
  async function context(args = {}) {
    const depth = args.depth ?? 3,
      maxNodes = args.maxNodes ?? 200;
    const includeCSS = args.includeCSS ?? figma.editorType === 'figma';
    let visited = 0,
      truncated = false;
    const keys = [
      'visible',
      'locked',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'absoluteBoundingBox',
      'absoluteTransform',
      'opacity',
      'blendMode',
      'fills',
      'strokes',
      'strokeWeight',
      'strokeAlign',
      'dashPattern',
      'effects',
      'cornerRadius',
      'topLeftRadius',
      'topRightRadius',
      'bottomLeftRadius',
      'bottomRightRadius',
      'constraints',
      'clipsContent',
      'layoutMode',
      'layoutWrap',
      'primaryAxisSizingMode',
      'counterAxisSizingMode',
      'primaryAxisAlignItems',
      'counterAxisAlignItems',
      'counterAxisAlignContent',
      'paddingTop',
      'paddingBottom',
      'paddingLeft',
      'paddingRight',
      'itemSpacing',
      'counterAxisSpacing',
      'layoutAlign',
      'layoutGrow',
      'layoutPositioning',
      'layoutSizingHorizontal',
      'layoutSizingVertical',
      'minWidth',
      'maxWidth',
      'minHeight',
      'maxHeight',
      'characters',
      'fontName',
      'fontSize',
      'textAlignHorizontal',
      'textAlignVertical',
      'textAutoResize',
      'lineHeight',
      'letterSpacing',
      'paragraphSpacing',
      'textCase',
      'textDecoration',
      'fillStyleId',
      'strokeStyleId',
      'effectStyleId',
      'textStyleId',
      'boundVariables',
      'explicitVariableModes',
      'resolvedVariableModes',
      'componentProperties',
      'variantProperties',
      'reactions',
      'exportSettings',
      'isMask',
      'maskType',
      'vectorPaths',
      'componentPropertyReferences',
      'shapeType',
      'connectorStart',
      'connectorEnd',
      'connectorLineType',
      'connectorStartStrokeCap',
      'connectorEndStrokeCap',
      'authorVisible',
      'isWideWidth',
      'sectionContentsHidden',
      'isSkippedSlide',
    ];
    const variableIds = new Set(),
      styleIds = new Set(),
      assets = new Map();
    function collect(value, nodeId) {
      aliases(value.boundVariables, variableIds);
      for (const key of [
        'fillStyleId',
        'strokeStyleId',
        'effectStyleId',
        'textStyleId',
      ])
        if (typeof value[key] === 'string' && value[key])
          styleIds.add(value[key]);
      for (const paint of [
        ...(Array.isArray(value.fills) ? value.fills : []),
        ...(Array.isArray(value.strokes) ? value.strokes : []),
      ]) {
        aliases(paint.boundVariables, variableIds);
        if (paint.type === 'IMAGE' && paint.imageHash) {
          const asset = assets.get(paint.imageHash) || {
            imageHash: paint.imageHash,
            nodeIds: [],
          };
          if (!asset.nodeIds.includes(nodeId)) asset.nodeIds.push(nodeId);
          assets.set(paint.imageHash, asset);
        }
      }
    }
    async function project(node, level) {
      if (visited >= maxNodes) {
        truncated = true;
        return null;
      }
      visited++;
      const result = { ...describe(node), ...read(node, keys) };
      collect(result, node.id);
      if (
        node.type === 'TEXT' &&
        typeof node.getStyledTextSegments === 'function'
      ) {
        try {
          result.textSegments = safe(
            node.getStyledTextSegments(
              [
                'fontName',
                'fontSize',
                'fills',
                'textCase',
                'textDecoration',
                'letterSpacing',
                'lineHeight',
                'textStyleId',
              ],
              0,
              Math.min(node.characters.length, 8192),
            ),
          );
        } catch (error) {
          issues.push({
            nodeId: node.id,
            field: 'textSegments',
            error: String(error.message || error).slice(0, 200),
          });
        }
        for (const segment of result.textSegments || [])
          collect(segment, node.id);
      } else if (
        'text' in node &&
        typeof node.text?.getStyledTextSegments === 'function'
      ) {
        try {
          result.text = read(node.text, [
            'characters',
            'fontName',
            'fontSize',
            'fills',
            'textAlignHorizontal',
            'textAlignVertical',
            'lineHeight',
            'letterSpacing',
            'textCase',
            'textDecoration',
            'textStyleId',
            'boundVariables',
          ]);
          result.text.segments = safe(
            node.text.getStyledTextSegments(
              ['fontName', 'fontSize', 'fills', 'textStyleId'],
              0,
              Math.min(node.text.characters.length, 8192),
            ),
          );
          collect(result.text, node.id);
          for (const segment of result.text.segments) collect(segment, node.id);
        } catch (error) {
          issues.push({
            nodeId: node.id,
            field: 'text',
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
      if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(node.type)) {
        try {
          const info = await componentInfo(node);
          if (info) result.component = info;
        } catch (error) {
          issues.push({
            nodeId: node.id,
            field: 'component',
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
      if (
        node.type === 'SLIDE' &&
        typeof node.getSlideTransition === 'function'
      ) {
        try {
          result.slideTransition = safe(node.getSlideTransition());
        } catch (error) {
          issues.push({
            nodeId: node.id,
            field: 'slideTransition',
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
      if (includeCSS && typeof node.getCSSAsync === 'function') {
        try {
          result.css = safe(
            await nativeRead('getCSSAsync', node.id, () => node.getCSSAsync()),
          );
        } catch (error) {
          issues.push({
            nodeId: node.id,
            field: 'css',
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
      if ('children' in node) {
        const children = node.children;
        result.childCount = children.length;
        if (level < depth) {
          result.children = [];
          for (const child of children) {
            const value = await project(child, level + 1);
            if (!value) break;
            result.children.push(value);
          }
        } else if (children.length) {
          truncated = true;
          result.childrenTruncated = true;
        }
        if (result.children && result.children.length < children.length)
          result.childrenTruncated = true;
      }
      return result;
    }
    const selected = await roots(args),
      nodes = [];
    for (const node of selected) {
      const value = await project(node, 0);
      if (!value) break;
      nodes.push(value);
    }
    const resources =
      args.resolveReferences === false
        ? null
        : await references(variableIds, styleIds);
    let preview = null;
    if (
      args.includeScreenshot !== false &&
      selected.length === 1 &&
      selected[0].type !== 'PAGE' &&
      typeof selected[0].exportAsync === 'function'
    ) {
      try {
        preview = await exportNode({
          nodeId: selected[0].id,
          maxDimension: args.maxDimension ?? 1600,
        });
      } catch (error) {
        issues.push({
          field: 'preview',
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
    return {
      file: identity(),
      nodes,
      visited,
      truncated,
      limits: { depth, maxNodes, textCharacters: 8192, arrayItems: 64 },
      resources,
      assets: [...assets.values()],
      preview,
      sparse: truncated || issues.length > 0,
      issues: issues.slice(0, 100),
      next: truncated
        ? 'Request visible child node IDs before implementing; the screenshot is a visual reference, not a code asset.'
        : undefined,
    };
  }
  async function exportNode(args = {}) {
    const node = args.nodeId
      ? await nodeById(args.nodeId)
      : figma.currentPage.selection.length === 1
        ? figma.currentPage.selection[0]
        : null;
    if (!node || typeof node.exportAsync !== 'function' || node.type === 'PAGE')
      throw new Error(
        'Choose one exportable node with nodeId or a single selection.',
      );
    const format = args.format || 'PNG';
    const settings = { format };
    if (format === 'PNG' || format === 'JPG') {
      const box = node.absoluteRenderBounds || node.absoluteBoundingBox || node;
      const dimension = Math.max(box.width || 1, box.height || 1);
      const maxDimension = args.maxDimension ?? 1600;
      settings.constraint = {
        type: 'SCALE',
        value: Math.min(args.scale ?? 1, maxDimension / dimension),
      };
    }
    if (format === 'SVG')
      for (const key of ['svgIdAttribute', 'svgOutlineText'])
        if (args[key] !== undefined) settings[key] = args[key];
    if (['MP4', 'GIF', 'WEBM'].includes(format)) {
      if (node.type !== 'FRAME' || node.parent?.type !== 'PAGE')
        throw new Error('Video export requires an animated top-level frame.');
      const validFPS =
        format === 'GIF' ? [8, 12, 15, 24, 30] : [12, 24, 30, 60];
      if (!validFPS.includes(args.fps ?? (format === 'GIF' ? 12 : 24)))
        throw new Error('Unsupported native video fps for ' + format);
      settings.fps = args.fps ?? (format === 'GIF' ? 12 : 24);
      settings.constraint = {
        type: 'WIDTH',
        value: Math.max(
          1,
          Math.round(Math.min(node.width, args.maxDimension ?? 1600)),
        ),
      };
      if (format === 'GIF') settings.loopCount = args.loopCount ?? 0;
      else settings.quality = args.quality ?? 'MEDIUM';
    }
    const bytes = await nativeRead('exportAsync', node.id, () =>
        node.exportAsync(settings),
      ),
      name =
        (args.preview ? 'preview-' : 'node-') +
        node.id.replace(/[^A-Za-z0-9_-]/g, '-') +
        '.' +
        format.toLowerCase();
    const mimeType = {
      PNG: 'image/png',
      JPG: 'image/jpeg',
      SVG: 'image/svg+xml',
      PDF: 'application/pdf',
      MP4: 'video/mp4',
      GIF: 'image/gif',
      WEBM: 'video/webm',
    }[format];
    bridge.exportFile(name, bytes, mimeType);
    return {
      file: identity(),
      node: describe(node),
      format,
      settings,
      bytes: bytes.length,
    };
  }
  async function variables(args = {}) {
    const limit = args.limit ?? 200,
      offset = args.offset ?? 0;
    const collections =
      await figma.variables.getLocalVariableCollectionsAsync();
    const all = await figma.variables.getLocalVariablesAsync(args.type);
    const filtered = all.filter(
      (variable) =>
        !args.collectionId ||
        variable.variableCollectionId === args.collectionId,
    );
    const selectedCollections = args.collectionId
      ? collections.filter((collection) => collection.id === args.collectionId)
      : collections;
    return {
      file: identity(),
      collections: selectedCollections
        .slice(0, 100)
        .map((collection) =>
          read(collection, [
            'id',
            'name',
            'key',
            'remote',
            'defaultModeId',
            'modes',
          ]),
        ),
      variables: filtered
        .slice(offset, offset + limit)
        .map((variable) =>
          read(variable, [
            'id',
            'name',
            'key',
            'remote',
            'description',
            'resolvedType',
            'variableCollectionId',
            'valuesByMode',
            'scopes',
            'hiddenFromPublishing',
            'codeSyntax',
          ]),
        ),
      total: filtered.length,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
      collectionCount: selectedCollections.length,
      truncated: selectedCollections.length > 100 || issues.length > 0,
      issues: issues.slice(0, 100),
      scope:
        'Local variables and collections only. Cloud libraries require an authorized library API.',
    };
  }
  async function foundNode(node) {
    const info = {
      ...describe(node),
      parentId: node.parent?.id,
      ...read(node, ['key', 'remote', 'description', 'variantProperties']),
    };
    if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(node.type))
      info.component = await componentInfo(node);
    return info;
  }
  async function findNodes(args = {}, project = foundNode) {
    const issueStart = issues.length;
    // Search is independent of selection. Load pages only when traversal reaches them.
    const selected =
      args.scope === 'file'
        ? [...figma.root.children]
        : args.rootId || args.pageId
          ? [await nodeById(args.rootId || args.pageId)]
          : [figma.currentPage];
    if (args.pageId && selected[0].type !== 'PAGE')
      throw new Error('pageId must identify a page');
    const limit = args.limit ?? 100,
      maxVisited = args.maxVisited ?? 5000;
    let pending = selected.slice().reverse();
    const matches = [];
    const criteria = JSON.stringify({
      scope: args.scope || 'page',
      roots: selected.map((node) => node.id),
      query: args.query || '',
      types: args.types || [],
    });
    if (args.cursor) {
      const cursor = JSON.parse(args.cursor);
      if (
        cursor.criteria !== criteria ||
        cursor.documentId !== (bridge.documentId || null) ||
        cursor.revision !== (bridge.documentRevision ?? null) ||
        !Array.isArray(cursor.pending) ||
        cursor.pending.some((id) => typeof id !== 'string') ||
        cursor.pending.length > 20000
      )
        throw new Error(
          'Search cursor expired or targets another query; restart the search.',
        );
      pending = cursor.pending;
    }
    let visited = 0;
    const text = (args.query || '').toLocaleLowerCase();
    while (pending.length && visited < maxVisited && matches.length < limit) {
      const entry = pending.pop();
      const node = typeof entry === 'string' ? await nodeById(entry) : entry;
      visited++;
      if (node.type === 'PAGE')
        await nativeRead('loadAsync', node.id, () => node.loadAsync());
      if (
        (!args.types?.length || args.types.includes(node.type)) &&
        (!text || node.name.toLocaleLowerCase().includes(text))
      ) {
        matches.push(await project(node));
      }
      if ('children' in node) {
        const children = node.children;
        for (let i = children.length - 1; i >= 0; i--)
          pending.push(children[i]);
      }
    }
    const cursor =
      pending.length <= 20000 && pending.length
        ? JSON.stringify({
            criteria,
            documentId: bridge.documentId || null,
            revision: bridge.documentRevision ?? null,
            pending: pending.map((node) =>
              typeof node === 'string' ? node : node.id,
            ),
          })
        : null;
    const resumable = !cursor || cursor.length <= 1048576;
    return complete(
      {
        file: identity(),
        nodes: matches,
        visited,
        traversalTruncated: pending.length > 0,
        truncated: pending.length > 0,
        limits: { limit, maxVisited },
        cursor: resumable ? cursor : null,
        next: pending.length
          ? cursor && resumable
            ? 'Continue with this cursor and the same query, or narrow the root.'
            : 'Pending nodes exceed the cursor budget; narrow the root before continuing.'
          : undefined,
      },
      issueStart,
    );
  }
  async function styles() {
    const result = [];
    for (const [method, kind] of [
      ['getLocalPaintStylesAsync', 'PAINT'],
      ['getLocalTextStylesAsync', 'TEXT'],
      ['getLocalEffectStylesAsync', 'EFFECT'],
      ['getLocalGridStylesAsync', 'GRID'],
    ]) {
      if (typeof figma[method] === 'function')
        for (const style of await nativeRead(method, figma.root.id, () =>
          figma[method](),
        ))
          result.push({
            kind,
            ...read(style, [
              'id',
              'key',
              'name',
              'description',
              'remote',
              'paints',
              'effects',
              'fontName',
              'fontSize',
              'lineHeight',
              'letterSpacing',
              'layoutGrids',
              'boundVariables',
            ]),
          });
    }
    return result;
  }
  async function designSystem(args = {}) {
    if (
      args.cursor &&
      (!args.queries ||
        args.queries.length !== 1 ||
        args.queries[0].entity !== 'component')
    )
      throw new Error(
        'Continue a component cursor with exactly its original component query',
      );
    const queries = args.queries || [{ entity: 'component', query: '' }];
    const localVariables = queries.some((item) => item.entity === 'variable')
      ? await nativeRead('getLocalVariablesAsync', figma.root.id, () =>
          figma.variables.getLocalVariablesAsync(),
        )
      : [];
    const localStyles = queries.some((item) => item.entity === 'style')
      ? await styles()
      : [];
    const libraries = [],
      libraryVariables = [];
    if (args.includeLibraries) {
      try {
        const available = await nativeRead(
          'getAvailableLibraryVariableCollectionsAsync',
          figma.root.id,
          () => figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(),
        );
        libraries.push(
          ...available.map((item) =>
            read(item, ['name', 'key', 'libraryName']),
          ),
        );
        if (args.libraryCollectionKey) {
          if (!available.some((item) => item.key === args.libraryCollectionKey))
            throw new Error(
              'Library is not enabled or accessible in this file',
            );
          libraryVariables.push(
            ...(await nativeRead(
              'getVariablesInLibraryCollectionAsync',
              args.libraryCollectionKey,
              () =>
                figma.teamLibrary.getVariablesInLibraryCollectionAsync(
                  args.libraryCollectionKey,
                ),
            )),
          );
        }
      } catch (error) {
        issues.push({
          field: 'library',
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
    const results = [];
    for (const item of queries) {
      const text = item.query.toLocaleLowerCase(),
        limit = item.limit ?? 100;
      if (item.entity === 'component')
        results.push({
          query: item,
          ...(await findNodes({
            ...args,
            query: item.query,
            limit,
            types: ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'],
          })),
        });
      else {
        const source =
          item.entity === 'variable'
            ? [...localVariables, ...libraryVariables]
            : localStyles;
        const matches = source.filter((value) =>
          value.name.toLocaleLowerCase().includes(text),
        );
        results.push({
          query: item,
          items: matches
            .slice(0, limit)
            .map((value) =>
              read(value, [
                'id',
                'key',
                'name',
                'kind',
                'type',
                'remote',
                'resolvedType',
                'variableCollectionId',
                'valuesByMode',
                'scopes',
                'codeSyntax',
                'paints',
                'effects',
                'fontName',
                'fontSize',
                'lineHeight',
                'letterSpacing',
              ]),
            ),
          total: matches.length,
          truncated: matches.length > limit,
        });
      }
    }
    return {
      file: identity(),
      results,
      libraries,
      issues: issues.slice(0, 100),
      scope:
        'Current file assets, main components already used, and enabled variable libraries. Public Plugin API cannot enumerate every cloud component library or enable libraries.',
    };
  }
  async function downloadAssets(args = {}) {
    const selected = await roots(args),
      rendered = [],
      sources = [],
      vectorAssets = [],
      hashes = new Set(),
      vectorIds = new Set(),
      seenNodes = new Set();
    let visited = 0,
      rawImagesTruncated = false,
      vectorsTruncated = false;
    const mime = {
      PNG: 'image/png',
      JPG: 'image/jpeg',
      SVG: 'image/svg+xml',
      PDF: 'application/pdf',
    };
    for (const node of selected) {
      if (
        args.includeRender !== false &&
        node.type !== 'PAGE' &&
        typeof node.exportAsync === 'function'
      ) {
        const box =
          node.absoluteRenderBounds || node.absoluteBoundingBox || node;
        const scale = Math.min(
          args.scale ?? 1,
          (args.maxDimension ?? 4096) /
            Math.max(box.width || 1, box.height || 1),
        );
        const fallback = {
          format: args.format || 'PNG',
          ...(['PNG', 'JPG'].includes(args.format || 'PNG')
            ? { constraint: { type: 'SCALE', value: scale } }
            : {}),
        };
        // Explicit requested format/scale overrides the configured exports.
        const settings =
          args.format || args.scale !== undefined
            ? [fallback]
            : node.exportSettings?.length
              ? node.exportSettings
              : [fallback];
        for (const [index, configured] of settings.entries()) {
          const setting = { ...configured };
          if (setting.format === 'SVG')
            for (const key of ['svgIdAttribute', 'svgOutlineText'])
              if (args[key] !== undefined) setting[key] = args[key];
          if (!mime[setting.format]) continue;
          const bytes = await nativeRead('exportAsync', node.id, () =>
              node.exportAsync(setting),
            ),
            name =
              'render-' +
              node.id.replace(/[^A-Za-z0-9_-]/g, '-') +
              '-' +
              index +
              '.' +
              setting.format.toLowerCase();
          bridge.exportFile(name, bytes, mime[setting.format]);
          rendered.push({
            nodeId: node.id,
            name,
            settings: safe(setting),
            bytes: bytes.length,
          });
        }
      }
      if (args.includeRaw === false && args.includeVectors === false) continue;
      const pending = [node];
      while (pending.length && visited < (args.maxVisited ?? 20000)) {
        const current = pending.pop();
        if (seenNodes.has(current.id)) continue;
        seenNodes.add(current.id);
        visited++;
        if (current.type === 'PAGE') await current.loadAsync();
        if (
          args.includeVectors !== false &&
          ['VECTOR', 'BOOLEAN_OPERATION'].includes(current.type) &&
          !vectorIds.has(current.id)
        ) {
          let parent = current.parent,
            contained = false;
          while (parent && parent.type !== 'PAGE') {
            if (parent.type === 'BOOLEAN_OPERATION') {
              contained = true;
              break;
            }
            parent = parent.parent;
          }
          if (!contained) {
            vectorIds.add(current.id);
            if (vectorAssets.length >= (args.maxVectorAssets ?? 20))
              vectorsTruncated = true;
            else {
              const settings = { format: 'SVG' };
              for (const key of ['svgIdAttribute', 'svgOutlineText'])
                if (args[key] !== undefined) settings[key] = args[key];
              const bytes = await nativeRead('exportAsync', current.id, () =>
                current.exportAsync(settings),
              );
              const name =
                'vector-' + current.id.replace(/[^A-Za-z0-9_-]/g, '-') + '.svg';
              bridge.exportFile(name, bytes, 'image/svg+xml');
              vectorAssets.push({
                nodeId: current.id,
                name,
                bytes: bytes.length,
              });
            }
          }
        }
        const paints = [];
        for (const property of ['fills', 'strokes']) {
          if (property in current && Array.isArray(current[property]))
            paints.push(...current[property]);
        }
        if (
          current.type === 'TEXT' &&
          typeof current.getStyledTextSegments === 'function'
        ) {
          for (const segment of current.getStyledTextSegments(['fills']))
            if (Array.isArray(segment.fills)) paints.push(...segment.fills);
        }
        if (args.includeRaw !== false)
          for (const paint of paints) {
            if (
              paint.type !== 'IMAGE' ||
              !paint.imageHash ||
              hashes.has(paint.imageHash)
            )
              continue;
            hashes.add(paint.imageHash);
            if (sources.length >= (args.maxRawImages ?? 20)) {
              rawImagesTruncated = true;
              continue;
            }
            const image = figma.getImageByHash(paint.imageHash);
            if (!image) {
              issues.push({
                field: 'image',
                imageHash: paint.imageHash,
                error: 'Source image unavailable',
              });
              continue;
            }
            const bytes = await nativeRead(
              'getBytesAsync',
              paint.imageHash,
              () => image.getBytesAsync(),
            );
            const kind =
              bytes[0] === 137 && bytes[1] === 80
                ? ['png', 'image/png']
                : bytes[0] === 255 && bytes[1] === 216
                  ? ['jpg', 'image/jpeg']
                  : bytes[0] === 71 && bytes[1] === 73
                    ? ['gif', 'image/gif']
                    : bytes[0] === 82 && bytes[8] === 87
                      ? ['webp', 'image/webp']
                      : ['bin', 'application/octet-stream'];
            const name = 'source-' + sources.length + '.' + kind[0];
            bridge.exportFile(name, bytes, kind[1]);
            sources.push({
              name,
              imageHash: paint.imageHash,
              nodeId: current.id,
              bytes: bytes.length,
              mimeType: kind[1],
            });
          }
        if ('children' in current) pending.push(...current.children);
      }
      if (pending.length) {
        if (args.includeRaw !== false) rawImagesTruncated = true;
        if (args.includeVectors !== false) vectorsTruncated = true;
      }
    }
    return {
      file: identity(),
      rendered,
      sources,
      vectorAssets,
      rawImagesTruncated,
      vectorsTruncated,
      visited,
      issues: issues.slice(0, 100),
    };
  }
  async function motion(args = {}) {
    const found = await findNodes(
      {
        ...args,
        rootId: args.nodeId || args.rootId,
        query: '',
        limit: args.maxNodes ?? 200,
      },
      (node) => {
        const data = read(node, [
          'animations',
          'manualKeyframeTracks',
          'animationStyles',
          'timelines',
          'reactions',
        ]);
        return Object.values(data).some((value) =>
          Array.isArray(value)
            ? value.length
            : value && Object.keys(value).length,
        )
          ? { ...describe(node), ...data }
          : null;
      },
    );
    let availableStyles = [];
    try {
      availableStyles = safe(figma.motion.figmaAnimationStyles());
    } catch (error) {
      issues.push({
        field: 'motion',
        error: String(error.message || error).slice(0, 200),
      });
    }
    return {
      file: identity(),
      nodes: found.nodes.filter(Boolean),
      availableStyles,
      cursor: found.cursor,
      truncated: found.truncated,
      issues: issues.slice(0, 100),
      units:
        'Native timeline seconds; easing and typed values are returned without guessed code conversion.',
    };
  }
  async function importAssets(args = {}) {
    const names = args.assetNames;
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.length > 20 ||
      names.some((name) => !bridge.assets[name])
    )
      throw new Error('Choose 1–20 uploaded assets');
    if (
      args.nodeId &&
      (names.length !== 1 || names[0].toLowerCase().endsWith('.svg'))
    )
      throw new Error(
        'An image-fill replacement requires exactly one raster asset',
      );
    if (
      args.nodeId &&
      ['x', 'y', 'width', 'height'].some((key) => args[key] !== undefined)
    )
      throw new Error(
        'An image-fill replacement preserves node position and size; omit x, y, width and height',
      );
    if (figma.editorType === 'slides' && !args.nodeId && !args.parentId)
      throw new Error(
        'Choose the destination slide with parentId before importing assets',
      );
    for (const name of names) {
      const method = name.toLowerCase().endsWith('.svg')
        ? 'createNodeFromSvg'
        : 'createImage';
      if (
        typeof figma[method] !== 'function' ||
        (method === 'createImage' &&
          !args.nodeId &&
          typeof figma.createRectangle !== 'function')
      )
        throw new Error(
          method +
            ' is not available in this editor; native asset import is unsupported here',
        );
    }
    const parent = args.parentId
      ? await nodeById(args.parentId)
      : figma.currentPage;
    if (!args.nodeId && typeof parent.appendChild !== 'function')
      throw new Error('parentId must accept child nodes');
    const target = args.nodeId ? await nodeById(args.nodeId) : null;
    if (target && !('fills' in target))
      throw new Error('Target node cannot accept image fills');
    let fills = [],
      fillIndex;
    if (target && !args.replaceAllFills) {
      if (!Array.isArray(target.fills))
        throw new Error(
          'Target fills are mixed; choose replaceAllFills explicitly or edit a specific text range',
        );
      fills = [...target.fills];
      const imageIndices = fills.flatMap((paint, index) =>
        paint.type === 'IMAGE' ? [index] : [],
      );
      fillIndex =
        args.fillIndex ??
        (imageIndices.length === 1
          ? imageIndices[0]
          : fills.length <= 1
            ? 0
            : undefined);
      if (fillIndex === undefined)
        throw new Error(
          'Choose fillIndex or replaceAllFills for multiple fills',
        );
      if (
        fillIndex < 0 ||
        (fillIndex >= fills.length && !(fillIndex === 0 && fills.length === 0))
      )
        throw new Error('fillIndex is outside the target fills');
    }
    if (args.fillIndex !== undefined && (!target || args.replaceAllFills))
      throw new Error(
        'fillIndex requires a target and cannot be combined with replaceAllFills',
      );
    const assets = [];
    const spacing = args.spacing ?? 32;
    let x =
      args.x ??
      Math.max(
        0,
        ...(parent.children || []).map(
          (node) => (node.x || 0) + (node.width || 0),
        ),
      ) + spacing;
    for (const name of names) {
      let node, size, imageHash;
      if (name.toLowerCase().endsWith('.svg')) {
        node = figma.createNodeFromSvg(bridge.assetText(name));
        size = { width: node.width, height: node.height };
      } else {
        const image = figma.createImage(bridge.assets[name]);
        size = target ? null : await image.getSizeAsync();
        imageHash = image.hash;
        node = target || figma.createRectangle();
      }
      log({
        assetName: name,
        nodeId: node.id,
        action: target ? 'replacing_image_fill' : 'created',
      });
      if (!target) {
        node.name = name;
        parent.appendChild(node);
        const width =
          args.width ??
          (args.height === undefined
            ? size.width
            : (size.width * args.height) / size.height);
        const height =
          args.height ??
          (args.width === undefined
            ? size.height
            : (size.height * args.width) / size.width);
        if (width !== node.width || height !== node.height)
          node.resize(width, height);
        node.x = x;
        node.y = args.y ?? 0;
        x += node.width + spacing;
      }
      if (imageHash) {
        const previous =
          target && !args.replaceAllFills && fills[fillIndex]?.type === 'IMAGE'
            ? fills[fillIndex]
            : {};
        const paint = {
          ...previous,
          type: 'IMAGE',
          imageHash,
          scaleMode: args.scaleMode ?? previous.scaleMode ?? 'FILL',
        };
        if (target && !args.replaceAllFills) {
          fills[fillIndex] = paint;
          node.fills = fills;
        } else node.fills = [paint];
      }
      assets.push({
        assetName: name,
        nodeId: node.id,
        type: node.type,
        width: node.width,
        height: node.height,
        action: target ? 'image_fill_replaced' : 'created',
        ...(imageHash ? { imageHash } : {}),
      });
    }
    return { file: identity(), assets };
  }
  async function capabilities(args = {}) {
    const api = {},
      node = args.nodeId
        ? await nodeById(args.nodeId)
        : figma.currentPage.selection.length === 1
          ? figma.currentPage.selection[0]
          : null;
    const methods = args.methods || [
      ...[
        'createFrame',
        'createText',
        'createSticky',
        'createShapeWithText',
        'createConnector',
        'createSlide',
        'createSlideRow',
        'createTable',
        'createImage',
        'createNodeFromSvg',
        'importComponentByKeyAsync',
        'importComponentSetByKeyAsync',
        'listAvailableShaders',
        'importShaderById',
        'getSlideGrid',
        'setSlideGrid',
        'createNodeFromJSXAsync',
        'motion.figmaAnimationStyles',
      ].map((key) => 'figma.' + key),
      ...[
        'applyManualKeyframeTrack',
        'removeManualKeyframeTrack',
        'applyAnimationStyle',
        'getTopLevelFrame',
        'exportAsync',
      ].map((key) => 'node.' + key),
    ];
    for (const method of methods) {
      const [root, ...keys] = method.split('.'),
        key = root === 'figma' ? keys.join('.') : method;
      if (root === 'node' && !node) {
        api[key] = null;
        continue;
      }
      try {
        let value = root === 'figma' ? figma : node;
        for (const part of keys) value = value?.[part];
        api[key] = typeof value === 'function';
      } catch (error) {
        api[key] = null;
        issues.push({
          field: method,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
    let shaderLibrary = null,
      motionStyles = null;
    if (api.listAvailableShaders)
      try {
        shaderLibrary = safe(await figma.listAvailableShaders());
      } catch (error) {
        issues.push({
          field: 'shaders',
          error: String(error.message || error).slice(0, 200),
        });
      }
    if (api['motion.figmaAnimationStyles'])
      try {
        motionStyles = safe(figma.motion.figmaAnimationStyles());
      } catch (error) {
        issues.push({
          field: 'motion',
          error: String(error.message || error).slice(0, 200),
        });
      }
    return {
      file: identity(),
      api,
      targetNode: node ? describe(node) : null,
      shaderLibrary,
      motionStyles,
      localMonthlyQuota: null,
      note: 'Method presence is editor-specific and is not proof of plan entitlement. Calls may still reject. Cloud shader/plugin authoring, Weave, Make resources and hosted Code Connect are not supplied by the public local Plugin API.',
    };
  }
  const queries = {
    inspect,
    canvas,
    context,
    exportNode,
    screenshot: (args) => exportNode({ ...args, format: 'PNG', preview: true }),
    variables,
    findNodes,
    components: (args) =>
      findNodes({ ...args, types: ['COMPONENT', 'COMPONENT_SET'] }),
    designSystem,
    downloadAssets,
    importAssets,
    motion,
    capabilities,
  };
  return Object.fromEntries(
    Object.entries(queries).map(([name, query]) => [
      name,
      async (input) => {
        issues.length = 0;
        nativeReads = {};
        try {
          return complete(await query(input));
        } catch (error) {
          // Native exceptions can be immutable handles owned by Figma's VM.
          const failure = new Error(String(error.message || error));
          failure.queryDiagnostics = {
            nativeReads,
            issues: issues.slice(0, 100),
            issueCount: issues.length,
          };
          throw failure;
        }
      },
    ]),
  );
}
if (typeof module !== 'undefined') module.exports = { createDesignQueries };
