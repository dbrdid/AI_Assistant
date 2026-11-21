import assert from 'node:assert/strict';
import { openDatabaseSync } from './expo-sqlite-node.mjs';
import { createLocalStore } from '../src/index.js';

/** 제어 가능한 시계와 순차 ID를 사용하는 메모리(또는 파일) DB 기반 스토어입니다. */
export function setup({ path = ':memory:', db, start = Date.UTC(2026, 10, 15, 1, 0, 0), onStatement, onListenerError } = {}) {
  const database = db ?? openDatabaseSync(path, { onStatement });
  const clock = { t: start };
  let n = 0;
  const store = createLocalStore({
    db: database,
    now: () => clock.t,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    onListenerError: onListenerError ?? (error => { throw error; }),
  });
  return { store, db: database, clock, tick: (ms = 1000) => { clock.t += ms; } };
}

/** 지정한 코드(필드가 주어진 경우에는 필드도)를 가진 LocalError가 발생하는지 확인합니다. */
export function rejects(fn, code, field) {
  assert.throws(fn, error => {
    assert.equal(error.name, 'LocalError', `expected LocalError ${code}, got ${error.name}: ${error.message}`);
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

/** "변경 사항 없음" 확인에 사용할 모든 테이블의 모든 행을 반환합니다. */
export function dump(db) {
  const tables = db.getAllSync("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").map(r => r.name);
  return Object.fromEntries(tables.map(t => [t, db.getAllSync(`select * from ${t} order by rowid`)]));
}

/** fn을 실행하고 지정한 LocalError 코드가 발생하며 어떤 행도 바뀌지 않았는지 확인합니다. */
export function rejectsUnchanged(t, fn, code, field) {
  const before = dump(t.db);
  rejects(fn, code, field);
  assert.deepEqual(dump(t.db), before);
}
