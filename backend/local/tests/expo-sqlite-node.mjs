// Node 내장 node:sqlite로 expo-sqlite 동기 API(openDatabaseSync)를 대체하는 테스트 객체입니다.
// 스토어가 사용하는 메서드만 같은 이름과 결과 형태로 구현하며, 차이가 날 수 있는 부분에서는 expo-sqlite보다 엄격합니다.
// 매개변수는 문자열, 유한한 숫자, null 또는 Uint8Array로 이루어진 배열이어야 하며
// (불리언과 undefined는 허용하지 않음), 트랜잭션을 중첩할 수 없습니다. 테스트 전용이며 앱은 실제 expo-sqlite DB를 사용합니다.
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
  // node:sqlite는 외래 키를 기본으로 활성화하지만 SQLite(따라서 expo-sqlite)는 앱에서 요청할 때까지 비활성화합니다.
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
