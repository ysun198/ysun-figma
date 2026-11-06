function createResourceQueries({
  describe,
  figma,
  identity,
  issues,
  nativeRead,
  read,
}) {
  async function componentInfo(node) {
    let main = node;
    if (node.type === 'INSTANCE')
      main = await nativeRead(
        'getMainComponentAsync',
        node.id,
        () => node.getMainComponentAsync(),
        5000,
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

  async function indexStyles(styleIds) {
    const localStyles = new Map();
    if (!styleIds.size) return localStyles;
    for (const method of [
      'getLocalPaintStylesAsync',
      'getLocalTextStylesAsync',
      'getLocalEffectStylesAsync',
      'getLocalGridStylesAsync',
    ]) {
      if (typeof figma[method] !== 'function') continue;
      try {
        for (const style of await nativeRead(method, figma.root.id, () =>
          figma[method](),
        ))
          if (styleIds.has(style.id)) localStyles.set(style.id, style);
      } catch (error) {
        issues.push({
          field: 'localStyleIndex',
          method,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }

    return localStyles;
  }
  async function indexVariables(needed) {
    const localVariables = new Map(),
      localCollections = new Map();
    if (needed)
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

    return { localVariables, localCollections };
  }
  async function references(variableIds, styleIds) {
    const variables = [],
      collections = [],
      styles = [],
      seen = new Set();
    if (styleIds.size > 200)
      issues.push({ field: 'styles', reason: 'reference limit reached' });
    const localStyles = await indexStyles(styleIds);
    for (const id of [...styleIds].slice(0, 200)) {
      try {
        const style =
          localStyles.get(id) ||
          (await nativeRead(
            'getStyleByIdAsync',
            id,
            () => figma.getStyleByIdAsync(id),
            5000,
          ));
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
          'textWrapStyle',
          'layoutGrids',
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
    const { localVariables, localCollections } = await indexVariables(
      variableIds.size,
    );
    let attempted = 0;
    for (const id of variableIds) {
      if (attempted++ >= 200) {
        issues.push({ field: 'variables', reason: 'reference limit reached' });
        break;
      }
      try {
        const variable =
          localVariables.get(id) ||
          (await nativeRead(
            'getVariableByIdAsync',
            id,
            () => figma.variables.getVariableByIdAsync(id),
            5000,
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
              5000,
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
  return { componentInfo, aliases, references, variables };
}
module.exports = { createResourceQueries };
