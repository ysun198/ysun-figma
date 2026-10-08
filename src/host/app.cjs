// MCP Apps resource. The browser receives data through the host, never bridge credentials.
const fs = require('node:fs');
const path = require('node:path');
const { matchingClients, sameFile, targetIdentity } = require('./targets.cjs');
const uri = 'ui://figma-plugin/files';
const mimeType = 'text/html;profile=mcp-app';
// One self-themed SVG serves image and mask consumers. Image colors follow
// Codex's secondary foreground; opaque artwork keeps host mask tinting intact.
const iconPath =
  require('../../plugin.json').extensions['com.openai'].interface.composerIcon;
const svg = fs.readFileSync(path.join(__dirname, '../..', iconPath), 'utf8');
const icons = [
  {
    src: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
    mimeType: 'image/svg+xml',
    sizes: ['48x48'],
  },
];
const metadata = {
  ui: { resourceUri: uri, visibility: ['app', 'model'] },
  'openai/ui': { entrypoints: [{ type: 'global' }] },
};
const resource = { uri, name: 'figma-files', title: 'ysun figma', mimeType };
function readResource(requested) {
  if (requested !== uri)
    throw Object.assign(new Error('Unknown resource'), { code: -32002 });
  return {
    contents: [
      {
        ...resource,
        uri: requested,
        text: fs.readFileSync(path.join(__dirname, '../../app.html'), 'utf8'),
        _meta: {
          ui: {
            csp: {
              connectDomains: [],
              resourceDomains: ['https://s3-alpha.figma.com'],
            },
            prefersBorder: false,
          },
          'openai/ui': {
            preferredDisplayMode: 'fullscreen',
            availableDisplayModes: ['inline', 'fullscreen'],
          },
        },
      },
    ],
  };
}
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
module.exports = {
  uri,
  mimeType,
  icons,
  metadata,
  resource,
  readResource,
  fileList,
};
