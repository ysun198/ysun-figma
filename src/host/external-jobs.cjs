const crypto = require('node:crypto');
const { targetIdentity } = require('./targets.cjs');
// External transports share the native operation journal, retention and recovery.
function createExternalJobs({ execution, clients, artifacts, now = Date.now }) {
  const queues = new Map(),
    tasks = new Set();
  let closing = false;
  function run({
    id,
    kind,
    accountId,
    fileKey,
    fileKeys,
    source,
    args,
    readOnly,
    perform,
  }) {
    if (closing) throw new Error('external executor is stopping');
    const clientId =
      'external-' +
      crypto
        .createHash('sha256')
        .update(
          kind +
            '\0' +
            accountId +
            '\0' +
            (fileKey || fileKeys?.join(',') || 'account'),
        )
        .digest('hex')
        .slice(0, 32);
    const client = {
      id: clientId,
      fileKey: fileKey || null,
      ...(fileKeys?.length > 1 ? { fileKeys } : {}),
      documentId: null,
      instanceId: kind + '-v1',
      editorType: kind,
      fileName: kind + ' / ' + (fileKey || 'account'),
      expiresAt: now() + 120000,
      runtimeVersion: 0,
      nativeBuild: null,
    };
    const target = targetIdentity(client);
    const previous = queues.get(clientId) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        clients.set(clientId, client);
        const { job, created } = execution.submit(
          {
            id,
            kind,
            source,
            args,
            target,
            options: { readOnly, commitUndo: false },
          },
          [client],
        );
        if (!created) return { job };
        let claimed;
        while (!(claimed = execution.claim(target))) {
          const current = execution.get(id);
          if (current.status !== 'queued') return { job: current };
          if (closing)
            throw new Error('external executor stopped before delivery');
          client.expiresAt = now() + 120000;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (claimed.id !== id)
          throw new Error('external queue identity mismatch');
        let writeMayHaveApplied = false;
        try {
          writeMayHaveApplied = !readOnly;
          const value = await perform();
          writeMayHaveApplied &&= value.ok !== false || !!value.outcomeUnknown;
          const bytes = Buffer.from(JSON.stringify(value));
          let result;
          if (bytes.length > 200000) {
            const file = await artifacts.save(id, 'response.json', [bytes]);
            result = {
              value: {
                endpoint: value.endpoint,
                httpStatus: value.httpStatus,
                ok: value.ok,
                bodyInExport: true,
                pagination: value.pagination,
                rateLimit: value.rateLimit,
              },
              exports: [{ ...file, mimeType: 'application/json' }],
            };
          } else result = { value };
          return {
            job: execution.complete(id, clientId, {
              ok: value.ok !== false,
              outcomeUnknown: !!value.outcomeUnknown,
              error:
                value.ok === false
                  ? value.semanticError || 'Figma HTTP ' + value.httpStatus
                  : undefined,
              result,
            }),
          };
        } catch (error) {
          // A transport success cannot become a known rejected write just
          // because serializing, saving or committing its result failed.
          const outcomeUnknown =
            !!error.outcomeUnknown ||
            (writeMayHaveApplied && error.phase !== 'preflight');
          try {
            return {
              job: execution.complete(id, clientId, {
                ok: false,
                outcomeUnknown,
                error: error.message,
                result: {
                  value: { code: error.code || 'EXTERNAL_TRANSPORT_FAILED' },
                },
              }),
            };
          } catch (receiptError) {
            if (!outcomeUnknown) throw receiptError;
            throw Object.assign(
              new Error(
                'Cloud result could not be recorded; inspect original operation ' +
                  id,
                { cause: receiptError },
              ),
              {
                code: 'CLOUD_RECEIPT_UNAVAILABLE',
                phase: 'receipt',
                operationId: id,
                outcomeUnknown: true,
              },
            );
          }
        }
      });
    queues.set(clientId, task);
    tasks.add(task);
    task
      .finally(() => {
        tasks.delete(task);
        if (queues.get(clientId) === task) queues.delete(clientId);
      })
      .catch(() => {});
    return task;
  }
  return {
    run,
    get pendingCount() {
      return tasks.size;
    },
    async close() {
      closing = true;
      await Promise.allSettled([...tasks]);
    },
  };
}
module.exports = { createExternalJobs };
