// 기기 흉내: node:sqlite(진짜 SQLite 파일) → local-sync가 쓰는 SqlDb 모양
//   앱에서는 expo-sqlite를 expoSqliteDb()로 감싸서 똑같이 씀
const fs = require('node:fs');
const path = require('node:path');

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    console.error('\n[!] Node.js 22.13 이상이 필요해요 (내장 SQLite 사용). 지금 버전: ' + process.version);
    console.error('    https://nodejs.org 에서 LTS(24.x)를 설치한 뒤 다시 실행해 주세요.\n');
    process.exit(2);
  }
}

/** 기기 DB 열기 (파일이 있으면 이어서 씀 → 앱 재시작 흉내) */
function openDevice(file) {
  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  let depth = 0;
  const db = {
    exec: async (sql) => { d.exec(sql); },
    run: async (sql, params = []) => { d.prepare(sql).run(...params); },
    all: async (sql, params = []) => d.prepare(sql).all(...params).map((r) => ({ ...r })),
    get: async (sql, params = []) => { const r = d.prepare(sql).get(...params); return r ? { ...r } : undefined; },
    transaction: async (fn) => {
      if (depth > 0) return fn();
      depth++;
      d.exec('BEGIN');
      try {
        const out = await fn();
        d.exec('COMMIT');
        return out;
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return { db, file, close: () => d.close() };
}

/** 새 기기 (예전 파일은 지움) */
function newDevice(dir, name) {
  const file = path.join(dir, `${name}.db`);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  return openDevice(file);
}

module.exports = { openDevice, newDevice };
