import { fail } from './errors.js';
import { isPlainObject, uuid } from './validate.js';
import { SCHEMA_VERSION, createPersonal } from './schema.js';

/**
 * 개인 공간 내보내기·가져오기와 기기 초기화.
 *   - 백업(backup.ts의 createBackup·restoreBackup)에 넘길 내용은 exportAll()이 만들고 importAll()이 되돌립니다.
 *     공유 공간 기록은 서버에 있어서 백업에 넣지 않고, 복원 뒤 동기화로 다시 받습니다.
 *   - 로그아웃(다른 계정으로 로그인)·회원 탈퇴 뒤에는 clearAll()로 기기 기록을 지웁니다.
 */
export const EXPORT_FORMAT = 1;
const TABLES = {
  memos: ['id', 'title', 'body', 'strokes', 'photos', 'favorite', 'revision', 'created_at', 'updated_at', 'deleted_at'],
  tasks: ['id', 'kind', 'title', 'date', 'end_date', 'start_time', 'end_time', 'priority', 'status', 'alarm', 'assignee', 'place', 'project', 'project_id',
    'description', 'revision', 'created_at', 'updated_at', 'deleted_at'],
  memo_tasks: ['memo_id', 'task_id', 'position'],
  proposals: ['id', 'kind', 'title', 'date', 'end_date', 'start_time', 'end_time', 'place', 'assignee', 'priority', 'body', 'evidence', 'source_type', 'source_id',
    'source_title', 'source_revision', 'status', 'result_kind', 'result_id', 'created_at', 'updated_at'],
};
const personalId = ctx => ctx.db.getFirstSync('select id from workspaces where personal=1').id;

/** 개인 공간의 기록 개수 (백업 목록에 보여 줄 값) */
export function counts(ctx) {
  const p = personalId(ctx);
  const n = table => ctx.db.getFirstSync(`select count(*) as n from ${table} where workspace_id=?`, [p]).n;
  return { memos: n('memos'), tasks: n('tasks'), proposals: n('proposals') };
}

/** 개인 공간 전체를 JSON으로 바꿀 수 있는 객체로 */
export function exportAll(ctx) {
  const p = personalId(ctx);
  const out = { format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: ctx.now(), counts: counts(ctx) };
  for (const [table, columns] of Object.entries(TABLES)) {
    out[table] = ctx.db.getAllSync(`select ${columns.join(',')} from ${table} where workspace_id=? order by rowid`, [p]);
  }
  return out;
}

/** exportAll()의 결과로 개인 공간을 통째로 바꿈 (지금 개인 공간 기록은 지워짐). 공유 공간은 그대로. 가져온 개수를 돌려줌 */
export function importAll(ctx, payload) {
  if (!isPlainObject(payload) || payload.format !== EXPORT_FORMAT || !Number.isInteger(payload.schemaVersion) || payload.schemaVersion > SCHEMA_VERSION) fail('unsupported_backup');
  for (const table of Object.keys(TABLES)) {
    if (!Array.isArray(payload[table]) || !payload[table].every(isPlainObject)) fail('unsupported_backup', table);
  }
  const p = personalId(ctx);
  for (const table of ['proposals', 'memo_tasks', 'memos', 'tasks']) ctx.db.runSync(`delete from ${table} where workspace_id=?`, [p]);
  try {
    for (const table of ['memos', 'tasks', 'memo_tasks', 'proposals']) {
      const columns = TABLES[table];
      const sql = `insert into ${table}(workspace_id,${columns.join(',')}) values(?,${columns.map(() => '?').join(',')})`;
      for (const row of payload[table]) {
        const values = columns.map(c => row[c] ?? null);
        if (values.some(v => v !== null && typeof v !== 'string' && typeof v !== 'number')) fail('unsupported_backup', table);
        ctx.db.runSync(sql, [p, ...values]);
      }
    }
  } catch (error) {
    if (error?.name === 'LocalError') throw error;
    fail('unsupported_backup');   // 표 제약에 걸린 행(손상된 백업): 트랜잭션이 되돌려져 이전 기록은 그대로
  }
  ctx.touch('all');
  return counts(ctx);
}

/** 이 기기의 기록을 모두 지우고 빈 개인 공간으로 시작 (로그아웃·회원 탈퇴 뒤). 연결된 계정도 지움 */
export function clearAll(ctx) {
  for (const table of ['outbox', 'proposals', 'memo_tasks', 'memos', 'tasks', 'workspaces', 'settings']) ctx.db.runSync(`delete from ${table}`);
  ctx.setWs(createPersonal(ctx.db, { now: ctx.now, newId: ctx.newId }));
  ctx.touch('all');
  return true;
}

/** 이 기기 DB를 쓰는 계정 (없으면 null) */
export function getAccount(ctx) {
  return ctx.db.getFirstSync("select value from settings where key='account_id'")?.value ?? null;
}

/**
 * 로그인 직후에 부름. 처음이면 이 계정을 기억하고, 같은 계정이면 그대로, 다른 계정이면 account_mismatch.
 * account_mismatch면 화면에서 확인을 받고 clearAll() 뒤에 다시 부르세요 (앞 사람의 개인 기록이 보이지 않게).
 */
export function bindAccount(ctx, accountId) {
  const account = uuid(accountId, 'accountId');
  const bound = getAccount(ctx);
  if (bound === account) return account;
  if (bound !== null) fail('account_mismatch');
  ctx.db.runSync("insert into settings(key,value) values('account_id',?)", [account]);
  return account;
}
