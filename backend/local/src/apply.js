import { fail } from './errors.js';
import { isPlainObject, isUuid, uuid } from './validate.js';
import { canonStrokes } from './server.js';

/**
 * 보낼 목록에 아직 남아 있는(동기화 엔진에 안 넘어간) 저장이 건드린 것.
 *   ids: 기록 id (연결이면 양쪽 id) · favorites: 별표를 바꾼 메모 id
 * 엔진은 이 저장들을 아직 모르므로, 엔진 값으로 이 기록을 덮거나 지우면 방금 한 저장이 화면에서 사라집니다.
 */
function pendingTargets(ctx, workspaceId) {
  const ids = new Set(), favorites = new Set();
  for (const row of ctx.db.getAllSync('select changes from outbox where workspace_id=?', [workspaceId])) {
    for (const change of JSON.parse(row.changes)) {
      const data = isPlainObject(change.data) ? change.data : {};
      if (change.kind === 'favorite') {
        for (const noteId of Array.isArray(data.note_ids) ? data.note_ids : []) favorites.add(noteId);
        continue;
      }
      if (change.kind === 'upload') continue;   // 올리기를 기다리는 사진: 메모 내용과는 상관없음
      if (typeof change.id === 'string') ids.add(change.id);
      for (const [key, value] of Object.entries(data)) if (key.endsWith('_id') && typeof value === 'string') ids.add(value);
    }
  }
  return { ids, favorites };
}

/**
 * 서버에서 받은 공유 공간 기록을 기기 표에 반영합니다 (보낼 목록에는 적지 않음).
 *
 * 동기화 다리가 부르는 순서: ① peekOutbox로 꺼낸 변경을 local-sync의 saveLocal에 넘기고 ackOutbox
 * ② flush·pull ③ listLocal(안 보낸 내 수정이 얹힌 값)로 읽은 행을 applyServer에 넘김.
 * ①을 먼저 해야 안 보낸 내 수정이 서버 값으로 덮이지 않습니다.
 * ②·③ 사이에 화면에서 한 저장(아직 보낼 목록에 있음)이 건드린 기록은 건너뜁니다: 다음 동기화에서 엔진을 거쳐 맞춰집니다.
 *
 * items: [{ entity: 'notes' | 'tasks' | 'events', data: 서버 행, purged?: true }
 *        | { entity: 'note_attachments', data: { note_id, asset_id, position }, removed?: true }]
 * 돌려주는 값: 바뀐 개수 { notes, tasks, photos }
 */
