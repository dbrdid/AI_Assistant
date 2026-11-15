import { fail } from './errors.js';
import { LIMITS, bool, id, idList, isUuid, onlyKeys, positiveInt, strokesJson, text, uuid } from './validate.js';
import { noteIdOf, queueNoteLink } from './tasks.js';

const FIELDS = ['title', 'body', 'strokes', 'photos', 'taskIds', 'favorite'];
const COLUMNS = 'id,title,body,strokes,photos,favorite,revision,created_at,updated_at,deleted_at';
// 휴지통에 있는 일정·할 일은 메모의 taskIds에서 빠짐
const LINKS = 'select l.memo_id, l.task_id from memo_tasks l join tasks t on t.id = l.task_id and t.deleted_at is null';

function linkMap(ctx) {
  const map = new Map();
  for (const row of ctx.db.getAllSync(`${LINKS} where l.workspace_id=? order by l.memo_id, l.position`, [ctx.ws()])) {
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

/** 현재 워크스페이스의 메모 (휴지통 안 또는 밖). 바뀌지 않은 메모는 이전 객체를 그대로 돌려줌 */
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
  return ctx.db.getAllSync(`${LINKS} where l.memo_id=? order by l.position`, [memoId]).map(r => r.task_id);
}

/** 현재 워크스페이스의 메모 하나 (휴지통 포함). 없으면 null */
export function getMemo(ctx, memoId) {
  if (typeof memoId !== 'string') return null;
  const r = row(ctx, memoId);
  return r ? ctx.freeze(toMemo(r, taskIdsOf(ctx, memoId))) : null;
}

function requireMemo(ctx, memoId) {
  id(memoId);
  return row(ctx, memoId) ?? fail('not_found');
}

/**
 * 메모의 연결된 일정·할 일을 통째로 바꿈.
 * 공유 공간에서는 서버가 항목마다 메모 하나(note_id)만 담으므로, 다른 메모에 있던 연결은 이 메모로 옮김.
 */
function setLinks(ctx, memoId, taskIds) {
  for (const taskId of taskIds) {
    if (!ctx.db.getFirstSync('select 1 as ok from tasks where workspace_id=? and id=? and deleted_at is null', [ctx.ws(), taskId])) fail('not_found', 'taskIds');
  }
  const shared = ctx.shared();
  const affected = shared ? [...new Set([...ctx.db.getAllSync('select task_id from memo_tasks where memo_id=?', [memoId]).map(r => r.task_id), ...taskIds])] : [];
  const before = new Map(affected.map(taskId => [taskId, noteIdOf(ctx, taskId)]));
  ctx.db.runSync('delete from memo_tasks where memo_id=?', [memoId]);
  taskIds.forEach((taskId, position) => {
    if (shared) ctx.db.runSync('delete from memo_tasks where task_id=?', [taskId]);
    ctx.db.runSync('insert into memo_tasks(workspace_id,memo_id,task_id,position) values(?,?,?,?)', [ctx.ws(), memoId, taskId, position]);
  });
  for (const taskId of affected) {
    const after = noteIdOf(ctx, taskId);
    if (after !== before.get(taskId)) queueNoteLink(ctx, taskId, after);
  }
}

function checkFields(ctx, input) {
  const v = {};
  if ('title' in input) v.title = text(input.title, 'title', LIMITS.memoTitle);
  if ('body' in input) v.body = text(input.body, 'body', LIMITS.body);
  if ('strokes' in input) v.strokes = strokesJson(input.strokes);
  if ('photos' in input) {
    // 공유 공간의 사진: UUID는 서버에 올린 첨부(assets) id, 그 밖의 글자는 아직 안 올린 기기 파일(올리기를 기다림)
    v.photos = JSON.stringify(idList(input.photos, 'photos'));
  }
  if ('taskIds' in input) v.taskIds = idList(input.taskIds, 'taskIds');
  if ('favorite' in input) v.favorite = bool(input.favorite, 'favorite') ? 1 : 0;
  return v;
}

const isEmpty = (title, body, strokes) => !title.trim() && !body.trim() && strokes === '[]';
const favoriteChange = (ids, favorite) => [{ kind: 'favorite', entity: 'note_favorites', data: { note_ids: ids, favorite } }];
const photoLink = (kind, memoId, assetId, position) => ({ kind, entity: 'note_attachments', data: { note_id: memoId, asset_id: assetId, ...(kind === 'link' ? { position } : {}) } });
/** 아직 서버에 안 올린 사진: 다리가 올린 뒤 resolveUpload로 첨부 id와 바꿈 (오프라인에서도 붙일 수 있음) */
const photoUpload = (memoId, ref) => [{ kind: 'upload', entity: 'note_attachments', data: { note_id: memoId, ref } }];

/** 공유 공간에서 사진을 더할 때: 올린 첨부는 연결을 보내고, 기기 파일은 올리기를 기다리게 함 */
function queuePhoto(ctx, memoId, photoId, position) {
  if (isUuid(photoId)) ctx.queue([photoLink('link', memoId, photoId, position)]);
  else ctx.queueSeparate(photoUpload(memoId, photoId));
}

/** 현재 워크스페이스에 메모를 만듦. 제목·본문·손글씨 중 하나는 있어야 함 */
export function addMemo(ctx, input) {
  onlyKeys(input, FIELDS);
  const v = checkFields(ctx, input);
  const title = v.title ?? '', body = v.body ?? '', strokes = v.strokes ?? '[]', photos = v.photos ?? '[]';
  if (isEmpty(title, body, strokes)) fail('empty_memo');
  const memoId = ctx.newId(), t = ctx.now();
  ctx.db.runSync(
    'insert into memos(workspace_id,id,title,body,strokes,photos,favorite,revision,created_at,updated_at) values(?,?,?,?,?,?,?,1,?,?)',
    [ctx.ws(), memoId, title, body, strokes, photos, v.favorite ?? 0, t, t],
  );
  ctx.queue([{ kind: 'create', entity: 'notes', id: memoId, data: ctx.map.noteData({ title, body, strokes }) }]);
  JSON.parse(photos).forEach((photoId, i) => queuePhoto(ctx, memoId, photoId, i));
  if (v.favorite) ctx.queueSeparate(favoriteChange([memoId], true));
  if (v.taskIds) setLinks(ctx, memoId, v.taskIds);
  ctx.touch('memos');
  return getMemo(ctx, memoId);
}

/**
 * 준 칸만 바꿈. 제목·본문·손글씨가 바뀌면 revision·updatedAt이 오르고, 사진·연결·즐겨찾기는 올리지 않음.
 * 달라진 것이 없으면 아무것도 쓰지 않음. expectedRevision을 주면 그 사이 고쳐진 메모는 revision_conflict.
 */
export function updateMemo(ctx, memoId, patch, { expectedRevision } = {}) {
  const current = requireMemo(ctx, memoId);
  onlyKeys(patch, FIELDS, 'patch');
  const v = checkFields(ctx, patch);
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
    const changes = [];
    if (contentChanged) changes.push({ kind: 'update', entity: 'notes', id: memoId, data: ctx.map.diff(ctx.map.noteData(current), ctx.map.noteData({ title, body, strokes })) });
    if (photos !== current.photos) {
      const was = JSON.parse(current.photos), now = JSON.parse(photos);
      for (const assetId of was) if (!now.includes(assetId) && isUuid(assetId)) changes.push(photoLink('unlink', memoId, assetId));
      now.forEach((assetId, i) => { if (!was.includes(assetId) && isUuid(assetId)) changes.push(photoLink('link', memoId, assetId, i)); });
    }
    ctx.queue(changes);
    if (photos !== current.photos) {
      const was = JSON.parse(current.photos);
      for (const ref of JSON.parse(photos)) if (!was.includes(ref) && !isUuid(ref)) ctx.queueSeparate(photoUpload(memoId, ref));
    }
    if (favorite !== current.favorite) ctx.queueSeparate(favoriteChange([memoId], favorite === 1));
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
    ctx.queue([{ kind: 'delete', entity: 'notes', id: memoId }]);
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

/** 메모를 휴지통으로. 현재 워크스페이스에 없는 id는 건너뜀. 옮긴 개수 */
export function trashMemos(ctx, ids) {
  const t = ctx.now();
  return eachExisting(ctx, ids, 'ids', m => {
    if (m.deleted_at !== null) return false;
    ctx.db.runSync('update memos set deleted_at=? where id=?', [t, m.id]);
    ctx.queue([{ kind: 'delete', entity: 'notes', id: m.id }]);
    return true;
  });
}

/** 휴지통에서 꺼냄. 복구한 개수 */
export function restoreMemos(ctx, ids) {
  return eachExisting(ctx, ids, 'ids', m => {
    if (m.deleted_at === null) return false;
    ctx.db.runSync('update memos set deleted_at=null where id=?', [m.id]);
    ctx.queue([{ kind: 'restore', entity: 'notes', id: m.id }]);
    return true;
  });
}

/**
 * 메모를 영구 삭제. 연결도 지우고, 그 메모의 열린 AI 제안은 닫음(superseded).
 * 공유 공간: 서버는 휴지통에 있는 것만 영구 삭제하므로, 휴지통에 없던 메모는 '삭제' 다음에 '영구 삭제'를 따로 보냄.
 */
export function deleteMemosForever(ctx, ids) {
  const t = ctx.now();
  return eachExisting(ctx, ids, 'ids', m => {
    const withdrawn = ctx.db.runSync(
      "update proposals set status='superseded',updated_at=? where workspace_id=? and source_type='memo' and source_id=? and status in ('pending','hold')",
      [t, ctx.ws(), m.id],
    ).changes;
    if (withdrawn) ctx.touch('proposals');
    if (ctx.shared()) {
      // 연결된 일정·할 일의 note_id는 서버가 영구 삭제하면서 비우고 그 변경을 내려보냄
      if (m.deleted_at === null) ctx.queue([{ kind: 'delete', entity: 'notes', id: m.id }]);
      ctx.queueLater([{ kind: 'purge', entity: 'notes', id: m.id }]);
    }
    return ctx.db.runSync('delete from memos where id=?', [m.id]).changes === 1;
  });
}

export function deleteMemoForever(ctx, memoId) {
  requireMemo(ctx, memoId);
  deleteMemosForever(ctx, [memoId]);
  return true;
}

/** 즐겨찾기 켜기·끄기. 바뀐 개수. 공유 공간의 즐겨찾기는 사람마다 따로라 동기화와 다른 길(favorites.ts)로 감 */
export function setFavorites(ctx, ids, favorite) {
  const value = bool(favorite, 'favorite') ? 1 : 0;
  const changedIds = [];
  const count = eachExisting(ctx, ids, 'ids', m => {
    if (m.favorite === value) return false;
    ctx.db.runSync('update memos set favorite=? where id=?', [value, m.id]);
    changedIds.push(m.id);
    return true;
  });
  if (changedIds.length) ctx.queueSeparate(favoriteChange(changedIds, value === 1));
  return count;
}

/** 메모 사진에 파일 id를 더함 (한 번만). 공유 공간: UUID는 서버 첨부 id, 그 밖은 아직 안 올린 기기 파일 */
export function attachPhoto(ctx, memoId, fileId) {
  const current = requireMemo(ctx, memoId);
  id(fileId, 'fileId');
  const photos = JSON.parse(current.photos);
  if (!photos.includes(fileId)) {
    photos.push(fileId);
    ctx.db.runSync('update memos set photos=? where id=?', [JSON.stringify(photos), memoId]);
    queuePhoto(ctx, memoId, fileId, photos.length - 1);
    ctx.touch('memos');
  }
  return getMemo(ctx, memoId);
}

/**
 * 기기 파일(ref)을 서버에 올린 뒤 부름: 메모의 그 사진을 첨부 id로 바꾸고 연결을 보낼 목록에 적음 (동기화 다리가 씀).
 * 그 사이 메모나 사진이 지워졌으면 아무것도 하지 않고 false.
 */
export function resolveUpload(ctx, workspaceRef, memoId, ref, assetId) {
  const ws = ctx.db.getFirstSync('select id from workspaces where (server_id=? or id=?) and personal=0', [workspaceRef, workspaceRef]) ?? fail('not_found');
  id(ref, 'ref');
  uuid(assetId, 'assetId');
  const memo = typeof memoId === 'string' ? ctx.db.getFirstSync('select photos from memos where workspace_id=? and id=?', [ws.id, memoId]) : null;
  const photos = memo ? JSON.parse(memo.photos) : [];
  const at = photos.indexOf(ref);
  if (at < 0) return false;
  const already = photos.includes(assetId);
  const next = already ? photos.filter(p => p !== ref) : photos.map(p => (p === ref ? assetId : p));
  ctx.db.runSync('update memos set photos=? where id=?', [JSON.stringify(next), memoId]);
  if (!already) {
    ctx.db.runSync('insert into outbox(workspace_id,changes,created_at) values(?,?,?)', [ws.id, JSON.stringify([photoLink('link', memoId, assetId, at)]), ctx.now()]);
    ctx.touch('outbox');
  }
  ctx.touch('memos');
  return true;
}

export function detachPhoto(ctx, memoId, fileId) {
  const current = requireMemo(ctx, memoId);
  id(fileId, 'fileId');
  const photos = JSON.parse(current.photos);
  if (photos.includes(fileId)) {
    ctx.db.runSync('update memos set photos=? where id=?', [JSON.stringify(photos.filter(p => p !== fileId)), memoId]);
    if (isUuid(fileId)) ctx.queue([photoLink('unlink', memoId, fileId)]);   // 아직 안 올린 사진은 서버가 모르니 보낼 것이 없음
    ctx.touch('memos');
  }
  return getMemo(ctx, memoId);
}

/** 제안이 쓰는 원본 행 (revision 확인용) */
export function memoRow(ctx, memoId) {
  return typeof memoId === 'string' ? row(ctx, memoId) : null;
}
