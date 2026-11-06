const contextFields = require('./context-fields.js');
function createInspectionQueries({
  aliases,
  componentInfo,
  describe,
  exportNode,
  figma,
  identity,
  issues,
  nativeRead,
  nodeById,
  read,
  references,
  roots,
  safe,
}) {
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

  async function navigate(args) {
    const page = figma.root.children.find((node) => node.id === args.pageId);
    if (!page) throw new Error('The requested page is not in this file');
    const previousPageId = figma.currentPage.id;
    await figma.setCurrentPageAsync(page);
    const nodeIds = args.nodeIds || (args.nodeId ? [args.nodeId] : null),
      selected = [];
    for (const id of nodeIds || []) {
      const node = await nodeById(id);
      if (node.type === 'PAGE')
        throw new Error('Expected a selectable node: ' + id);
      let owner = node.parent;
      while (owner && owner.type !== 'PAGE') owner = owner.parent;
      if (owner?.id !== page.id)
        throw new Error('Node is on another page: ' + id);
      selected.push(node);
    }
    if (nodeIds) page.selection = selected;
    if (args.zoomToFit && selected.length)
      figma.viewport.scrollAndZoomIntoView(selected);
    return {
      previousPageId,
      page: { id: page.id, name: page.name },
      selection: page.selection.map((node) => node.id),
      viewport: { center: figma.viewport.center, zoom: figma.viewport.zoom },
    };
  }

  function collectReferences(value, nodeId, state) {
    aliases(value, state.variableIds);
    for (const key of [
      'fillStyleId',
      'strokeStyleId',
      'effectStyleId',
      'textStyleId',
      'gridStyleId',
    ])
      if (typeof value[key] === 'string' && value[key])
        state.styleIds.add(value[key]);
    for (const paint of [
      ...(Array.isArray(value.fills) ? value.fills : []),
      ...(Array.isArray(value.strokes) ? value.strokes : []),
    ]) {
      if (paint.type === 'IMAGE' && paint.imageHash) {
        const asset = state.assets.get(paint.imageHash) || {
          imageHash: paint.imageHash,
          nodeIds: [],
        };
        if (!asset.nodeIds.includes(nodeId)) asset.nodeIds.push(nodeId);
        state.assets.set(paint.imageHash, asset);
      }
    }
  }

  function projectGrid(node, result) {
    if (result.layoutMode === 'GRID')
      Object.assign(
        result,
        read(node, [
          'gridRowCount',
          'gridColumnCount',
          'gridRowGap',
          'gridColumnGap',
          'gridRowSizes',
          'gridColumnSizes',
          'gridAutoTracks',
        ]),
      );
    if (node.parent?.layoutMode === 'GRID')
      Object.assign(
        result,
        read(node, [
          'gridRowAnchorIndex',
          'gridColumnAnchorIndex',
          'gridRowSpan',
          'gridColumnSpan',
          'gridChildHorizontalAlign',
          'gridChildVerticalAlign',
        ]),
      );
  }

  function projectText(node, result, state) {
    if (
      ['TEXT', 'TEXT_PATH'].includes(node.type) &&
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
        collectReferences(segment, node.id, state);
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
        collectReferences(result.text, node.id, state);
        for (const segment of result.text.segments)
          collectReferences(segment, node.id, state);
      } catch (error) {
        issues.push({
          nodeId: node.id,
          field: 'text',
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
  }

  async function projectComponent(node, result) {
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
  }

  function projectSlide(node, result) {
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
  }

  function projectTable(node, result, state) {
    if (node.type === 'TABLE') {
      const dimensions = read(node, ['numRows', 'numColumns']);
      result.table = {
        rows: dimensions.numRows,
        columns: dimensions.numColumns,
        cells: [],
      };
      const count = dimensions.numRows * dimensions.numColumns;
      let index = 0;
      for (; index < count && state.visited < state.maxNodes; index++) {
        state.visited++;
        const row = Math.floor(index / dimensions.numColumns),
          column = index % dimensions.numColumns;
        try {
          const cell = node.cellAt(row, column);
          const text = read(cell.text, [
            'characters',
            'fontName',
            'fontSize',
            'fills',
            'textStyleId',
            'boundVariables',
          ]);
          collectReferences(text, node.id, state);
          result.table.cells.push({
            row,
            column,
            ...read(cell, ['width', 'height', 'fills']),
            text,
          });
        } catch (error) {
          result.table.cells.push({ row, column, unavailable: true });
          issues.push({
            nodeId: node.id,
            field: 'table.cells[' + row + ',' + column + ']',
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
      if (index < count) {
        result.table.truncated = true;
        state.truncated = true;
      }
    }
  }

  async function projectCss(node, result, state) {
    if (state.includeCSS && typeof node.getCSSAsync === 'function') {
      const startedAt = Date.now();
      try {
        if (state.cssRemainingMs <= 0)
          throw new Error('Native CSS time budget exhausted');
        result.css = safe(
          await nativeRead(
            'getCSSAsync',
            node.id,
            () => node.getCSSAsync(),
            Math.min(2000, state.cssRemainingMs),
          ),
        );
      } catch (error) {
        issues.push({
          nodeId: node.id,
          field: 'css',
          error: String(error.message || error).slice(0, 200),
        });
      } finally {
        state.cssRemainingMs -= Date.now() - startedAt;
      }
    }
  }

  async function projectChildren(node, result, level, state) {
    if (!('children' in node)) return;

    const children = node.children;
    result.childCount = children.length;
    if (level < state.depth) {
      result.children = [];
      for (const child of children) {
        try {
          const value = await project(child, level + 1, state);
          if (!value) break;
          result.children.push(value);
        } catch (error) {
          issues.push({
            nodeId: child.id,
            field: 'context',
            error: String(error.message || error).slice(0, 200),
          });
        }
      }
    } else if (children.length) {
      state.truncated = true;
      result.childrenTruncated = true;
    }
    if (result.children && result.children.length < children.length)
      result.childrenTruncated = true;
  }
  async function project(node, level, state) {
    if (state.visited >= state.maxNodes) {
      state.truncated = true;
      return null;
    }
    state.visited++;
    const result = describe(node);
    if (result.name === undefined) return { ...result, unavailable: true };
    Object.assign(result, read(node, contextFields));
    projectGrid(node, result);
    collectReferences(result, node.id, state);
    projectText(node, result, state);
    await projectComponent(node, result);
    projectSlide(node, result);
    projectTable(node, result, state);
    await projectCss(node, result, state);
    await projectChildren(node, result, level, state);
    return result;
  }
  async function context(args = {}) {
    const state = {
      depth: args.depth ?? 3,
      maxNodes: args.maxNodes ?? 200,
      includeCSS: args.includeCSS ?? figma.editorType === 'figma',
      cssRemainingMs: 5000,
      visited: 0,
      truncated: false,
      variableIds: new Set(),
      styleIds: new Set(),
      assets: new Map(),
    };
    const selected = await roots(args),
      nodes = [];
    for (const node of selected) {
      const value = await project(node, 0, state);
      if (!value) break;
      nodes.push(value);
    }
    const resources =
      args.resolveReferences === false
        ? null
        : await references(state.variableIds, state.styleIds);
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
      visited: state.visited,
      truncated: state.truncated,
      limits: {
        depth: state.depth,
        maxNodes: state.maxNodes,
        textCharacters: 8192,
        arrayItems: 64,
      },
      resources,
      assets: [...state.assets.values()],
      preview,
      sparse: state.truncated || issues.length > 0,
      issues: issues.slice(0, 100),
      next: state.truncated
        ? 'Request visible child node IDs before implementing; the screenshot is a visual reference, not a code asset.'
        : undefined,
    };
  }

  async function capabilities(args = {}) {
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
        'getCanvasGrid',
        'setCanvasGrid',
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
    const api = {},
      node = !methods.some((method) => method.startsWith('node.'))
        ? null
        : args.nodeId
          ? await nodeById(args.nodeId)
          : figma.currentPage.selection.length === 1
            ? figma.currentPage.selection[0]
            : null;
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
    if (args.includeResources === true && api.listAvailableShaders)
      try {
        shaderLibrary = safe(await figma.listAvailableShaders());
      } catch (error) {
        issues.push({
          field: 'shaders',
          error: String(error.message || error).slice(0, 200),
        });
      }
    if (args.includeResources === true && api['motion.figmaAnimationStyles'])
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
  return { inspect, navigate, context, capabilities };
}
module.exports = { createInspectionQueries };
