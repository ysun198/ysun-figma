function createAssetQueries({
  bridge,
  describe,
  figma,
  identity,
  issues,
  log,
  nativeRead,
  nodeById,
  roots,
  safe,
}) {
  function videoExportSettings(node, args, format) {
    const settings = {};
    if (node.type !== 'FRAME' || node.parent?.type !== 'PAGE')
      throw new Error('Video export requires an animated top-level frame.');
    const validFPS = format === 'GIF' ? [8, 12, 15, 24, 30] : [12, 24, 30, 60];
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

    return settings;
  }
  function exportSettings(node, args, format) {
    const settings = { format };
    if (['PNG', 'JPG'].includes(format)) {
      const box = node.absoluteRenderBounds || node.absoluteBoundingBox || node;
      settings.constraint = {
        type: 'SCALE',
        value: Math.min(
          args.scale ?? 1,
          (args.maxDimension ?? 1600) /
            Math.max(box.width || 1, box.height || 1),
        ),
      };
    }
    if (format === 'SVG') Object.assign(settings, svgOptions(args));
    if (['MP4', 'GIF', 'WEBM'].includes(format))
      Object.assign(settings, videoExportSettings(node, args, format));
    return settings;
  }
  async function exportNode(args = {}) {
    const node = args.nodeId
      ? await nodeById(args.nodeId)
      : figma.currentPage.selection.length === 1
        ? figma.currentPage.selection[0]
        : null;
    if (
      !node ||
      typeof node.exportAsync !== 'function' ||
      (node.type === 'PAGE' && args.format !== 'JSON_REST_V1')
    )
      throw new Error(
        'Choose one exportable node with nodeId or a single selection.',
      );
    const format = args.format || 'PNG';
    const settings = exportSettings(node, args, format);
    let bytes = await nativeRead('exportAsync', node.id, () =>
      node.exportAsync(settings),
    );
    if (format === 'JSON_REST_V1') {
      const text = unescape(encodeURIComponent(JSON.stringify(bytes)));
      bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    }
    const name =
      (args.preview ? 'preview-' : 'node-') +
      node.id.replace(/[^A-Za-z0-9_-]/g, '-') +
      '.' +
      (format === 'JSON_REST_V1' ? 'json' : format.toLowerCase());
    const mimeType = {
      PNG: 'image/png',
      JPG: 'image/jpeg',
      SVG: 'image/svg+xml',
      PDF: 'application/pdf',
      MP4: 'video/mp4',
      GIF: 'image/gif',
      WEBM: 'video/webm',
      JSON_REST_V1: 'application/json',
    }[format];
    bridge.exportFile(name, bytes, mimeType);
    return {
      file: identity(),
      node: describe(node),
      format,
      settings,
      bytes: bytes.length,
      ...(format === 'JSON_REST_V1'
        ? {
            nodeId: node.id,
            name: node.name,
            exportName: name,
            scope:
              'Native REST-shaped node data; not a .fig file or a guaranteed round-trip backup',
          }
        : {}),
    };
  }

  const mime = {
    PNG: 'image/png',
    JPG: 'image/jpeg',
    SVG: 'image/svg+xml',
    PDF: 'application/pdf',
  };
  function svgOptions(args) {
    return Object.fromEntries(
      ['svgIdAttribute', 'svgOutlineText']
        .filter((key) => args[key] !== undefined)
        .map((key) => [key, args[key]]),
    );
  }
  function renderSettings(node, args) {
    const box = node.absoluteRenderBounds || node.absoluteBoundingBox || node;
    const scale = Math.min(
      args.scale ?? 1,
      (args.maxDimension ?? 4096) / Math.max(box.width || 1, box.height || 1),
    );
    const fallback = {
      format: args.format || 'PNG',
      ...(['PNG', 'JPG'].includes(args.format || 'PNG')
        ? { constraint: { type: 'SCALE', value: scale } }
        : {}),
    };
    if (args.format || args.scale !== undefined) return [fallback];
    return node.exportSettings?.length ? node.exportSettings : [fallback];
  }
  async function renderNode(node, args) {
    const rendered = [];
    if (
      args.includeRender === false ||
      node.type === 'PAGE' ||
      typeof node.exportAsync !== 'function'
    )
      return rendered;
    for (const [index, configured] of renderSettings(node, args).entries()) {
      const settings = {
        ...configured,
        ...(configured.format === 'SVG' ? svgOptions(args) : {}),
      };
      if (!mime[settings.format]) continue;
      const bytes = await nativeRead('exportAsync', node.id, () =>
        node.exportAsync(settings),
      );
      const name =
        'render-' +
        node.id.replace(/[^A-Za-z0-9_-]/g, '-') +
        '-' +
        index +
        '.' +
        settings.format.toLowerCase();
      bridge.exportFile(name, bytes, mime[settings.format]);
      rendered.push({
        nodeId: node.id,
        name,
        settings: safe(settings),
        bytes: bytes.length,
      });
    }
    return rendered;
  }
  function insideBoolean(node) {
    for (
      let parent = node.parent;
      parent && parent.type !== 'PAGE';
      parent = parent.parent
    )
      if (parent.type === 'BOOLEAN_OPERATION') return true;
    return false;
  }
  async function collectVector(node, args, state) {
    if (
      args.includeVectors === false ||
      !['VECTOR', 'BOOLEAN_OPERATION'].includes(node.type) ||
      state.vectorIds.has(node.id) ||
      insideBoolean(node)
    )
      return;
    state.vectorIds.add(node.id);
    if (state.vectorAssets.length >= (args.maxVectorAssets ?? 20)) {
      state.vectorsTruncated = true;
      return;
    }
    const settings = { format: 'SVG', ...svgOptions(args) };
    const bytes = await nativeRead('exportAsync', node.id, () =>
      node.exportAsync(settings),
    );
    const name = 'vector-' + node.id.replace(/[^A-Za-z0-9_-]/g, '-') + '.svg';
    bridge.exportFile(name, bytes, 'image/svg+xml');
    state.vectorAssets.push({ nodeId: node.id, name, bytes: bytes.length });
  }
  function imagePaints(node) {
    const paints = [];
    for (const key of ['fills', 'strokes'])
      if (key in node && Array.isArray(node[key])) paints.push(...node[key]);
    if (
      node.type === 'TEXT' &&
      typeof node.getStyledTextSegments === 'function'
    )
      for (const segment of node.getStyledTextSegments(['fills']))
        if (Array.isArray(segment.fills)) paints.push(...segment.fills);
    return paints;
  }
  function imageFormat(bytes) {
    if (bytes[0] === 137 && bytes[1] === 80) return ['png', 'image/png'];
    if (bytes[0] === 255 && bytes[1] === 216) return ['jpg', 'image/jpeg'];
    if (bytes[0] === 71 && bytes[1] === 73) return ['gif', 'image/gif'];
    if (bytes[0] === 82 && bytes[8] === 87) return ['webp', 'image/webp'];
    return ['bin', 'application/octet-stream'];
  }
  async function collectImages(node, args, state) {
    if (args.includeRaw === false) return;
    for (const paint of imagePaints(node)) {
      if (
        paint.type !== 'IMAGE' ||
        !paint.imageHash ||
        state.hashes.has(paint.imageHash)
      )
        continue;
      state.hashes.add(paint.imageHash);
      if (state.sources.length >= (args.maxRawImages ?? 20)) {
        state.rawImagesTruncated = true;
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
      const bytes = await nativeRead('getBytesAsync', paint.imageHash, () =>
        image.getBytesAsync(),
      );
      const [extension, mimeType] = imageFormat(bytes);
      const name = 'source-' + state.sources.length + '.' + extension;
      bridge.exportFile(name, bytes, mimeType);
      state.sources.push({
        name,
        imageHash: paint.imageHash,
        nodeId: node.id,
        bytes: bytes.length,
        mimeType,
      });
    }
  }
  async function downloadAssets(args = {}) {
    const selected = await roots(args);
    const state = {
      rendered: [],
      sources: [],
      vectorAssets: [],
      hashes: new Set(),
      vectorIds: new Set(),
      seenNodes: new Set(),
      visited: 0,
      rawImagesTruncated: false,
      vectorsTruncated: false,
    };
    for (const node of selected) {
      state.rendered.push(...(await renderNode(node, args)));
      if (args.includeRaw === false && args.includeVectors === false) continue;
      const pending = [node];
      while (pending.length && state.visited < (args.maxVisited ?? 20000)) {
        const current = pending.pop();
        if (state.seenNodes.has(current.id)) continue;
        state.seenNodes.add(current.id);
        state.visited++;
        if (current.type === 'PAGE') await current.loadAsync();
        await collectVector(current, args, state);
        await collectImages(current, args, state);
        if ('children' in current) pending.push(...current.children);
      }
      if (pending.length) {
        if (args.includeRaw !== false) state.rawImagesTruncated = true;
        if (args.includeVectors !== false) state.vectorsTruncated = true;
      }
    }
    const {
      rendered,
      sources,
      vectorAssets,
      rawImagesTruncated,
      vectorsTruncated,
      visited,
    } = state;
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
  function validateImport(args) {
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
          typeof figma.createRectangle !== 'function' &&
          typeof figma.createFrame !== 'function')
      )
        throw new Error(
          method +
            ' is not available in this editor; native asset import is unsupported here',
        );
    }
    return names;
  }
  function imageFillTarget(target, args) {
    if (args.fillIndex !== undefined && (!target || args.replaceAllFills))
      throw new Error(
        'fillIndex requires a target and cannot be combined with replaceAllFills',
      );
    if (!target || args.replaceAllFills)
      return { fills: [], fillIndex: undefined };
    if (!Array.isArray(target.fills))
      throw new Error(
        'Target fills are mixed; choose replaceAllFills explicitly or edit a specific text range',
      );
    const fills = [...target.fills],
      images = fills.flatMap((paint, index) =>
        paint.type === 'IMAGE' ? [index] : [],
      );
    const fillIndex =
      args.fillIndex ??
      (images.length === 1 ? images[0] : fills.length <= 1 ? 0 : undefined);
    if (fillIndex === undefined)
      throw new Error('Choose fillIndex or replaceAllFills for multiple fills');
    if (
      fillIndex < 0 ||
      (fillIndex >= fills.length && !(fillIndex === 0 && fills.length === 0))
    )
      throw new Error('fillIndex is outside the target fills');
    return { fills, fillIndex };
  }
  async function prepareImport(args) {
    const parent = args.parentId
      ? await nodeById(args.parentId)
      : figma.currentPage;
    if (!args.nodeId && typeof parent.appendChild !== 'function')
      throw new Error('parentId must accept child nodes');
    const target = args.nodeId ? await nodeById(args.nodeId) : null;
    if (target && !('fills' in target))
      throw new Error('Target node cannot accept image fills');
    return { parent, target, ...imageFillTarget(target, args) };
  }
  async function createAsset(name, target) {
    if (name.toLowerCase().endsWith('.svg')) {
      const node = figma.createNodeFromSvg(bridge.assetText(name));
      return { node, size: { width: node.width, height: node.height } };
    }
    const image = figma.createImage(bridge.assets[name]);
    const size = target ? null : await image.getSizeAsync();
    const node =
      target ||
      (typeof figma.createRectangle === 'function'
        ? figma.createRectangle()
        : figma.createFrame());
    return { node, size, imageHash: image.hash };
  }
  function placeAsset(node, name, size, args, parent, x) {
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
  }
  function applyImageFill(node, imageHash, args, { target, fills, fillIndex }) {
    if (!imageHash) return;
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
  async function importAssets(args = {}) {
    const names = validateImport(args),
      destination = await prepareImport(args);
    const { parent, target } = destination,
      assets = [],
      spacing = args.spacing ?? 32;
    let x =
      args.x ??
      Math.max(
        0,
        ...(parent.children || []).map(
          (node) => (node.x || 0) + (node.width || 0),
        ),
      ) + spacing;
    for (const name of names) {
      const { node, size, imageHash } = await createAsset(name, target);
      log({
        assetName: name,
        nodeId: node.id,
        action: target ? 'replacing_image_fill' : 'created',
      });
      if (!target) {
        placeAsset(node, name, size, args, parent, x);
        x += node.width + spacing;
      }
      applyImageFill(node, imageHash, args, destination);
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
  return { exportNode, downloadAssets, importAssets };
}
module.exports = { createAssetQueries };
