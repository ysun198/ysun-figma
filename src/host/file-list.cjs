const { matchingClients, sameFile, targetIdentity } = require('./targets.cjs');
function fileList(state, catalog = { files: [], status: 'empty' }) {
  const clients = (state.clients || []).filter((client) => client.connected);
  const writing = (state.jobs || []).filter(
    (job) =>
      ['queued', 'running'].includes(job.status) && !job.options?.readOnly,
  );
  const session = (client) => ({
    clientId: client.id,
    instanceId: client.instanceId,
    documentId: client.documentId,
    fileName: client.fileName,
    pageName: client.pageName,
    pageId: client.pageId,
    selection: client.selection || [],
    documentRevision: client.documentRevision || 0,
    editorType: client.editorType,
    runtimeVersion: client.runtimeVersion,
    nativeBuild: client.nativeBuild,
    needsPluginUpdate: client.needsPluginUpdate,
    writing: writing.some((job) =>
      sameFile(job.target, targetIdentity(client)),
    ),
  });
  const files = (catalog.files || []).map((file) => {
    const matches = matchingClients({ fileKey: file.fileKey }, clients);
    return {
      ...file,
      id: file.fileKey,
      clientId: matches.length === 1 ? matches[0].id : null,
      sessions: matches.map(session),
      connected: matches.length > 0,
    };
  });
  files.sort(
    (a, b) =>
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
      a.name.localeCompare(b.name),
  );
  return {
    version: state.version,
    files,
    catalog: {
      accountId: catalog.accountId || null,
      status: catalog.status,
      syncedAt: catalog.syncedAt || null,
      lastAttemptAt: catalog.lastAttemptAt || null,
      error: catalog.error || null,
      coverage: catalog.coverage || [],
      coverageComplete: catalog.status === 'ready',
      fileCount: catalog.files?.length || 0,
    },
  };
}
module.exports = { fileList };
