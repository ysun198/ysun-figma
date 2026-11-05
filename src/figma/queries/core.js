// Per-query serialization, diagnostics and native-read budgets.
function createQueryCore(figma, bridge, log) {
  const issues = [];
  let nativeReads = {};
  let optionalReadRemainingMs = 10000;
  async function nativeRead(method, targetId, action, timeoutMs) {
    const startedAt = Date.now();
    let timer;
    try {
      if (timeoutMs !== undefined) {
        if (optionalReadRemainingMs <= 0)
          throw new Error('Optional native read time budget exhausted');
        timeoutMs = Math.min(timeoutMs, optionalReadRemainingMs);
      }
      const pending = action();
      return await (timeoutMs === undefined
        ? pending
        : Promise.race([
            pending,
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(method + ' timed out after ' + timeoutMs + ' ms'),
                  ),
                timeoutMs,
              );
            }),
          ]));
    } catch (error) {
      log({
        nativeRead: method,
        targetId,
        error: String(error.message || error),
      });
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      if (timeoutMs !== undefined) optionalReadRemainingMs -= elapsedMs;
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
  const describe = (node) => read(node, ['id', 'type', 'name']);
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

  function wrapQuery(query) {
    return async (input) => {
      issues.length = 0;
      nativeReads = {};
      try {
        return complete(await query(input));
      } catch (error) {
        const failure = new Error(String(error.message || error));
        failure.queryDiagnostics = {
          nativeReads,
          issues: issues.slice(0, 100),
          issueCount: issues.length,
        };
        throw failure;
      }
    };
  }
  return {
    figma,
    bridge,
    log,
    issues,
    nativeRead,
    complete,
    safe,
    read,
    describe,
    identity,
    nodeById,
    roots,
    wrapQuery,
  };
}
module.exports = { createQueryCore };
