const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('../test-support/figma.cjs');
const { summarizeStatus } = require('../scripts/bridge-server.cjs');
test('success and failure receipts disclose dropped logs and truncated messages', async () => {
  const f = fixture(),
    source =
      'console.log("x".repeat(2100)); for(let i=0;i<104;i++) console.log(i);';
  const value = await f.api.executeScript(
    source,
    {},
    {},
    { readOnly: true, commitUndo: false },
  );
  assert.equal(value.logs.length, 100);
  assert.equal(value.logLimits.droppedEntries, 5);
  assert.equal(value.logLimits.truncatedMessages, 1);
  assert.equal(value.logs[0].truncated, true);
  await assert.rejects(
    f.api.executeScript(
      source + 'throw new Error("failed");',
      {},
      {},
      { readOnly: true, commitUndo: false },
    ),
    (error) => error.receipt.logLimits.droppedEntries === 5,
  );
});

test('native scripts await API methods and patch the same node between jobs', async () => {
  const f = fixture();
  f.figma.getNodeByIdAsync = async (id) =>
    f.nodes.find((n) => n.id === id && !n.removed);
  const first = await f.api.executeScript(
    'const n = figma.createFrame(); n.name = args.name; console.log(n); return n;',
    { name: 'First' },
    {},
    { operationId: 'script-create-01' },
  );
  const second = await f.api.executeScript(
    'const n = await figma.getNodeByIdAsync(args.nodeId); n.name = args.name; return n;',
    { nodeId: first.value.id, name: 'Updated' },
  );
  assert.equal(first.value.id, second.value.id);
  assert.equal(second.value.name, 'Updated');
  assert.equal(f.calls.commits, 2);
  assert.equal(first.logs.length, 1);
  assert.equal(first.operationId, 'script-create-01');
});
test('assets and exports preserve exact bytes using the native encoder', async () => {
  const f = fixture(),
    bytes = new Uint8Array([0, 255, 128, 34, 0, 9, 10]);
  const result = await f.api.executeScript(
    'bridge.exportFile("image.png", bridge.assets.image, "image/png"); return bridge.assets.image;',
    {},
    { image: bytes },
    { commitUndo: false },
  );
  assert.deepEqual(Buffer.from(result.exports[0].bytes), Buffer.from(bytes));
  assert.equal(result.value.base64, Buffer.from(bytes).toString('base64'));
  assert.equal(f.calls.commits, 0);
});
test('syntax errors cause no writes; a failure after execution reports an uncertain mutation', async () => {
  const f = fixture(),
    creates = f.calls.creates;
  await assert.rejects(
    f.api.executeScript('const n = ; figma.createFrame();'),
    (e) => !e.outcomeUnknown,
  );
  assert.equal(f.calls.creates, creates);
  await assert.rejects(
    f.api.executeScript('figma.createFrame(); throw new Error("after write");'),
    (e) => e.outcomeUnknown && /after write/.test(e.message),
  );
  assert.equal(f.calls.creates, creates + 1);
  assert.equal(f.calls.commits, 0);
});
test('compact status retains unresolved work without loading binary receipts', () => {
  const state = {
    clients: [],
    jobs: [
      {
        id: 'old-unknown',
        status: 'outcome_unknown',
        error: 'receipt missing',
      },
      { id: 'old-running', status: 'running' },
      { id: 'reconciled-unknown', status: 'outcome_unknown', reconciledAt: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: 'done-' + i,
        status: 'succeeded',
        result: { value: 'large native result' },
      })),
    ],
  };
  const compact = summarizeStatus(state, { scope: 'all' });
  assert.equal(compact.jobCount, 23);
  assert.equal(compact.jobsTruncated, true);
  assert.equal(compact.jobs.length, 2);
  assert.equal(compact.jobs[0].id, 'old-unknown');
  assert.equal(compact.jobs.at(-1).id, 'old-running');
  assert.doesNotMatch(JSON.stringify(compact), /large native result/);
  assert.equal(compact.unresolvedJobCount, 2);
  assert.deepEqual(summarizeStatus(state).jobs, []);
});
test('status scopes identities without erasing global counts or guessing same-name files', () => {
  const clients = ['client-first', 'client-other'].map((id, i) => ({
    id,
    connected: true,
    fileKey: i ? 'OtherFile12' : 'FirstFile12',
    fileName: 'Same title',
  }));
  const state = {
    clients,
    jobs: [
      {
        id: 'old-write',
        status: 'outcome_unknown',
        target: { clientId: 'disconnected' },
        error: 'original error',
      },
      {
        id: 'first-write',
        status: 'outcome_unknown',
        target: { clientId: clients[0].id },
      },
      {
        id: 'other-read',
        status: 'running',
        target: { clientId: clients[1].id },
      },
      {
        id: 'reviewed',
        status: 'outcome_unknown',
        target: { clientId: clients[0].id },
        reconciledAt: 1,
      },
    ],
  };
  assert.deepEqual(
    summarizeStatus(state).jobs.map((job) => job.id),
    ['first-write', 'other-read'],
  );
  const value = summarizeStatus(state, { fileKey: 'OtherFile12' });
  assert.deepEqual(
    value.jobs.map((job) => job.id),
    ['other-read'],
  );
  assert.equal(value.clients[0].id, clients[1].id);
  assert.equal(value.jobCounts.outcome_unknown, 3);
  assert.equal(value.unresolvedJobCount, 3);
  assert.deepEqual(value.jobsScope, {
    scope: 'connected',
    clientId: clients[1].id,
  });
  assert.equal(state.jobs[0].error, 'original error');
  assert.equal(state.jobs.length, 4);
  assert.throws(
    () =>
      summarizeStatus(state, {
        clientId: clients[0].id,
        fileKey: 'OtherFile12',
      }),
    /No matching/,
  );
  assert.throws(
    () => summarizeStatus(state, { scope: 'all', clientId: clients[0].id }),
    /choose/,
  );
  assert.throws(() => summarizeStatus(state, { scope: 'invalid' }), /scope/);
});
test('invalid result graphs, filenames and oversize exports fail without hiding execution', async () => {
  const f = fixture();
  for (const source of [
    'const result = {}; result.self = result; return result;',
    'bridge.exportFile("../outside.png", new Uint8Array(1));',
    'bridge.exportFile("huge.png", new Uint8Array(32 * 1024 * 1024 + 1));',
  ])
    await assert.rejects(
      f.api.executeScript(source),
      (e) => e.outcomeUnknown === true,
    );
});
