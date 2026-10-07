function parseFigmaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('figmaUrl must be an absolute Figma HTTPS link');
  }
  if (
    url.protocol !== 'https:' ||
    !['figma.com', 'www.figma.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('figmaUrl must be a Figma HTTPS link');
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    !['design', 'file', 'board', 'slides', 'proto'].includes(parts[0]) ||
    !/^[A-Za-z0-9]{6,100}$/.test(parts[1] || '')
  )
    throw new Error('unsupported Figma file link');
  const fileKey =
    parts[2] === 'branch' && parts.length > 3 ? parts[3] : parts[1];
  if (!/^[A-Za-z0-9]{6,100}$/.test(fileKey || ''))
    throw new Error('invalid Figma branch key');
  const nodes = url.searchParams.getAll('node-id');
  if (nodes.length > 1)
    throw new Error('figmaUrl contains conflicting node IDs');
  const nodeId = nodes.length
    ? nodes[0].replace(/(\d+)-(\d+)/g, '$1:$2')
    : undefined;
  if (nodeId && !/^(?:I)?\d+:\d+(?:;\d+:\d+)*$/.test(nodeId))
    throw new Error('invalid Figma node ID');
  return { fileKey, nodeId };
}
function matchingClients(input, clients) {
  return clients.filter(
    (client) =>
      client.connected &&
      (!input.clientId || client.id === input.clientId) &&
      (!input.fileName || client.fileName === input.fileName) &&
      (!input.fileKey || client.fileKey === input.fileKey),
  );
}
function targetIdentity(client) {
  return {
    clientId: client.id,
    fileKey: client.fileKey || null,
    documentId: client.documentId || null,
    instanceId: client.instanceId || null,
    editorType: client.editorType || null,
  };
}
function sameFile(left, right) {
  if (left.fileKey && right.fileKey) return left.fileKey === right.fileKey;
  return (
    left.clientId === right.clientId ||
    !!(left.documentId && left.documentId === right.documentId)
  );
}
function resolveTarget(input, clients) {
  if (input.clientId && input.fileName)
    throw new Error('choose clientId or fileName');
  const link = input.figmaUrl ? parseFigmaUrl(input.figmaUrl) : null;
  if (
    (input.fileKey && !/^[A-Za-z0-9]{6,100}$/.test(input.fileKey)) ||
    (input.fileKey && link && input.fileKey !== link.fileKey)
  )
    throw new Error('conflicting Figma file keys');
  if (
    (link?.nodeId && input.nodeId && link.nodeId !== input.nodeId) ||
    (link?.nodeId && input.nodeIds?.length)
  )
    throw new Error('choose the URL node or explicit node IDs');
  const matches = matchingClients(
    { ...input, fileKey: input.fileKey || link?.fileKey },
    clients,
  );
  if (!matches.length)
    throw new Error(
      'No matching connected Figma file. Open the file and run the plugin.',
    );
  if (matches.length !== 1)
    throw Object.assign(
      new Error(
        'Several Figma files match. Use the exact clientId from these candidates.',
      ),
      { code: 'FILE_AMBIGUOUS', clients: matches },
    );
  const requestedFileKey = input.fileKey || link?.fileKey;
  const target = targetIdentity(matches[0]);
  return {
    clientId: matches[0].id,
    nodeId: input.nodeId || link?.nodeId,
    target,
    targeting: {
      ...target,
      fileName: matches[0].fileName,
      fileKeyVerified: !!(
        requestedFileKey && matches[0].fileKey === requestedFileKey
      ),
      targetedBy: input.clientId
        ? 'clientId'
        : requestedFileKey
          ? 'fileKey'
          : input.fileName
            ? 'fileName'
            : 'onlyConnectedClient',
    },
  };
}
module.exports = {
  parseFigmaUrl,
  resolveTarget,
  matchingClients,
  targetIdentity,
  sameFile,
};
