import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA_VERSION = 1;
const SCHEMA = new URL('./schema.sql', import.meta.url);

/**
 * Opens (and on first use creates) the SQLite database. ':memory:' gives a throwaway database for tests.
 * Every connection turns foreign keys on; file databases use WAL and wait up to busyTimeoutMs for another writer.
 * The file holds every workspace's rows in the clear (ciphertext aside): keep it readable by the server process only.
 */
export function openDatabase(path = ':memory:', { busyTimeoutMs = 5000 } = {}) {
  if (typeof path !== 'string' || !path) throw new Error('Database path required');
  const db = new DatabaseSync(path);
  try {
    db.exec('pragma foreign_keys=on');
    db.exec(`pragma busy_timeout=${Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 ? busyTimeoutMs : 5000}`);
    if (path !== ':memory:') db.exec('pragma journal_mode=wal');
    migrate(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Applies db/schema.sql once, recorded in user_version. A later schema change adds a numbered step here. */
export function migrate(db) {
  const { user_version: version } = db.prepare('pragma user_version').get();
  if (version === SCHEMA_VERSION) return;
  if (version !== 0) throw new Error(`Unknown schema version ${version}`);
  transaction(db, () => {
    db.exec(readFileSync(SCHEMA, 'utf8'));
    db.exec(`pragma user_version=${SCHEMA_VERSION}`);
  });
}

/**
 * Runs fn in one write transaction (BEGIN IMMEDIATE takes the write lock up front, so two processes never
 * interleave inside an RPC). Any throw rolls everything back. fn must be synchronous: node:sqlite is, and an
 * await inside would let another call run in the middle of this transaction.
 */
export function transaction(db, fn) {
  if (db.isTransaction) throw new Error('Nested transaction');
  db.exec('begin immediate');
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('Transaction callback must be synchronous');
    db.exec('commit');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('rollback');
    throw error;
  }
}
