import { fail } from './errors.js';
import { LIMITS, bool, id, idList, onlyKeys, positiveInt, strokesJson, text } from './validate.js';

const FIELDS = ['title', 'body', 'strokes', 'photos', 'taskIds', 'favorite'];
const COLUMNS = 'id,title,body,strokes,photos,favorite,revision,created_at,updated_at,deleted_at';

function linkMap(ctx) {
  const map = new Map();
  for (const row of ctx.db.getAllSync('select memo_id,task_id from memo_tasks where workspace_id=? order by memo_id,position', [ctx.ws()])) {
    if (!map.has(row.memo_id)) map.set(row.memo_id, []);
    map.get(row.memo_id).push(row.task_id);
  }
  return map;
}

function toMemo(row, taskIds) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    strokes: JSON.parse(row.strokes),
    photos: JSON.parse(row.photos),
    taskIds,
    favorite: row.favorite === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

/**
 * The memos of the current workspace, in the trash or not. Objects of memos that did not change since the previous
 * listing are reused (strokes are parsed only after an edit), so unchanged items keep their identity.
 */
export function listMemos(ctx, trashed, reuse) {
  const rows = ctx.db.getAllSync(
    `select ${COLUMNS} from memos where workspace_id=? and deleted_at is ${trashed ? 'not null order by deleted_at desc' : 'null order by updated_at desc'}, id`,
    [ctx.ws()],
  );
  const links = linkMap(ctx);
  const next = new Map();
  const list = rows.map(row => {
    const taskIds = links.get(row.id) ?? [];
    const key = `${ctx.ws()}|${row.revision}|${row.updated_at}|${row.deleted_at}|${row.favorite}|${row.photos}|${taskIds.join(',')}`;
    const cached = reuse.get(row.id);
    const memo = cached && cached.key === key ? cached.memo : ctx.freeze(toMemo(row, taskIds));
    next.set(row.id, { key, memo });
    return memo;
  });
  reuse.clear();
  for (const [k, v] of next) reuse.set(k, v);
  return list;
}

function row(ctx, memoId) {
  return ctx.db.getFirstSync(`select ${COLUMNS} from memos where workspace_id=? and id=?`, [ctx.ws(), memoId]);
}

function taskIdsOf(ctx, memoId) {
  return ctx.db.getAllSync('select task_id from memo_tasks where memo_id=? order by position', [memoId]).map(r => r.task_id);
}

/** One memo of the current workspace, also when it is in the trash; null when there is none. */
export function getMemo(ctx, memoId) {
  if (typeof memoId !== 'string') return null;
  const r = row(ctx, memoId);
  return r ? ctx.freeze(toMemo(r, taskIdsOf(ctx, memoId))) : null;
}

function requireMemo(ctx, memoId) {
  id(memoId);
  return row(ctx, memoId) ?? fail('not_found');
}

function setLinks(ctx, memoId, taskIds) {
  for (const taskId of taskIds) {
    if (!ctx.db.getFirstSync('select 1 as ok from tasks where workspace_id=? and id=?', [ctx.ws(), taskId])) fail('not_found', 'taskIds');
  }
  ctx.db.runSync('delete from memo_tasks where memo_id=?', [memoId]);
  taskIds.forEach((taskId, position) => {
    ctx.db.runSync('insert into memo_tasks(workspace_id,memo_id,task_id,position) values(?,?,?,?)', [ctx.ws(), memoId, taskId, position]);
  });
}

/** Appends a task link without touching the memo's content or revision (used when an AI proposal is approved). */
export function linkTask(ctx, memoId, taskId) {
  const exists = ctx.db.getFirstSync('select 1 as ok from memo_tasks where memo_id=? and task_id=?', [memoId, taskId]);
  if (exists) return;
  const { n } = ctx.db.getFirstSync('select count(*) as n from memo_tasks where memo_id=?', [memoId]);
  ctx.db.runSync('insert into memo_tasks(workspace_id,memo_id,task_id,position) values(?,?,?,?)', [ctx.ws(), memoId, taskId, n]);
  ctx.touch('memos');
}

function checkFields(input) {
  const v = {};
  if ('title' in input) v.title = text(input.title, 'title', LIMITS.title);
  if ('body' in input) v.body = text(input.body, 'body', LIMITS.body);
  if ('strokes' in input) v.strokes = strokesJson(input.strokes);
  if ('photos' in input) v.photos = JSON.stringify(idList(input.photos, 'photos'));
  if ('taskIds' in input) v.taskIds = idList(input.taskIds, 'taskIds');
  if ('favorite' in input) v.favorite = bool(input.favorite, 'favorite') ? 1 : 0;
  return v;
}

const isEmpty = (title, body, strokes) => !title.trim() && !body.trim() && strokes === '[]';

/** Creates a memo in the current workspace. At least one of title, body or strokes must have content. */
export function addMemo(ctx, input) {
  onlyKeys(input, FIELDS);
  const v = checkFields(input);
  const title = v.title ?? '', body = v.body ?? '', strokes = v.strokes ?? '[]';
  if (isEmpty(title, body, strokes)) fail('empty_memo');
  const memoId = ctx.newId(), t = ctx.now();
  ctx.db.runSync(
    'insert into memos(workspace_id,id,title,body,strokes,photos,favorite,revision,created_at,updated_at) values(?,?,?,?,?,?,?,1,?,?)',
    [ctx.ws(), memoId, title, body, strokes, v.photos ?? '[]', v.favorite ?? 0, t, t],
  );
  if (v.taskIds) setLinks(ctx, memoId, v.taskIds);
  ctx.touch('memos');
  return getMemo(ctx, memoId);
}

