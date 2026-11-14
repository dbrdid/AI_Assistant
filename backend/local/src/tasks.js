import { fail } from './errors.js';
import { LIMITS, dateKey, id, onlyKeys, positiveInt, text, timeOfDay } from './validate.js';

/** Default labels, the values TaskEditScreen starts a new item with. */
export const TASK_DEFAULTS = Object.freeze({ priority: '보통', status: '진행 전', alarm: '없음' });
export const DONE = '완료';

const FIELDS = ['title', 'date', 'start', 'end', 'priority', 'status', 'alarm', 'assignee', 'place', 'project', 'desc'];
const COLUMNS = 'id,title,date,start_time,end_time,priority,status,alarm,assignee,place,project,description,revision,created_at,updated_at';
const COLUMN_OF = { title: 'title', date: 'date', start: 'start_time', end: 'end_time', priority: 'priority', status: 'status', alarm: 'alarm', assignee: 'assignee', place: 'place', project: 'project', desc: 'description' };

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    start: row.start_time,
    end: row.end_time,
    priority: row.priority,
    status: row.status,
    alarm: row.alarm,
    assignee: row.assignee,
    place: row.place,
    project: row.project,
    desc: row.description,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function checkField(key, value) {
  switch (key) {
    case 'title': return text(value, 'title', LIMITS.short, { required: true });
    case 'date': return dateKey(value);
    case 'start': case 'end': return timeOfDay(value, key);
    case 'priority': case 'status': case 'alarm': return text(value, key, LIMITS.label, { required: true });
    case 'desc': return text(value, 'desc', LIMITS.desc);
    default: return text(value, key, LIMITS.short);
  }
}

function checked(input, field) {
  onlyKeys(input, FIELDS, field);
  const v = {};
  for (const key of Object.keys(input)) v[key] = checkField(key, input[key]);
  return v;
}

/** The tasks of the current workspace: by date, untimed items first, then by start time and creation. */
export function listTasks(ctx) {
  return ctx.db.getAllSync(`select ${COLUMNS} from tasks where workspace_id=? order by date, start_time, created_at, id`, [ctx.ws()])
    .map(r => ctx.freeze(toTask(r)));
}

export function getTask(ctx, taskId) {
  if (typeof taskId !== 'string') return null;
  const r = ctx.db.getFirstSync(`select ${COLUMNS} from tasks where workspace_id=? and id=?`, [ctx.ws(), taskId]);
  return r ? ctx.freeze(toTask(r)) : null;
}

function requireRow(ctx, taskId) {
  id(taskId);
  return ctx.db.getFirstSync(`select ${COLUMNS} from tasks where workspace_id=? and id=?`, [ctx.ws(), taskId]) ?? fail('not_found');
}

/** Creates a task (an event when it has a start time). title and date are required; labels default as in the editor. */
export function addTask(ctx, input) {
  const v = checked(input, 'input');
  if (!('title' in v)) fail('invalid_input', 'title');
  if (!('date' in v)) fail('invalid_input', 'date');
  const taskId = ctx.newId(), t = ctx.now();
  ctx.db.runSync(
    `insert into tasks(workspace_id,id,title,date,start_time,end_time,priority,status,alarm,assignee,place,project,description,revision,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [ctx.ws(), taskId, v.title, v.date, v.start ?? '', v.end ?? '', v.priority ?? TASK_DEFAULTS.priority, v.status ?? TASK_DEFAULTS.status,
      v.alarm ?? TASK_DEFAULTS.alarm, v.assignee ?? '', v.place ?? '', v.project ?? '', v.desc ?? '', t, t],
  );
  ctx.touch('tasks');
  return getTask(ctx, taskId);
}

/** Changes the given fields; any real change raises the revision and updatedAt. expectedRevision as in updateMemo. */
export function updateTask(ctx, taskId, patch, { expectedRevision } = {}) {
  const current = toTask(requireRow(ctx, taskId));
  const v = checked(patch, 'patch');
  if (expectedRevision !== undefined && positiveInt(expectedRevision, 'expectedRevision') !== current.revision) fail('revision_conflict');
  const changed = Object.keys(v).filter(key => v[key] !== current[key]);
  if (changed.length) {
    ctx.db.runSync(
      `update tasks set ${changed.map(key => `${COLUMN_OF[key]}=?`).join(',')},revision=revision+1,updated_at=? where id=?`,
      [...changed.map(key => v[key]), ctx.now(), taskId],
    );
    ctx.touch('tasks');
  }
  return getTask(ctx, taskId);
}

/** Deletes a task; memos that linked it lose the link. */
export function deleteTask(ctx, taskId) {
  requireRow(ctx, taskId);
  const linked = ctx.db.getFirstSync('select count(*) as n from memo_tasks where task_id=?', [taskId]).n;
  ctx.db.runSync('delete from tasks where id=?', [taskId]);
  ctx.touch('tasks');
  if (linked) ctx.touch('memos');
  return true;
}

/** Switches between done ('완료') and not started ('진행 전'). */
export function toggleDone(ctx, taskId) {
  const current = requireRow(ctx, taskId);
  return updateTask(ctx, taskId, { status: current.status === DONE ? TASK_DEFAULTS.status : DONE });
}

const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/**
 * The first open (not done) task on the same date whose time overlaps the given one, or null. Untimed items never
 * clash. A missing end makes a point in time; ranges that only touch (10:00-11:00 and 11:00-12:00) do not clash.
 */
export function findOverlap(ctx, fields, excludeId) {
  if (fields === null || typeof fields !== 'object') fail('invalid_input', 'fields');
  const date = dateKey(fields.date);
  const start = timeOfDay(fields.start ?? '', 'start');
  const end = timeOfDay(fields.end ?? '', 'end');
  if (!start) return null;
  const aStart = minutes(start), aEnd = end ? minutes(end) : aStart;
  const rows = ctx.db.getAllSync(
    `select ${COLUMNS} from tasks where workspace_id=? and date=? and start_time<>'' and status<>? order by start_time, created_at, id`,
    [ctx.ws(), date, DONE],
  );
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const bStart = minutes(r.start_time), bEnd = r.end_time ? minutes(r.end_time) : bStart;
    // Half-open ranges [start, end); a point p lies in [s, e) when s <= p < e. Equal starts always clash.
    const clash = aStart === bStart || (aStart < bEnd && bStart < aEnd);
    if (clash) return ctx.freeze(toTask(r));
  }
  return null;
}

const normalTitle = s => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** A task on the same date with the same title (ignoring case and spacing), or null. */
export function findSameTask(ctx, date, title) {
  const wanted = normalTitle(title);
  for (const r of ctx.db.getAllSync(`select ${COLUMNS} from tasks where workspace_id=? and date=? order by created_at, id`, [ctx.ws(), date])) {
    if (normalTitle(r.title) === wanted) return ctx.freeze(toTask(r));
  }
  return null;
}
