const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { privateDirectory } = require('./state.cjs');
const { sameFile, targetIdentity } = require('./targets.cjs');

const MAX_RUN_MS = 10 * 60 * 1000;
const TERMINAL_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'outcome_unknown']);
const resolved = (job) =>
  ['succeeded', 'failed'].includes(job.status) ||
  (job.status === 'outcome_unknown' && !!job.reconciledAt);
const digest = (value) =>
  'sha256:' +
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const problem = (statusCode, message, details = {}) =>
  Object.assign(new Error(message), { statusCode, ...details });

// SQLite owns operation facts. Only undelivered script bodies live in memory;
// they are never a second ledger and are never replayed after a restart.
function createExecution({
  databasePath,
  now = Date.now,
  onChange = () => {},
  onError = () => {},
  artifacts,
} = {}) {
  const { DatabaseSync } = require('node:sqlite');
  if (databasePath) {
    privateDirectory(path.dirname(databasePath));
    if (
      fs.existsSync(databasePath) &&
      fs.lstatSync(databasePath).isSymbolicLink()
    )
      throw new Error('operation database cannot be a symlink');
    const descriptor = fs.openSync(databasePath, 'a', 0o600);
    fs.closeSync(descriptor);
    fs.chmodSync(databasePath, 0o600);
  }
  const db = new DatabaseSync(databasePath || ':memory:');
  const statements = new Map(),
    payloads = new Map();
  function statement(sql) {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  }
  const records = (sql, ...parameters) =>
    statement(sql)
      .all(...parameters)
      .map((row) => JSON.parse(row.record));
  const list = () =>
    records('SELECT record FROM operations WHERE archived=0 ORDER BY rowid');
  function get(id, { payload = false, result = true } = {}) {
    const row = statement(
      `SELECT record${result ? ', receipt' : ''} FROM operations WHERE id=?`,
    ).get(id);
    if (!row) return null;
    const job = JSON.parse(row.record);
    if (result && row.receipt !== null) job.result = JSON.parse(row.receipt);
    return payload ? { ...job, ...payloads.get(id) } : job;
  }
  function change(work) {
    const effects = [];
    let changed = false,
      value;
    db.exec('BEGIN IMMEDIATE');
    try {
      value = work(
        (job, receipt) => {
          statement(`INSERT INTO operations(id, record) VALUES(?, ?)
          ON CONFLICT(id) DO UPDATE SET record=excluded.record`).run(
            job.id,
            JSON.stringify(job),
          );
          if (receipt !== undefined)
            statement('UPDATE operations SET receipt=? WHERE id=?').run(
              receipt === null ? null : JSON.stringify(receipt),
              job.id,
            );
          if (job.archived)
            statement(
              'UPDATE operations SET receipt=NULL, garbage=1 WHERE id=?',
            ).run(job.id);
          changed = true;
        },
        (effect) => effects.push(effect),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    for (const effect of effects) effect();
    if (changed) onChange();
    return value;
  }
  function transition(job, status, fields) {
    const allowed =
      job.status === 'queued'
        ? ['running', 'failed']
        : job.status === 'running' ||
            (!job.receiptHash &&
              job.clientId &&
              TERMINAL_STATES.has(job.status))
          ? [...TERMINAL_STATES]
          : [];
    if (!allowed.includes(status))
      throw problem(
        409,
        `cannot move operation from ${job.status} to ${status}`,
      );
    return { ...job, ...fields, status };
  }
  function interrupt(job, error) {
    return transition(
      job,
      job.status === 'queued' || job.options?.readOnly
        ? 'failed'
        : 'outcome_unknown',
      { finishedAt: now(), error },
    );
  }
  function archive(job, save) {
    const {
      id,
      payloadHash,
      receiptHash,
      kind,
      status,
      target,
      createdAt,
      finishedAt,
      error,
      reconciledAt,
      reconciliation,
    } = job;
    save({
      id,
      payloadHash,
      receiptHash,
      kind,
      status,
      target,
      createdAt,
      finishedAt,
      error,
      reconciledAt,
      reconciliation,
      archived: true,
      result: null,
    });
  }
  function collectGarbage() {
    const removed = [];
    for (const { id } of statement(
      'SELECT id FROM operations WHERE garbage=1',
    ).all()) {
      try {
        artifacts.remove(id);
        removed.push(id);
      } catch (error) {
        onError(error);
      }
    }
    if (removed.length)
      change(() => {
        for (const id of removed)
          statement('UPDATE operations SET garbage=0 WHERE id=?').run(id);
      });
  }
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1)
      throw new Error('unsupported operation database');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations(
        id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)),
        receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
        status TEXT GENERATED ALWAYS AS (json_extract(record, '$.status')) STORED
          CHECK(status IN ('queued','running','succeeded','failed','outcome_unknown')),
        target_client TEXT GENERATED ALWAYS AS (json_extract(record, '$.target.clientId')) STORED,
        owner TEXT GENERATED ALWAYS AS (json_extract(record, '$.clientId')) STORED,
        archived INTEGER GENERATED ALWAYS AS (coalesce(json_extract(record, '$.archived'), 0)) STORED,
        retention_at INTEGER GENERATED ALWAYS AS (CASE
          WHEN json_extract(record, '$.status') IN ('succeeded','failed')
            THEN json_extract(record, '$.finishedAt')
          WHEN json_extract(record, '$.status')='outcome_unknown'
            THEN json_extract(record, '$.reconciledAt') END) STORED,
        garbage INTEGER NOT NULL DEFAULT 0 CHECK(garbage IN (0,1))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS active_status ON operations(status) WHERE archived=0;
      CREATE INDEX IF NOT EXISTS client_queue ON operations(target_client) WHERE status='queued' AND archived=0;
      CREATE INDEX IF NOT EXISTS retention ON operations(retention_at) WHERE archived=0 AND retention_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS garbage_queue ON operations(garbage) WHERE garbage=1;
      PRAGMA user_version=1;`);
    change((save) => {
      for (const job of records(
        "SELECT record FROM operations WHERE status IN ('queued','running') AND archived=0",
      ))
        save(interrupt(job, 'relay restarted; this job will not be replayed'));
    });
    collectGarbage();
  } catch (error) {
    db.close();
    throw error;
  }
  const fileWork = (target) =>
    records(
      "SELECT record FROM operations WHERE status IN ('running','outcome_unknown') AND archived=0",
    ).filter((job) => sameFile(job.target, target));
  const blocking = (target) =>
    fileWork(target).filter(
      (job) => job.status === 'outcome_unknown' && !job.reconciledAt,
    );
  return {
    get,
    list,
    assetIds() {
      return new Set(
        [...payloads.values()].flatMap((payload) =>
          Object.values(payload.assets || {}).map((asset) => asset.assetId),
        ),
      );
    },
    recovery(clientId) {
      const work = records(
        "SELECT record FROM operations WHERE owner=? AND status IN ('running','outcome_unknown') AND archived=0",
        clientId,
      );
      return {
        active: work
          .filter((job) => job.status === 'running')
          .map((job) => job.id),
        unresolved: work
          .filter(
            (job) => job.status === 'outcome_unknown' && !job.reconciledAt,
          )
          .map((job) => job.id),
      };
    },
    submit(input, clients) {
      const expected = input.target;
      const payloadHash = digest({
        source: input.source,
        args: input.args,
        assets: input.assets,
        target: expected,
        options: input.options || {},
      });
      return change((save, after) => {
        const existing = get(input.id);
        if (existing) {
          if (existing.payloadHash !== payloadHash)
            throw problem(409, 'operationId already refers to another request');
          return { job: existing, created: false };
        }
        const client = clients.find(
          (client) => client.id === expected.clientId,
        );
        if (!client)
          throw problem(
            409,
            'no matching connected Figma session; open the plugin and pair it first',
            { clients },
          );
        const actual = targetIdentity(client);
        if (digest(actual) !== digest(expected))
          throw problem(
            409,
            'the resolved Figma target changed before submission; inspect the current file and resolve it again',
            { expected, actual },
          );
        const blocked = blocking(expected);
        if (input.options?.readOnly !== true && blocked.length)
          throw problem(
            409,
            'this client has an unresolved outcome; inspect the file and reconcile the original operation',
            { blockingOperationIds: blocked.map((job) => job.id) },
          );
        const counts = statement(`SELECT count(*) AS recent,
          sum(status IN ('queued','running')) AS pending FROM operations WHERE archived=0`).get();
        if (counts.pending >= 200)
          throw problem(
            429,
            'native queue is full; wait for pending operations',
          );
        if (counts.recent >= 200) {
          const removable = records(
            'SELECT record FROM operations WHERE archived=0 AND retention_at IS NOT NULL ORDER BY rowid LIMIT 1',
          )[0];
          if (removable) archive(removable, save);
        }
        const job = {
          id: input.id,
          kind: 'exec',
          payloadHash,
          sourceHash: digest(input.source),
          status: 'queued',
          target: {
            ...expected,
            fileName: client.fileName,
            runtimeVersion: client.runtimeVersion,
            nativeBuild: client.nativeBuild,
          },
          options: {
            readOnly: input.options?.readOnly === true,
            operationId: input.id,
            commitUndo: input.options?.commitUndo !== false,
          },
          createdAt: now(),
          expiresAt:
            now() +
            Math.max(
              1000,
              Math.min(
                MAX_RUN_MS,
                Number.isFinite(input.expiresInMs) ? input.expiresInMs : 120000,
              ),
            ),
          startedAt: null,
          finishedAt: null,
          clientId: null,
          result: null,
          error: null,
        };
        save(job);
        after(() =>
          payloads.set(job.id, {
            source: input.source,
            args: input.args,
            assets: input.assets,
          }),
        );
        return { job, created: true };
      });
    },
    claim(target) {
      return change((save, after) => {
        const work = fileWork(target);
        if (work.some((job) => job.status === 'running')) return null;
        for (const job of records(
          "SELECT record FROM operations WHERE target_client=? AND status='queued' AND archived=0 ORDER BY rowid",
          target.clientId,
        )) {
          const original = targetIdentity({
            ...job.target,
            id: job.target.clientId,
          });
          if (digest(original) !== digest(target)) {
            save(
              interrupt(
                job,
                'the original plugin target changed before this operation started',
              ),
            );
            after(() => payloads.delete(job.id));
            continue;
          }
          if (
            !job.options.readOnly &&
            work.some(
              (other) =>
                other.status === 'outcome_unknown' && !other.reconciledAt,
            )
          )
            continue;
          const claimed = transition(job, 'running', {
            clientId: target.clientId,
            startedAt: now(),
          });
          save(claimed);
          return { ...claimed, ...payloads.get(job.id) };
        }
        return null;
      });
    },
    complete(id, clientId, body) {
      return change((save, after) => {
        const job = get(id, { result: false });
        if (!job || job.archived) throw problem(404, 'job was not found');
        if (job.clientId !== clientId)
          throw problem(409, 'job is owned by another plugin client');
        for (const file of body.result?.exports || []) {
          const stored = artifacts.describe(job.id, file.name);
          if (stored.sha256 !== file.sha256 || stored.size !== file.size)
            throw problem(409, 'export receipt does not match saved bytes');
        }
        const status = body.outcomeUnknown
          ? 'outcome_unknown'
          : body.ok === true
            ? 'succeeded'
            : 'failed';
        const receiptHash = digest({
          status,
          result: body.result || null,
          error: body.error || null,
        });
        if (job.receiptHash) {
          if (job.receiptHash !== receiptHash)
            throw problem(409, 'conflicting receipt for a completed job');
          return get(id);
        }
        const stored = body.ok === true || !!body.result;
        const completed = transition(job, status, {
          finishedAt: now(),
          receiptHash,
          error:
            body.ok === true
              ? null
              : String(body.error || 'Figma operation failed'),
          ...(stored ? { resultStored: true } : {}),
        });
        save(completed, stored ? body.result || {} : null);
        after(() => payloads.delete(id));
        return { ...completed, result: stored ? body.result || {} : null };
      });
    },
    reconcile(id, { outcome, note }) {
      if (
        !['applied', 'partially_applied', 'not_applied'].includes(outcome) ||
        typeof note !== 'string' ||
        !note.trim() ||
        note.length > 2000
      )
        throw problem(
          400,
          'provide applied, partially_applied or not_applied and a note describing the canvas inspection',
        );
      return change((save) => {
        const job = get(id, { result: false });
        if (!job || job.archived || job.status !== 'outcome_unknown')
          throw problem(409, 'only an uncertain operation can be reconciled');
        save({
          ...job,
          reconciledAt: now(),
          reconciliation: { outcome, note: note.trim() },
        });
        return get(id);
      });
    },
    endInstance(clientId, error) {
      change((save, after) => {
        for (const job of records(
          `SELECT record FROM operations WHERE archived=0 AND
          ((status='running' AND owner=?) OR (status='queued' AND target_client=?))`,
          clientId,
          clientId,
        )) {
          save(
            interrupt(
              job,
              job.status === 'queued'
                ? 'the original plugin window closed before this operation started'
                : error,
            ),
          );
          after(() => payloads.delete(job.id));
        }
      });
    },
    cleanup(clients) {
      change((save, after) => {
        for (const job of records(
          "SELECT record FROM operations WHERE status IN ('queued','running') AND archived=0",
        )) {
          const client = clients.get(job.clientId);
          let error;
          if (job.status === 'queued' && now() >= job.expiresAt)
            error = 'job expired before delivery';
          if (
            job.status === 'running' &&
            (!client ||
              now() >= client.expiresAt ||
              now() - job.startedAt >= MAX_RUN_MS)
          )
            error = job.options.readOnly
              ? 'read interrupted by session end or execution deadline'
              : 'session ended or execution deadline exceeded; inspect the file before another write';
          if (error) {
            save(interrupt(job, error));
            after(() => payloads.delete(job.id));
          }
        }
        for (const job of records(
          'SELECT record FROM operations WHERE archived=0 AND retention_at IS NOT NULL AND retention_at<?',
          now() - TERMINAL_JOB_TTL_MS,
        ))
          archive(job, save);
      });
      collectGarbage();
    },
    close() {
      payloads.clear();
      db.close();
    },
  };
}
module.exports = {
  createExecution,
  MAX_RUN_MS,
  TERMINAL_STATES,
  resolved,
  digest,
};
