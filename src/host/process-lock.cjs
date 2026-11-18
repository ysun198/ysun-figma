// The kernel releases SQLite's write lock when the owner exits. The PID
// marker keeps already-installed launchers and native readers interoperable.
// launchd embeds this function so it can also run between package renames.
async function acquireProcessLock(state, relativeMarker, waitMs, busyMessage) {
  const fs = require('node:fs'),
    path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const marker = path.join(state, relativeMarker);
  const lockDirectory = path.join(state, 'locks');
  const gate = path.join(lockDirectory, relativeMarker);
  for (const dir of [path.dirname(marker), lockDirectory, path.dirname(gate)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(dir).isDirectory())
      throw new Error('Invalid private lock directory');
    fs.chmodSync(dir, 0o700);
  }
  try {
    fs.writeFileSync(gate, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.lstatSync(gate).isFile())
      throw new Error('Invalid private process lock', { cause: error });
  }
  const owner = process.pid + '-' + require('node:crypto').randomUUID();
  const deadline = Date.now() + waitMs;
  const db = new DatabaseSync(gate);
  async function wait() {
    if (Date.now() >= deadline) throw new Error(busyMessage);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  function readOwner() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const value = fs.readlinkSync(marker);
        if (!/^[1-9]\d*-[a-f0-9-]{36}$/.test(value)) break;
        return value;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code !== 'EINVAL') throw error;
        // A legacy peer can unlink the observed entry during readlink on macOS.
        const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
        if (!stat) return null;
        if (!stat.isSymbolicLink()) break;
      }
    }
    throw new Error('Invalid process lock; it was preserved');
  }
  function releaseMarker(value) {
    if (readOwner() !== value) return;
    try {
      fs.unlinkSync(marker);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async function publishOwner() {
    while (true) {
      try {
        fs.symlinkSync(owner, marker);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const previous = readOwner();
      if (!previous) continue;
      try {
        process.kill(Number(previous.split('-')[0]), 0);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        releaseMarker(previous);
        continue;
      }
      await wait();
    }
  }
  try {
    while (true) {
      try {
        db.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
        await wait();
      }
    }
    await publishOwner();
    let closed = false;
    return {
      close() {
        if (closed) return;
        closed = true;
        try {
          releaseMarker(owner);
        } finally {
          db.close();
        }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
module.exports = { acquireProcessLock };
