const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createExecution } = require('../src/host/execution.cjs');
const { createArtifacts } = require('../src/host/artifacts.cjs');
const { targetIdentity } = require('../src/host/targets.cjs');
const { readLedger } = require('./helpers/ledger.cjs');

const client = {
  id: 'kernel-client-1',
  fileKey: 'KernelFile12',
  documentId: 'a'.repeat(32),
  instanceId: 'kernel-instance-1',
  editorType: 'figma',
};
const input = (id, target = client) => ({
  id,
  source: 'return args;',
  args: { name: 'private script input' },
  assets: {},
  target: targetIdentity(target),
});
function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'figma-execution-store-'),
  );
  const databasePath = path.join(directory, 'operations.sqlite'),
    artifactDirectory = path.join(directory, 'artifacts'),
    artifacts = createArtifacts(artifactDirectory);
  let execution;
  const close = () => {
    execution?.close();
    execution = null;
  };
  t.after(() => {
    close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    databasePath,
    artifactDirectory,
    artifacts,
    close,
    get execution() {
      return execution;
    },
    open(extra = {}) {
      execution = createExecution({
        databasePath,
        artifacts,
        ...extra,
      });
      return execution;
    },
  };
}
function rejectWrites(file, sql) {
  const lock = new DatabaseSync(file);
  lock.exec(sql);
  return () => {
    lock.exec('DROP TRIGGER reject_change');
    lock.close();
  };
}
test('receipt, terminal state and publication commit together; an aborted receipt retains its original claim', (t) => {
  const f = fixture(t),
    published = [];
  const e = f.open({
    onChange: () => published.push(readLedger(f.databasePath)),
  });
  e.submit(input('receipt-atomic-operation'), [client]);
  e.claim(targetIdentity(client));
  const original = e.get('receipt-atomic-operation');
  const unlock = rejectWrites(
    f.databasePath,
    `CREATE TRIGGER reject_change BEFORE UPDATE OF receipt ON operations
    BEGIN SELECT RAISE(ABORT, 'receipt commit aborted'); END;`,
  );
  try {
    assert.throws(
      () =>
        e.complete(original.id, client.id, {
          ok: true,
          result: { changed: true },
        }),
      /aborted/,
    );
    assert.deepEqual(e.get(original.id), original);
    assert.equal(
      e.get(original.id, { payload: true }).source,
      input(original.id).source,
    );
    assert.equal(
      published.length,
      2,
      'no uncommitted terminal event is published',
    );
  } finally {
    unlock();
  }
  const completed = e.complete(original.id, client.id, {
    ok: true,
    result: { changed: true },
  });
  assert.deepEqual(published.at(-1).jobs[0], completed);
  assert.deepEqual(
    e.complete(original.id, client.id, { ok: true, result: { changed: true } }),
    completed,
  );
  assert.equal(
    published.length,
    3,
    'a duplicate receipt does not create another event',
  );
  assert.equal(e.get(original.id, { payload: true }).source, undefined);
});
test('claim failure rolls back all rejected targets and preserves queued payloads for exact delivery', (t) => {
  const f = fixture(t),
    e = f.open();
  const changed = { ...client, instanceId: 'kernel-instance-2' };
  e.submit(input('old-instance-queued'), [client]);
  e.submit(input('new-instance-queued', changed), [changed]);
  const unlock = rejectWrites(
    f.databasePath,
    `CREATE TRIGGER reject_change BEFORE UPDATE ON operations
    WHEN json_extract(NEW.record,'$.status')='running'
    BEGIN SELECT RAISE(ABORT, 'claim commit aborted'); END;`,
  );
  try {
    assert.throws(() => e.claim(targetIdentity(changed)), /aborted/);
    assert.equal(e.get('old-instance-queued').status, 'queued');
    assert.equal(e.get('new-instance-queued').status, 'queued');
    assert.equal(
      e.get('old-instance-queued', { payload: true }).source,
      input('').source,
    );
  } finally {
    unlock();
  }
  assert.equal(e.claim(targetIdentity(changed)).id, 'new-instance-queued');
  assert.equal(e.get('old-instance-queued').status, 'failed');
});
test('archiving and new admission are atomic; failed admission cannot retire an existing receipt or export', (t) => {
  const f = fixture(t),
    e = f.open();
  for (let i = 0; i < 200; i++) {
    const id = 'retention-original-' + i;
    e.submit(input(id), [client]);
    e.claim(targetIdentity(client));
    e.complete(id, client.id, { ok: true, result: { i } });
  }
  const original = e.get('retention-original-0');
  const exportDirectory = path.join(f.artifactDirectory, original.id);
  fs.mkdirSync(exportDirectory, { recursive: true });
  fs.writeFileSync(path.join(exportDirectory, 'proof.bin'), 'original bytes');
  const unlock = rejectWrites(
    f.databasePath,
    `CREATE TRIGGER reject_change BEFORE INSERT ON operations
    WHEN NEW.id='admission-after-retention'
    BEGIN SELECT RAISE(ABORT, 'admission commit aborted'); END;`,
  );
  try {
    assert.throws(
      () => e.submit(input('admission-after-retention'), [client]),
      /aborted/,
    );
    assert.deepEqual(e.get(original.id), original);
    assert.equal(e.get('admission-after-retention'), null);
    assert.equal(
      fs.readFileSync(path.join(exportDirectory, 'proof.bin'), 'utf8'),
      'original bytes',
    );
  } finally {
    unlock();
  }
  e.submit(input('admission-after-retention'), [client]);
  assert.equal(e.get(original.id).archived, true);
  e.cleanup(new Map());
  assert.equal(fs.existsSync(exportDirectory), false);
});
test('an abrupt process death recovers committed receipts and marks running writes unknown without replay', (t) => {
  const f = fixture(t);
  const program = `const {createExecution}=require(${JSON.stringify(require.resolve('../src/host/execution.cjs'))});
    const {createArtifacts}=require(${JSON.stringify(require.resolve('../src/host/artifacts.cjs'))});
    const directory=${JSON.stringify(f.artifactDirectory)}, client=${JSON.stringify(client)};
    const e=createExecution({databasePath:${JSON.stringify(f.databasePath)},artifacts:createArtifacts(directory)});
    e.submit(${JSON.stringify(input('crash-completed-operation'))},[client]); e.claim(${JSON.stringify(targetIdentity(client))});
    e.complete('crash-completed-operation',client.id,{ok:true,result:{proof:'committed before crash'}});
    e.submit(${JSON.stringify(input('crash-running-operation'))},[client]); e.claim(${JSON.stringify(targetIdentity(client))});
    process.kill(process.pid,'SIGKILL');`;
  const result = spawnSync(process.execPath, ['-e', program], {
    timeout: 5000,
  });
  assert.equal(result.signal, 'SIGKILL');
  const e = f.open();
  assert.equal(
    e.get('crash-completed-operation').result.proof,
    'committed before crash',
  );
  assert.equal(e.get('crash-running-operation').status, 'outcome_unknown');
  assert.equal(e.claim(targetIdentity(client)), null);
  assert.equal(
    e.get('crash-running-operation', { payload: true }).source,
    undefined,
  );
  assert.throws(
    () => e.submit(input('write-after-crash'), [client]),
    /unresolved outcome/,
  );
  e.submit({ ...input('read-after-crash'), options: { readOnly: true } }, [
    client,
  ]);
  assert.equal(e.claim(targetIdentity(client)).id, 'read-after-crash');
  for (const suffix of ['', '-wal', '-shm'])
    if (fs.existsSync(f.databasePath + suffix))
      assert.equal(fs.statSync(f.databasePath + suffix).mode & 0o777, 0o600);
});
test('same-file writes block the preview of every connected instance while other files stay available', () => {
  const { fileList } = require('../src/host/app.cjs');
  const another = {
    ...client,
    id: 'kernel-client-2',
    documentId: 'b'.repeat(32),
  };
  const unrelated = {
    ...client,
    id: 'unrelated-client',
    fileKey: 'OtherFile12',
  };
  const data = fileList(
    {
      clients: [client, another, unrelated].map((c) => ({
        ...c,
        connected: true,
      })),
      jobs: [
        {
          id: 'same-file-write',
          status: 'queued',
          target: targetIdentity(client),
          options: { readOnly: false },
        },
      ],
    },
    {
      status: 'ready',
      files: [client.fileKey, unrelated.fileKey].map((fileKey) => ({
        fileKey,
        name: fileKey,
      })),
    },
  );
  assert.deepEqual(
    data.files
      .find((f) => f.fileKey === client.fileKey)
      .sessions.map((s) => s.writing),
    [true, true],
  );
  assert.equal(
    data.files.find((f) => f.fileKey === unrelated.fileKey).sessions[0].writing,
    false,
  );
});
