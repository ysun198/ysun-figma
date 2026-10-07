const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { createExecution } = require('../../src/host/execution.cjs');
const { createArtifacts } = require('../../src/host/artifacts.cjs');

function seedLedger(file, jobs) {
  createExecution({
    databasePath: file,
    artifacts: createArtifacts(path.join(path.dirname(file), 'artifacts')),
  }).close();
  const db = new DatabaseSync(file);
  try {
    const insert = db.prepare(
      'INSERT INTO operations(id, record, receipt) VALUES(?, ?, ?)',
    );
    db.exec('BEGIN');
    for (const { result, ...record } of jobs)
      insert.run(
        record.id,
        JSON.stringify({ ...record, result: null }),
        result === undefined ? null : JSON.stringify(result),
      );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function readLedger(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT record, receipt FROM operations ORDER BY rowid')
      .all();
    const jobs = [],
      tombstones = [];
    for (const row of rows) {
      const job = JSON.parse(row.record);
      if (row.receipt !== null) job.result = JSON.parse(row.receipt);
      (job.archived ? tombstones : jobs).push(job);
    }
    return {
      jobs,
      tombstones,
      storedBytes: rows.reduce(
        (sum, row) =>
          sum +
          Buffer.byteLength(row.record) +
          Buffer.byteLength(row.receipt || ''),
        0,
      ),
    };
  } finally {
    db.close();
  }
}
module.exports = { readLedger, seedLedger };
