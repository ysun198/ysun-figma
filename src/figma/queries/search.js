function createSearchQueries({
  bridge,
  complete,
  componentInfo,
  describe,
  figma,
  identity,
  issues,
  nativeRead,
  nodeById,
  read,
}) {
  async function foundNode(node, includeComponentMetadata) {
    const info = {
      ...describe(node),
      parentId: node.parent?.id,
      ...read(node, ['key', 'remote', 'description', 'variantProperties']),
    };
    if (
      includeComponentMetadata &&
      ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(node.type)
    )
      info.component = await componentInfo(node);
    return info;
  }

  async function searchRoots(args) {
    const selected =
      args.scope === 'file'
        ? [...figma.root.children]
        : args.rootId || args.pageId
          ? [await nodeById(args.rootId || args.pageId)]
          : [figma.currentPage];
    if (args.pageId && selected[0].type !== 'PAGE')
      throw new Error('pageId must identify a page');
    return selected;
  }
  function searchCriteria(args, selected) {
    return JSON.stringify({
      scope: args.scope || 'page',
      roots: selected.map((node) => node.id),
      query: args.query || '',
      types: args.types || [],
      includeStaticTimelines: args.includeStaticTimelines === true,
      includeComponentMetadata: args.includeComponentMetadata === true,
    });
  }
  function pendingNodes(args, criteria, selected) {
    if (!args.cursor) return selected.slice().reverse();
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
    return cursor.pending;
  }
  function matchesNode(node, args, text) {
    const name = text ? read(node, ['name']).name : null;
    return (
      (!args.types?.length || args.types.includes(node.type)) &&
      (!text ||
        (typeof name === 'string' && name.toLocaleLowerCase().includes(text)))
    );
  }
  async function visitNode(entry, args, text, project, pending, matches) {
    const node = typeof entry === 'string' ? await nodeById(entry) : entry;
    if (node.type === 'PAGE')
      await nativeRead('loadAsync', node.id, () => node.loadAsync());
    if (matchesNode(node, args, text)) {
      const match = await project(node);
      if (match) matches.push(match);
    }
    if ('children' in node) {
      const children = node.children;
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
  }
  function continuation(pending, criteria) {
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
    return {
      cursor: resumable ? cursor : null,
      next: pending.length
        ? cursor && resumable
          ? 'Continue with this cursor and the same query, or narrow the root.'
          : 'Pending nodes exceed the cursor budget; narrow the root before continuing.'
        : undefined,
    };
  }
  async function findNodes(
    args = {},
    project = (node) => foundNode(node, args.includeComponentMetadata === true),
  ) {
    const issueStart = issues.length,
      selected = await searchRoots(args);
    const limit = args.limit ?? 100,
      maxVisited = args.maxVisited ?? 5000;
    const criteria = searchCriteria(args, selected),
      pending = pendingNodes(args, criteria, selected),
      matches = [];
    const text = (args.query || '').toLocaleLowerCase();
    let visited = 0;
    while (pending.length && visited < maxVisited && matches.length < limit) {
      const entry = pending.pop();
      visited++;
      try {
        await visitNode(entry, args, text, project, pending, matches);
      } catch (error) {
        issues.push({
          nodeId: typeof entry === 'string' ? entry : entry.id,
          field: 'traversal',
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
    return complete(
      {
        file: identity(),
        nodes: matches,
        visited,
        traversalTruncated: pending.length > 0,
        truncated: pending.length > 0,
        limits: { limit, maxVisited },
        ...continuation(pending, criteria),
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
              'textWrapStyle',
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
            includeComponentMetadata: true,
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
              item.entity === 'style'
                ? value
                : read(value, [
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
  return { foundNode, findNodes, styles, designSystem };
}
module.exports = { createSearchQueries };
