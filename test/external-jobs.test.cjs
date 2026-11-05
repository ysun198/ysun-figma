const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createArtifacts } = require('../src/host/artifacts.cjs');
const { createExecution } = require('../src/host/execution.cjs');
const { createExternalJobs } = require('../src/host/external-jobs.cjs');

function executor(t, { failCompletion = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-external-fault-'));
  const artifacts = {
    ...createArtifacts(root),
    async save() {
      throw Object.assign(new Error('result disk is full'), { code: 'ENOSPC' });
    },
  };
  const execution = createExecution({ artifacts });
  const jobs = createExternalJobs({
    execution: failCompletion
      ? {
          ...execution,
          complete() {
            throw new Error('receipt storage is unavailable');
          },
        }
      : execution,
    clients: new Map(),
    artifacts,
  });
  t.after(async () => {
    await jobs.close();
    execution.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { jobs, execution };
}

test('a persistent receipt-store failure identifies the accepted mutation without inventing a durable receipt', async (t) => {
  const { jobs, execution } = executor(t, { failCompletion: true });
  let writes = 0;
  const request = {
    id: 'external-receipt-unavailable',
    kind: 'rest',
    accountId: 'qa-account',
    fileKey: 'TestFile123',
    source: 'POST /comments',
    readOnly: false,
    perform: async () => {
      writes++;
      return { ok: true };
    },
  };
  await assert.rejects(
    jobs.run(request),
    (error) =>
      error.code === 'CLOUD_RECEIPT_UNAVAILABLE' &&
      error.phase === 'receipt' &&
      error.operationId === request.id,
  );
  assert.equal(execution.get(request.id).status, 'running');
  assert.equal((await jobs.run(request)).job.status, 'running');
  assert.equal(writes, 1);
});

test('cloud mutation survives result-storage failure as uncertain and is never replayed', async (t) => {
  const { jobs } = executor(t);
  let writes = 0;
  const request = {
    id: 'external-storage-failure',
    kind: 'rest',
    accountId: 'qa-account',
    fileKey: 'TestFile123',
    source: 'POST /comments',
    args: { message: 'once' },
    readOnly: false,
    perform: async () => {
      writes++;
      return { ok: true, httpStatus: 200, body: 'x'.repeat(200001) };
    },
  };
  const result = await jobs.run(request);
  assert.equal(result.job.status, 'outcome_unknown');
  assert.match(result.job.error, /disk is full/);
  assert.equal((await jobs.run(request)).job.id, request.id);
  assert.equal(writes, 1);
  await assert.rejects(
    jobs.run({ ...request, id: 'external-later-mutation' }),
    /uncertain|reconcil/i,
  );
  assert.equal(writes, 1);
});

test('a read whose large result cannot be stored remains a known failure', async (t) => {
  const { jobs } = executor(t);
  const result = await jobs.run({
    id: 'external-read-storage',
    kind: 'rest',
    accountId: 'qa-account',
    fileKey: 'TestFile123',
    source: 'GET /versions',
    readOnly: true,
    perform: async () => ({ ok: true, body: 'x'.repeat(200001) }),
  });
  assert.equal(result.job.status, 'failed');
});

test('explicit preflight rejection and a rejected cloud response remain known failures', async (t) => {
  const { jobs } = executor(t);
  for (const [id, perform] of [
    [
      'external-preflight-reject',
      async () => {
        throw Object.assign(new Error('credential expired'), {
          phase: 'preflight',
        });
      },
    ],
    [
      'external-server-reject',
      async () => ({
        ok: false,
        outcomeUnknown: false,
        httpStatus: 403,
        body: 'x'.repeat(200001),
      }),
    ],
  ]) {
    const result = await jobs.run({
      id,
      kind: 'rest',
      accountId: 'qa-account',
      fileKey: 'TestFile123',
      source: 'POST /comments',
      readOnly: false,
      perform,
    });
    assert.equal(result.job.status, 'failed');
  }
});