export function applyServer(ctx, workspaceRef, items) {
  const ws = ctx.db.getFirstSync('select id, personal from workspaces where server_id=? or id=?', [workspaceRef, workspaceRef]) ?? fail('not_found');
  if (ws.personal === 1) fail('personal_workspace');
  if (!Array.isArray(items)) fail('invalid_input', 'items');
  const order = { notes: 0, tasks: 1, events: 1, note_attachments: 2 };
  for (const item of items) {
    if (!isPlainObject(item) || !(item.entity in order) || !isPlainObject(item.data)) fail('invalid_input', 'items');
  }
  const sorted = [...items].sort((a, b) => order[a.entity] - order[b.entity]);
  const count = { notes: 0, tasks: 0, photos: 0 };
  const t = ctx.now();
  const busy = pendingTargets(ctx, ws.id).ids;

  for (const item of sorted) {
    if (item.entity === 'notes') {
      const n = ctx.map.noteFromServer(item.data);
      uuid(n.id, 'id');
      if (busy.has(n.id)) continue;
      const cur = ctx.db.getFirstSync('select workspace_id,title,body,strokes,revision,updated_at,deleted_at from memos where id=?', [n.id]);
      if (cur && cur.workspace_id !== ws.id) fail('invalid_input', 'id');
      if (item.purged) {
        if (!cur) continue;
        if (ctx.db.runSync("update proposals set status='superseded',updated_at=? where workspace_id=? and source_type='memo' and source_id=? and status in ('pending','hold')", [t, ws.id, n.id]).changes) ctx.touch('proposals');
        ctx.db.runSync('delete from memos where id=?', [n.id]);
        count.notes++;
      } else if (!cur) {
        ctx.db.runSync('insert into memos(workspace_id,id,title,body,strokes,photos,favorite,revision,created_at,updated_at,deleted_at) values(?,?,?,?,?,?,0,1,?,?,?)',
          [ws.id, n.id, n.title, n.body, n.strokes, '[]', n.created_at ?? t, n.updated_at ?? t, n.deleted_at]);
        count.notes++;
      } else {
        const content = cur.title !== n.title || cur.body !== n.body || canonStrokes(cur.strokes) !== n.strokes;
        if (!content && cur.deleted_at === n.deleted_at) continue;   // 내용이 같으면 그대로 (수정 시각만 다른 것은 무시)
        ctx.db.runSync('update memos set title=?,body=?,strokes=?,revision=?,updated_at=?,deleted_at=? where id=?',
          [n.title, n.body, content ? n.strokes : cur.strokes, cur.revision + (content ? 1 : 0), content ? n.updated_at ?? t : cur.updated_at, n.deleted_at, n.id]);
        count.notes++;
      }
      ctx.touch('memos');
    } else if (item.entity === 'tasks' || item.entity === 'events') {
      const taskId = uuid(item.data.id, 'id');
      if (busy.has(taskId)) continue;
      const cur = ctx.db.getFirstSync('select * from tasks where id=?', [taskId]);
      if (cur && cur.workspace_id !== ws.id) fail('invalid_input', 'id');
      const f = item.purged ? null : ctx.map.taskFromServer(item.entity, item.data);
      if (item.purged) {
        if (!cur) continue;
        ctx.db.runSync('delete from tasks where id=?', [taskId]);
        count.tasks++;
        ctx.touch('tasks'); ctx.touch('memos');
        continue;
      }
      const cols = { kind: f.kind, title: f.title, date: f.date, end_date: f.end_date, start_time: f.start_time, end_time: f.end_time, priority: f.priority,
        status: f.status, alarm: f.alarm, assignee: f.assignee, place: f.place, project_id: f.project_id, description: f.description, deleted_at: f.deleted_at };
      let changed = false;
      if (!cur) {
        const keys = Object.keys(cols);
        ctx.db.runSync(`insert into tasks(workspace_id,id,${keys.join(',')},revision,created_at,updated_at) values(?,?,${keys.map(() => '?').join(',')},1,?,?)`,
          [ws.id, f.id, ...keys.map(k => cols[k]), f.created_at ?? t, f.updated_at ?? t]);
        changed = true;
      } else {
        // 기기가 더 자세히 아는 칸은 지킴: 할 일의 끝 시간(서버에 없음), 서버 0(안 정함)으로 내려온 중요도
        if (f.kind === 'task') cols.end_time = cur.end_time;
        const keys = Object.keys(cols).filter(k => cols[k] !== cur[k]
          && !(k === 'priority' && ctx.map.priorityCode(cur.priority) === ctx.map.priorityCode(cols.priority))
          && !(k === 'alarm' && ctx.map.alarmMinutes(cur.alarm) === ctx.map.alarmMinutes(cols.alarm)));
        if (keys.length) {
          ctx.db.runSync(`update tasks set ${keys.map(k => `${k}=?`).join(',')},revision=revision+1,updated_at=? where id=?`, [...keys.map(k => cols[k]), f.updated_at ?? t, f.id]);
          changed = true;
        }
      }
      const linked = ctx.db.getFirstSync('select memo_id from memo_tasks where task_id=? order by rowid limit 1', [f.id])?.memo_id ?? null;
      const wanted = f.noteId && ctx.db.getFirstSync('select 1 as ok from memos where workspace_id=? and id=?', [ws.id, f.noteId]) ? f.noteId : null;
      if (linked !== wanted) {
        ctx.db.runSync('delete from memo_tasks where task_id=?', [f.id]);
        if (wanted) {
          const { n } = ctx.db.getFirstSync('select count(*) as n from memo_tasks where memo_id=?', [wanted]);
          ctx.db.runSync('insert into memo_tasks(workspace_id,memo_id,task_id,position) values(?,?,?,?)', [ws.id, wanted, f.id, n]);
        }
        changed = true;
        ctx.touch('memos');
      }
      if (changed) { count.tasks++; ctx.touch('tasks'); ctx.touch('memos'); }
    } else {
      const { note_id: noteId, asset_id: assetId } = item.data;
      if (!isUuid(noteId) || !isUuid(assetId)) fail('invalid_input', 'items');
      if (busy.has(noteId)) continue;
      const memo = ctx.db.getFirstSync('select photos from memos where workspace_id=? and id=?', [ws.id, noteId]);
      if (!memo) continue;
      const photos = JSON.parse(memo.photos);
      const has = photos.includes(assetId);
      if (item.removed ? !has : has) continue;
      const next = item.removed ? photos.filter(p => p !== assetId) : [...photos, assetId];
      ctx.db.runSync('update memos set photos=? where id=?', [JSON.stringify(next), noteId]);
      count.photos++;
      ctx.touch('memos');
    }
  }
  return count;
}

/** 공유 공간의 내 즐겨찾기 전체를 서버 값(listNoteFavorites)으로 맞춤. 바뀐 개수. 아직 안 보낸 별표 변경이 있는 메모는 그대로 둠 */
export function applyFavorites(ctx, workspaceRef, noteIds) {
  const ws = ctx.db.getFirstSync('select id from workspaces where (server_id=? or id=?) and personal=0', [workspaceRef, workspaceRef]) ?? fail('not_found');
  if (!Array.isArray(noteIds) && !(noteIds instanceof Set)) fail('invalid_input', 'noteIds');
  const wanted = new Set(noteIds);
  const waiting = pendingTargets(ctx, ws.id).favorites;
  let changed = 0;
  for (const m of ctx.db.getAllSync('select id,favorite from memos where workspace_id=?', [ws.id])) {
    if (waiting.has(m.id)) continue;
    const value = wanted.has(m.id) ? 1 : 0;
    if (m.favorite !== value) {
      ctx.db.runSync('update memos set favorite=? where id=?', [value, m.id]);
      changed++;
    }
  }
  if (changed) ctx.touch('memos');
  return changed;
}

/** 공유 공간에 지금 있는 기록의 id (동기화 다리가 서버 목록과 맞춰 볼 때 씀): { notes: [{id, photos}], tasks: [{id, kind}] } */
export function sharedState(ctx, workspaceRef) {
  const ws = ctx.db.getFirstSync('select id from workspaces where (server_id=? or id=?) and personal=0', [workspaceRef, workspaceRef]) ?? fail('not_found');
  return {
    notes: ctx.db.getAllSync('select id, photos from memos where workspace_id=?', [ws.id]).map(r => ({ id: r.id, photos: JSON.parse(r.photos) })),
    tasks: ctx.db.getAllSync('select id, kind from tasks where workspace_id=?', [ws.id]),
  };
}
