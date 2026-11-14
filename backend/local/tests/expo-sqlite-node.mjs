// Test double for the expo-sqlite synchronous API (openDatabaseSync) over Node's built-in node:sqlite.
// It implements only the methods the store uses, with the same names and result shapes, and is stricter than
// expo-sqlite where the two could differ: parameters must be an array of string, finite number, null or Uint8Array
// (no booleans or undefined), and a transaction cannot be nested. Tests only; the app passes the real expo-sqlite db.
import { DatabaseSync } from 'node:sqlite';

function bind(params) {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new TypeError('test adapter: pass bind parameters as an array');
  for (const value of params) {
    const ok = value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || value instanceof Uint8Array;
    if (!ok) throw new TypeError(`test adapter: unsupported bind value ${typeof value}`);
  }
  return params;
}

export function openDatabaseSync(path = ':memory:', { onStatement } = {}) {
  // node:sqlite turns foreign keys on by default; SQLite (and so expo-sqlite) leaves them off until the app asks.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  let inTransaction = false;
  const seen = sql => { if (onStatement) onStatement(sql); };
  return {
    execSync(source) { seen(source); db.exec(source); },
    runSync(source, params) {
      seen(source);
      const r = db.prepare(source).run(...bind(params));
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    getFirstSync(source, params) {
      seen(source);
      const row = db.prepare(source).get(...bind(params));
      return row === undefined ? null : { ...row };
    },
    getAllSync(source, params) {
      seen(source);
      return db.prepare(source).all(...bind(params)).map(row => ({ ...row }));
    },
    withTransactionSync(task) {
      if (inTransaction) throw new Error('cannot start a transaction within a transaction');
      db.exec('begin');
      inTransaction = true;
      try {
        task();
        db.exec('commit');
      } catch (error) {
        db.exec('rollback');
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    closeSync() { db.close(); },
  };
}
