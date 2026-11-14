import assert from 'node:assert/strict';
import { openDatabaseSync } from './expo-sqlite-node.mjs';
import { createLocalStore } from '../src/index.js';

/** A store over an in-memory (or file) database with a controllable clock and sequential ids. */
export function setup({ path = ':memory:', db, start = Date.UTC(2026, 10, 15, 1, 0, 0), onStatement, onListenerError } = {}) {
  const database = db ?? openDatabaseSync(path, { onStatement });
  const clock = { t: start };
  let n = 0;
  const store = createLocalStore({
    db: database,
    now: () => clock.t,
    newId: () => `id-${String(++n).padStart(4, '0')}`,
    onListenerError: onListenerError ?? (error => { throw error; }),
  });
  return { store, db: database, clock, tick: (ms = 1000) => { clock.t += ms; } };
}

/** Asserts a LocalError with the given code (and field, when given). */
export function rejects(fn, code, field) {
  assert.throws(fn, error => {
    assert.equal(error.name, 'LocalError', `expected LocalError ${code}, got ${error.name}: ${error.message}`);
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

/** Every row of every table, for "nothing changed" assertions. */
export function dump(db) {
  const tables = db.getAllSync("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").map(r => r.name);
  return Object.fromEntries(tables.map(t => [t, db.getAllSync(`select * from ${t} order by rowid`)]));
}

/** Runs fn and asserts it threw the LocalError code without changing any row. */
export function rejectsUnchanged(t, fn, code, field) {
  const before = dump(t.db);
  rejects(fn, code, field);
  assert.deepEqual(dump(t.db), before);
}
