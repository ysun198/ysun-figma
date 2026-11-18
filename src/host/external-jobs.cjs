const crypto = require('node:crypto');
const { targetIdentity } = require('./targets.cjs');

function externalClient({ kind, accountId, fileKey, fileKeys }) {
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
  return {
    id: clientId,
    fileKey: fileKey || null,
    ...(fileKeys?.length > 1 ? { fileKeys } : {}),
    documentId: null,
    instanceId: kind + '-v1',
    editorType: kind,
    fileName: kind + ' / ' + (fileKey || 'account'),
    runtimeVersion: 0,
    nativeBuild: null,
  };
}

// The ledger admits and claims all work. This map owns only local callbacks
// and callers waiting for a result. A committed change wakes the dispatcher.
function createExternalJobs({ execution, artifacts }) {
  const tasks = new Map();
  let closing = false,
    scheduled = false;

  async function performJob({ id, clientId, readOnly, perform }) {
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
  }

  function dispatch() {
    scheduled = false;
    if (closing) return;
    const busy = new Set(
      [...tasks.values()]
        .filter((task) => task.running)
        .map((task) => task.clientId),
    );
    for (const task of tasks.values()) {
      if (task.running) continue;
      try {
        const current = execution.get(task.id, { result: false });
        if (current.status !== 'queued') {
          task.resolve({ job: execution.get(task.id) });
          tasks.delete(task.id);
          continue;
        }
        if (busy.has(task.clientId) || !execution.claim(task.target, task.id))
          continue;
        busy.add(task.clientId);
        task.running = true;
        performJob(task)
          .finally(() => {
            tasks.delete(task.id);
            schedule();
          })
          .then(task.resolve, task.reject);
      } catch (error) {
        task.reject(error);
        tasks.delete(task.id);
      }
    }
  }
  function schedule() {
    if (closing || scheduled || !tasks.size) return;
    scheduled = true;
    queueMicrotask(dispatch);
  }
  const unsubscribe = execution.onChange(schedule);
  async function run(input) {
    if (closing) throw new Error('external executor is stopping');
    const client = externalClient(input);
    const target = targetIdentity(client);
    const { id, kind, source, args, readOnly, perform } = input;
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
    if (!created) return tasks.get(id)?.promise || { job };
    const { promise, resolve, reject } = Promise.withResolvers();
    tasks.set(id, {
      id,
      clientId: client.id,
      target,
      readOnly,
      perform,
      promise,
      resolve,
      reject,
      running: false,
    });
    schedule();
    return promise;
  }
  return {
    run,
    isRunning: (id) => tasks.get(id)?.running === true,
    get pendingCount() {
      return tasks.size;
    },
    async close() {
      closing = true;
      unsubscribe();
      const running = [];
      for (const task of tasks.values()) {
        if (task.running) running.push(task.promise);
        else {
          task.resolve({
            job: execution.cancelQueued(
              task.id,
              'external executor stopped before delivery',
            ),
          });
          tasks.delete(task.id);
        }
      }
      await Promise.allSettled(running);
    },
  };
}
module.exports = { createExternalJobs };
