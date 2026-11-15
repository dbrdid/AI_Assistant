import { fail } from './errors.js';
import { LIMITS, dateKey, id, idList, onlyKeys, optionalDateKey, optionalUuid, positiveInt, text, timeOfDay } from './validate.js';

/** 새 항목의 기본 글자 (TaskEditScreen이 시작할 때 쓰는 값) */
export const TASK_DEFAULTS = Object.freeze({ priority: '보통', status: '진행 전', alarm: '없음' });
export const DONE = '완료';

const PATCH_FIELDS = ['title', 'date', 'endDate', 'start', 'end', 'priority', 'status', 'alarm', 'assignee', 'place', 'project', 'projectId', 'desc'];
const ADD_FIELDS = [...PATCH_FIELDS, 'kind'];
const COLUMNS = 'id,kind,title,date,end_date,start_time,end_time,priority,status,alarm,assignee,place,project,project_id,description,revision,created_at,updated_at,deleted_at';
const COLUMN_OF = {
  title: 'title', date: 'date', endDate: 'end_date', start: 'start_time', end: 'end_time', priority: 'priority', status: 'status', alarm: 'alarm',
  assignee: 'assignee', place: 'place', project: 'project', projectId: 'project_id', desc: 'description',
};

function toTask(row) {
  return {
    id: row.id,
    kind: row.kind,                 // 'task'(할 일) | 'event'(일정). 만들 때 정해지고 바뀌지 않음
    title: row.title,
    date: row.date,
    endDate: row.end_date,          // 여러 날 일정의 끝 날짜 ('' = 같은 날)
    start: row.start_time,
    end: row.end_time,
    priority: row.priority,
    status: row.status,
    alarm: row.alarm,
    assignee: row.assignee,
    place: row.place,
    project: row.project,
    projectId: row.project_id,
    desc: row.description,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function checkField(key, value) {
  switch (key) {
    case 'kind': return value === 'task' || value === 'event' ? value : fail('invalid_input', 'kind');
    case 'title': return text(value, 'title', LIMITS.title, { required: true });
    case 'date': return dateKey(value);
    case 'endDate': return optionalDateKey(value, 'endDate');
    case 'start': case 'end': return timeOfDay(value, key);
    case 'priority': case 'status': case 'alarm': return text(value, key, LIMITS.label, { required: true });
    case 'desc': return text(value, 'desc', LIMITS.desc);
    case 'assignee': return text(value, 'assignee', LIMITS.assignee);
    case 'projectId': return optionalUuid(value, 'projectId');
    default: return text(value, key, LIMITS.short);
  }
}

function checked(input, allowed, field) {
  onlyKeys(input, allowed, field);
  const v = {};
  for (const key of Object.keys(input)) v[key] = checkField(key, input[key]);
  return v;
}

/** 현재 워크스페이스의 일정·할 일 (휴지통 제외): 날짜순, 같은 날은 시간 없는 것 먼저 */
export function listTasks(ctx, trashed = false) {
  return ctx.db.getAllSync(
    `select ${COLUMNS} from tasks where workspace_id=? and deleted_at is ${trashed ? 'not null order by deleted_at desc' : 'null order by date, start_time, created_at'}, id`,
    [ctx.ws()],
  ).map(r => ctx.freeze(toTask(r)));
}

function rowOf(ctx, taskId, withTrashed = false) {
  return ctx.db.getFirstSync(`select ${COLUMNS} from tasks where workspace_id=? and id=?${withTrashed ? '' : ' and deleted_at is null'}`, [ctx.ws(), taskId]);
}

export function getTask(ctx, taskId) {
  if (typeof taskId !== 'string') return null;
  const r = rowOf(ctx, taskId);
  return r ? ctx.freeze(toTask(r)) : null;
}

function requireRow(ctx, taskId) {
  id(taskId);
  return rowOf(ctx, taskId) ?? fail('not_found');
}

/** 이 일정·할 일을 연결한 메모 (공유 공간은 하나뿐) */
export function noteIdOf(ctx, taskId) {
  return ctx.db.getFirstSync('select memo_id from memo_tasks where task_id=? order by rowid limit 1', [taskId])?.memo_id ?? null;
}

/** 서버로 보낼 모양 (공유 공간에서만 부름). 서버가 받을 수 없으면 invalid_input */
function serverData(ctx, row) {
  return ctx.map.taskData(row, noteIdOf(ctx, row.id));
}

/** 연결된 메모가 바뀐 일정·할 일의 note_id를 서버에 알림 (memos.js가 연결을 바꾼 뒤 부름) */
export function queueNoteLink(ctx, taskId, noteId) {
  const r = rowOf(ctx, taskId, true);
  if (r) ctx.queue([{ kind: 'update', entity: ctx.map.taskEntity(r), id: taskId, data: { note_id: noteId } }]);
}

/**
 * 일정·할 일을 만듦. title·date 필수. kind를 안 주면 시작 시간이 있을 때 일정('event'), 없으면 할 일('task').
 * memoId를 주면 그 메모에 연결함 (AI 제안 승인 때).
 */
export function addTask(ctx, input, { memoId = null } = {}) {
  const v = checked(input, ADD_FIELDS, 'input');
  if (!('title' in v)) fail('invalid_input', 'title');
  if (!('date' in v)) fail('invalid_input', 'date');
  const taskId = ctx.newId(), t = ctx.now();
  const kind = v.kind ?? (v.start ? 'event' : 'task');
  ctx.db.runSync(
    `insert into tasks(workspace_id,id,kind,title,date,end_date,start_time,end_time,priority,status,alarm,assignee,place,project,project_id,description,revision,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [ctx.ws(), taskId, kind, v.title, v.date, v.endDate ?? '', v.start ?? '', v.end ?? '', v.priority ?? TASK_DEFAULTS.priority, v.status ?? TASK_DEFAULTS.status,
      v.alarm ?? TASK_DEFAULTS.alarm, v.assignee ?? '', v.place ?? '', v.project ?? '', v.projectId ?? null, v.desc ?? '', t, t],
  );
  if (memoId) {
    const { n } = ctx.db.getFirstSync('select count(*) as n from memo_tasks where memo_id=?', [memoId]);
    ctx.db.runSync('insert into memo_tasks(workspace_id,memo_id,task_id,position) values(?,?,?,?)', [ctx.ws(), memoId, taskId, n]);
    ctx.touch('memos');
  }
  if (ctx.shared()) {
    const row = rowOf(ctx, taskId);
    ctx.queue([{ kind: 'create', entity: ctx.map.taskEntity(row), id: taskId, data: serverData(ctx, row) }]);
  }
  ctx.touch('tasks');
  return getTask(ctx, taskId);
}

/** 준 칸만 바꿈. 실제로 바뀌면 revision·updatedAt이 오름. expectedRevision은 updateMemo와 같음 */
export function updateTask(ctx, taskId, patch, { expectedRevision } = {}) {
  const beforeRow = requireRow(ctx, taskId);
  const current = toTask(beforeRow);
  const v = checked(patch, PATCH_FIELDS, 'patch');
  if (expectedRevision !== undefined && positiveInt(expectedRevision, 'expectedRevision') !== current.revision) fail('revision_conflict');
  const changed = Object.keys(v).filter(key => v[key] !== current[key]);
  if (changed.length) {
    const before = ctx.shared() ? serverData(ctx, beforeRow) : null;
    ctx.db.runSync(
      `update tasks set ${changed.map(key => `${COLUMN_OF[key]}=?`).join(',')},revision=revision+1,updated_at=? where id=?`,
      [...changed.map(key => v[key]), ctx.now(), taskId],
    );
    if (before) {
      const row = rowOf(ctx, taskId);
      const data = ctx.map.diff(before, serverData(ctx, row));
      if (Object.keys(data).length) ctx.queue([{ kind: 'update', entity: ctx.map.taskEntity(row), id: taskId, data }]);
    }
    ctx.touch('tasks');
  }
  return getTask(ctx, taskId);
}

/**
 * 일정·할 일을 지움. 개인 공간은 바로 지우고(화면 규칙), 공유 공간은 서버처럼 휴지통으로 보냄(30일 뒤 서버가 영구 삭제).
 * 이 항목을 연결한 메모의 taskIds에서도 빠짐.
 */
export function deleteTask(ctx, taskId) {
  const row = requireRow(ctx, taskId);
  const linked = ctx.db.getFirstSync('select count(*) as n from memo_tasks where task_id=?', [taskId]).n;
  if (ctx.shared()) {
    ctx.db.runSync('update tasks set deleted_at=? where id=?', [ctx.now(), taskId]);
    ctx.queue([{ kind: 'delete', entity: ctx.map.taskEntity(row), id: taskId }]);
  } else {
    ctx.db.runSync('delete from tasks where id=?', [taskId]);
  }
  ctx.touch('tasks');
  if (linked) ctx.touch('memos');
  return true;
}

function eachTrashed(ctx, ids, fn) {
  let count = 0;
  for (const taskId of idList(ids, 'ids')) {
    const r = rowOf(ctx, taskId, true);
    if (r && r.deleted_at !== null && fn(r)) count++;
  }
  if (count) { ctx.touch('tasks'); ctx.touch('memos'); }
  return count;
}

/** 휴지통의 일정·할 일을 되살림 (공유 공간). 되살린 개수 */
export function restoreTasks(ctx, ids) {
  return eachTrashed(ctx, ids, r => {
    ctx.db.runSync('update tasks set deleted_at=null where id=?', [r.id]);
    ctx.queue([{ kind: 'restore', entity: ctx.map.taskEntity(r), id: r.id }]);
    return true;
  });
}

/** 휴지통의 일정·할 일을 영구 삭제 (공유 공간: 서버는 관리자·지운 사람만 허용, 아니면 동기화가 충돌로 알려 줌). 지운 개수 */
export function deleteTasksForever(ctx, ids) {
  return eachTrashed(ctx, ids, r => {
    ctx.db.runSync('delete from tasks where id=?', [r.id]);
    ctx.queue([{ kind: 'purge', entity: ctx.map.taskEntity(r), id: r.id }]);
    return true;
  });
}

/** 완료('완료') ↔ 진행 전('진행 전') */
export function toggleDone(ctx, taskId) {
  const current = requireRow(ctx, taskId);
  return updateTask(ctx, taskId, { status: current.status === DONE ? TASK_DEFAULTS.status : DONE });
}

const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/**
 * 같은 날 시간이 겹치는 첫 미완료 항목 또는 null. 시간 없는 항목은 겹치지 않음.
 * 끝 시간이 없으면 한 시점. 맞닿기만 한 범위(10:00-11:00, 11:00-12:00)는 겹치지 않음.
 */
export function findOverlap(ctx, fields, excludeId) {
  if (fields === null || typeof fields !== 'object') fail('invalid_input', 'fields');
  const date = dateKey(fields.date);
  const start = timeOfDay(fields.start ?? '', 'start');
  const end = timeOfDay(fields.end ?? '', 'end');
  if (!start) return null;
  const aStart = minutes(start), aEnd = end ? minutes(end) : aStart;
  const rows = ctx.db.getAllSync(
    `select ${COLUMNS} from tasks where workspace_id=? and deleted_at is null and date=? and start_time<>'' and status<>? order by start_time, created_at, id`,
    [ctx.ws(), date, DONE],
  );
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const bStart = minutes(r.start_time), bEnd = r.end_time ? minutes(r.end_time) : bStart;
    const clash = aStart === bStart || (aStart < bEnd && bStart < aEnd);
    if (clash) return ctx.freeze(toTask(r));
  }
  return null;
}

const normalTitle = s => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** 같은 날 같은 제목(대소문자·공백 무시)의 항목 또는 null */
export function findSameTask(ctx, date, title) {
  const wanted = normalTitle(title);
  for (const r of ctx.db.getAllSync(`select ${COLUMNS} from tasks where workspace_id=? and deleted_at is null and date=? order by created_at, id`, [ctx.ws(), date])) {
    if (normalTitle(r.title) === wanted) return ctx.freeze(toTask(r));
  }
  return null;
}