/**
 * Changes the given fields. A change to title, body or strokes raises the revision and updatedAt; photos, taskIds
 * and favorite change neither. Nothing is written when nothing differs. With expectedRevision, a memo edited since
 * fails with revision_conflict.
 */
export function updateMemo(ctx, memoId, patch, { expectedRevision } = {}) {
  const current = requireMemo(ctx, memoId);
  onlyKeys(patch, FIELDS, 'patch');
  const v = checkFields(patch);
  if (expectedRevision !== undefined && positiveInt(expectedRevision, 'expectedRevision') !== current.revision) fail('revision_conflict');
  const title = v.title ?? current.title, body = v.body ?? current.body, strokes = v.strokes ?? current.strokes;
  const contentChanged = title !== current.title || body !== current.body || strokes !== current.strokes;
  if (contentChanged && isEmpty(title, body, strokes)) fail('empty_memo');
  const photos = v.photos ?? current.photos, favorite = v.favorite ?? current.favorite;
  if (contentChanged || photos !== current.photos || favorite !== current.favorite) {
    ctx.db.runSync(
      'update memos set title=?,body=?,strokes=?,photos=?,favorite=?,revision=?,updated_at=? where id=?',
      [title, body, strokes, photos, favorite, current.revision + (contentChanged ? 1 : 0), contentChanged ? ctx.now() : current.updated_at, memoId],
    );
    ctx.touch('memos');
  }
  if (v.taskIds && v.taskIds.join('\n') !== taskIdsOf(ctx, memoId).join('\n')) {
    setLinks(ctx, memoId, v.taskIds);
    ctx.touch('memos');
  }
  return getMemo(ctx, memoId);
}

export function trashMemo(ctx, memoId) {
  const current = requireMemo(ctx, memoId);
  if (current.deleted_at === null) {
    ctx.db.runSync('update memos set deleted_at=? where id=?', [ctx.now(), memoId]);
    ctx.touch('memos');
  }
  return true;
}

function eachExisting(ctx, ids, field, fn) {
  let count = 0;
  for (const memoId of idList(ids, field)) {
    const current = row(ctx, memoId);
    if (current && fn(current)) count++;
  }
  if (count) ctx.touch('memos');
  return count;
}

/** Moves memos to the trash. Ids not in the current workspace are skipped. Returns how many moved. */
export function trashMemos(ctx, ids) {
  const t = ctx.now();
  return eachExisting(ctx, ids, 'ids', m => m.deleted_at === null && ctx.db.runSync('update memos set deleted_at=? where id=?', [t, m.id]).changes === 1);
}

/** Takes memos out of the trash. Returns how many were restored. */
export function restoreMemos(ctx, ids) {
  return eachExisting(ctx, ids, 'ids', m => m.deleted_at !== null && ctx.db.runSync('update memos set deleted_at=null where id=?', [m.id]).changes === 1);
}

/** Deletes memos for good, with their task links; their open AI proposals are withdrawn (superseded). */
export function deleteMemosForever(ctx, ids) {
  const t = ctx.now();
  const removed = eachExisting(ctx, ids, 'ids', m => {
    const withdrawn = ctx.db.runSync(
      "update proposals set status='superseded',updated_at=? where workspace_id=? and source_type='memo' and source_id=? and status in ('pending','hold')",
      [t, ctx.ws(), m.id],
    ).changes;
    if (withdrawn) ctx.touch('proposals');
    return ctx.db.runSync('delete from memos where id=?', [m.id]).changes === 1;
  });
  return removed;
}

export function deleteMemoForever(ctx, memoId) {
  requireMemo(ctx, memoId);
  deleteMemosForever(ctx, [memoId]);
  return true;
}

/** Marks or unmarks memos as favorites. Returns how many changed. */
export function setFavorites(ctx, ids, favorite) {
  const value = bool(favorite, 'favorite') ? 1 : 0;
  return eachExisting(ctx, ids, 'ids', m => m.favorite !== value && ctx.db.runSync('update memos set favorite=? where id=?', [value, m.id]).changes === 1);
}

/** Adds a file id to the memo's photos (once). */
export function attachPhoto(ctx, memoId, fileId) {
  const current = requireMemo(ctx, memoId);
  id(fileId, 'fileId');
  const photos = JSON.parse(current.photos);
  if (!photos.includes(fileId)) {
    photos.push(fileId);
    ctx.db.runSync('update memos set photos=? where id=?', [JSON.stringify(photos), memoId]);
    ctx.touch('memos');
  }
  return getMemo(ctx, memoId);
}

export function detachPhoto(ctx, memoId, fileId) {
  const current = requireMemo(ctx, memoId);
  id(fileId, 'fileId');
  const photos = JSON.parse(current.photos);
  if (photos.includes(fileId)) {
    ctx.db.runSync('update memos set photos=? where id=?', [JSON.stringify(photos.filter(p => p !== fileId)), memoId]);
    ctx.touch('memos');
  }
  return getMemo(ctx, memoId);
}

/** The raw row, for proposals (revision checks and links). */
export function memoRow(ctx, memoId) {
  return typeof memoId === 'string' ? row(ctx, memoId) : null;
}
