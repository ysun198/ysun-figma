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

test('200 same-file admissions have immediate receipts, bounded capacity and a single execution per ID under concurrent retries', async (t) => {
  const { jobs, execution } = executor(t);
  const gate = Promise.withResolvers();
  let active = 0,
    peak = 0;
  const order = [];
  const request = (n) => ({
    id: 'cloud-burst-' + n,
    kind: 'rest',
    accountId: 'test',
    fileKey: 'CloudBurst1',
    source: 'POST fixture',
    readOnly: false,
    perform: async () => {
      peak = Math.max(peak, ++active);
      order.push(n);
      await gate.promise;
      active--;
      return { ok: true };
    },
  });
  const calls = [];
  for (let i = 0; i < 200; i++) {
    for (let repeat = 0; repeat < 5; repeat++) calls.push(jobs.run(request(i)));
    assert.equal(execution.get(request(i).id).status, 'queued');
  }
  await assert.rejects(jobs.run(request(200)), { statusCode: 429 });
  assert.equal(execution.get(request(200).id), null);
  gate.resolve();
  const receipts = await Promise.all(calls);
  assert.equal(peak, 1);
  assert.deepEqual(
    order,
    Array.from({ length: 200 }, (_, i) => i),
  );
  assert.equal(receipts.length, 1000);
  assert(receipts.every((r) => r.job.status === 'succeeded'));
  assert.equal(jobs.pendingCount, 0);
});

test('local calls wait for overlapping files, run unrelated files, and finish queued calls on shutdown', async (t) => {
  const { jobs, execution } = executor(t);
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const common = {
    kind: 'rest',
    accountId: 'test',
    source: 'fixture',
    readOnly: false,
  };
  const running = jobs.run({
    ...common,
    id: 'cloud-overlap-first',
    fileKeys: ['CloudFileA', 'CloudFileB'],
    perform: async () => {
      entered.resolve();
      await gate.promise;
      return { ok: true };
    },
  });
  await entered.promise;
  const waiting = jobs.run({
    ...common,
    id: 'cloud-overlap-next',
    fileKey: 'CloudFileB',
    perform: () => assert.fail('queued call started'),
  });
  const independent = await jobs.run({
    ...common,
    id: 'cloud-other-file',
    fileKey: 'CloudFileC',
    perform: async () => ({ ok: true }),
  });
  assert.equal(independent.job.status, 'succeeded');
  execution.cleanup(new Map(), jobs.isRunning);
  assert.equal(execution.get('cloud-overlap-first').status, 'running');
  const closed = jobs.close();
  assert.equal((await waiting).job.status, 'failed');
  gate.resolve();
  await closed;
  assert.equal((await running).job.status, 'succeeded');
});
