// Compose independent native query families around one operation's diagnostics.
const { createQueryCore } = require('./queries/core.js');
const { createResourceQueries } = require('./queries/resources.js');
const { createSearchQueries } = require('./queries/search.js');
const { createAssetQueries } = require('./queries/assets.js');
const { createInspectionQueries } = require('./queries/inspection.js');
const { createMotionQueries } = require('./queries/motion.js');
function createDesignQueries(figma, bridge, log = () => {}) {
  const core = createQueryCore(figma, bridge, log);
  const resources = createResourceQueries(core);
  const search = createSearchQueries({ ...core, ...resources });
  const assets = createAssetQueries(core);
  const inspection = createInspectionQueries({
    ...core,
    ...resources,
    ...assets,
  });
  const motion = createMotionQueries({ ...core, ...search });
  const queries = {
    inspect: inspection.inspect,
    navigate: inspection.navigate,
    context: inspection.context,
    exportNode: assets.exportNode,
    screenshot: (args) =>
      assets.exportNode({ ...args, format: 'PNG', preview: true }),
    variables: resources.variables,
    findNodes: search.findNodes,
    components: (args) =>
      search.findNodes({
        ...args,
        types: ['COMPONENT', 'COMPONENT_SET'],
        includeComponentMetadata: true,
      }),
    designSystem: search.designSystem,
    downloadAssets: assets.downloadAssets,
    importAssets: assets.importAssets,
    motion: motion.motion,
    capabilities: inspection.capabilities,
  };
  return Object.fromEntries(
    Object.entries(queries).map(([name, query]) => [
      name,
      core.wrapQuery(query),
    ]),
  );
}
module.exports = { createDesignQueries };
