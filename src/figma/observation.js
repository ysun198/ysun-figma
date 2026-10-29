// Native, field-level observations for conditional edits. No locks or persistent state.
/* exported nativeObservation */
function nativeObservation(figma) {
  function normalize(value) {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => {
        if (item === undefined) return { $undefined: true };
        if (item === figma.mixed) return { $mixed: true };
        if (typeof item === 'function' || typeof item === 'symbol')
          throw new Error('Observe data properties, not methods');
        if (typeof item === 'number' && !Number.isFinite(item))
          throw new Error('Observed number is not finite');
        if (
          item &&
          typeof item.id === 'string' &&
          typeof item.remove === 'function' &&
          'parent' in item
        )
          return { id: item.id, type: item.type };
        if (item && typeof item === 'object' && !Array.isArray(item))
          return Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          );
        return item;
      }),
    );
  }
  const readers = {
    node: (id) => figma.getNodeByIdAsync(id),
    variable: (id) => figma.variables.getVariableByIdAsync(id),
    collection: (id) => figma.variables.getVariableCollectionByIdAsync(id),
    style: (id) => figma.getStyleByIdAsync(id),
  };
  const read = (kind, id) => readers[kind](id);
  async function resolve(resources) {
    const objects = await Promise.all(
      resources.map((item) => read(item.kind, item.id)),
    );
    // Figma may retain deleted variable/collection proxies in ID lookups.
    // Enumerate only the local resource kinds actually used by this condition.
    await Promise.all(
      [
        ['variable', () => figma.variables.getLocalVariablesAsync()],
        [
          'collection',
          () => figma.variables.getLocalVariableCollectionsAsync(),
        ],
      ].map(async ([kind, list]) => {
        if (
          !resources.some(
            (item, i) => item.kind === kind && objects[i] && !objects[i].remote,
          )
        )
          return;
        const current = new Map((await list()).map((item) => [item.id, item]));
        resources.forEach((item, i) => {
          if (item.kind === kind && objects[i] && !objects[i].remote)
            objects[i] = current.get(item.id) || null;
        });
      }),
    );
    return objects;
  }
  function ancestry(node) {
    const ids = [];
    for (let parent = node; parent; parent = parent.parent) ids.push(parent.id);
    return ids;
  }
  function property(object, field) {
    let value = object;
    for (const key of field.split('.')) {
      if (value === undefined || value === null) return normalize(undefined);
      if (!(key in Object(value)))
        throw new Error('Missing property: ' + field);
      value = value[key];
    }
    return normalize(value);
  }
  async function snapshot({ rootId, resources }) {
    rootId ||= resources[0].kind === 'node' ? resources[0].id : null;
    const root = rootId ? await read('node', rootId) : null;
    if (rootId && !root)
      throw new Error('Workspace root is missing: ' + rootId);
    const objects = await resolve(resources);
    return {
      format: 'figma.snapshot.v1',
      rootId,
      rootPath: root ? ancestry(root) : null,
      resources: resources.map((item, index) => {
        const object = objects[index];
        if (!object) throw new Error('Resource is missing: ' + item.id);
        return {
          kind: item.kind,
          id: item.id,
          ...(item.kind === 'node' ? { path: ancestry(object) } : {}),
          values: Object.fromEntries(
            item.fields.map((field) => [field, property(object, field)]),
          ),
        };
      }),
    };
  }
  async function check(snapshots, rootId) {
    try {
      const resources = snapshots.flatMap((snapshot) => snapshot.resources);
      const rootIds = [
        ...new Set(
          [...snapshots.map((item) => item.rootId), rootId].filter(Boolean),
        ),
      ];
      const roots = await Promise.all(rootIds.map((id) => read('node', id)));
      const objects = await resolve(resources);
      const conflicts = [];
      const same = (left, right) =>
        JSON.stringify(left) === JSON.stringify(right);
      for (const snapshot of snapshots) {
        const root = roots[rootIds.indexOf(snapshot.rootId)];
        if (
          snapshot.rootId &&
          (!root || !same(ancestry(root), snapshot.rootPath))
        )
          conflicts.push({
            kind: 'node',
            id: snapshot.rootId,
            field: 'ancestry',
          });
      }
      for (let index = 0; index < resources.length; index++) {
        const expected = resources[index],
          object = objects[index];
        if (!object) {
          conflicts.push({
            kind: expected.kind,
            id: expected.id,
            field: 'existence',
          });
          continue;
        }
        if (expected.path && !same(ancestry(object), expected.path))
          conflicts.push({
            kind: expected.kind,
            id: expected.id,
            field: 'ancestry',
          });
        for (const [field, value] of Object.entries(expected.values))
          if (!same(property(object, field), value))
            conflicts.push({ kind: expected.kind, id: expected.id, field });
      }
      const root = rootId ? roots[rootIds.indexOf(rootId)] : null;
      if (rootId && !root)
        conflicts.push({ kind: 'node', id: rootId, field: 'existence' });
      return {
        root,
        conflicts: conflicts.slice(0, 100),
        conflictCount: conflicts.length,
      };
    } catch (error) {
      return { error: String(error.message || error) };
    }
  }
  return { snapshot, check };
}
