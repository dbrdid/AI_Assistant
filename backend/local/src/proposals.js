import { fail } from './errors.js';
import { LIMITS, dateKey, id, isPlainObject, onlyKeys, optionalDateKey, positiveInt, text, timeOfDay } from './validate.js';
import { addMemo, getMemo, memoRow } from './memos.js';
import { addTask, findSameTask, getTask } from './tasks.js';

const KINDS = ['event', 'task', 'memo'];
const ITEM_FIELDS = ['kind', 'title', 'date', 'endDate', 'start', 'end', 'place', 'assignee', 'priority', 'body', 'evidence', 'sourceType', 'sourceId', 'sourceTitle', 'sourceRevision'];
/** What the confirm screen may change before approving. Other keys in the edits (the screen spreads the whole proposal) are ignored. */
const EDITABLE = ['kind', 'title', 'date', 'endDate', 'start', 'end', 'place', 'assignee', 'priority', 'body'];
const COLUMNS = 'id,kind,title,date,end_date,start_time,end_time,place,assignee,priority,body,evidence,source_type,source_id,source_title,source_revision,status,result_kind,result_id,created_at,updated_at';
const OPEN = "status in ('pending','hold')";

function toProposal(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    date: row.date,
    endDate: row.end_date,
    start: row.start_time,
    end: row.end_time,
    place: row.place,
    assignee: row.assignee,
    priority: row.priority,          // AI가 매긴 중요도 글자 ('' = 없음)
    body: row.body,
    evidence: row.evidence,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceRevision: row.source_revision,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function checkItem(item) {
  onlyKeys(item, ITEM_FIELDS, 'item');
  if (!KINDS.includes(item.kind)) fail('invalid_input', 'kind');
  const v = {
    kind: item.kind,
    title: text(item.title ?? '', 'title', LIMITS.title),
    date: optionalDateKey(item.date ?? ''),
    endDate: optionalDateKey(item.endDate ?? '', 'endDate'),
    start: timeOfDay(item.start ?? '', 'start'),
    end: timeOfDay(item.end ?? '', 'end'),
    place: text(item.place ?? '', 'place', LIMITS.short),
    assignee: text(item.assignee ?? '', 'assignee', LIMITS.assignee),
    priority: text(item.priority ?? '', 'priority', LIMITS.label),
    body: text(item.body ?? '', 'body', LIMITS.desc),
    evidence: text(item.evidence ?? '', 'evidence', LIMITS.evidence),
    sourceType: text(item.sourceType ?? '', 'sourceType', LIMITS.label),
    sourceId: item.sourceId === undefined || item.sourceId === null ? null : id(item.sourceId, 'sourceId'),
    sourceTitle: text(item.sourceTitle ?? '', 'sourceTitle', LIMITS.short),
    sourceRevision: item.sourceRevision === undefined || item.sourceRevision === null ? null : positiveInt(item.sourceRevision, 'sourceRevision'),
  };
  if (v.sourceType === 'memo' && !v.sourceId) fail('invalid_input', 'sourceId');
  return v;
}

/** Open proposals (waiting or on hold) of the current workspace, newest first. */
export function listProposals(ctx) {
  return ctx.db.getAllSync(`select ${COLUMNS} from proposals where workspace_id=? and ${OPEN} order by created_at desc, id`, [ctx.ws()])
    .map(r => ctx.freeze(toProposal(r)));
}

/** An open proposal, or null once it was approved, rejected or replaced (the confirm screen shows "already handled"). */
export function getProposal(ctx, proposalId) {
  if (typeof proposalId !== 'string') return null;
  const r = ctx.db.getFirstSync(`select ${COLUMNS} from proposals where workspace_id=? and id=? and ${OPEN}`, [ctx.ws(), proposalId]);
  return r ? ctx.freeze(toProposal(r)) : null;
}

/**
 * Stores AI suggestions as proposals waiting for the user. For a memo source the memo's revision is recorded:
 * pass sourceRevision = the revision the analysis read (memo.revision when the text was sent). Items whose memo is
 * gone, or has moved past that revision, are dropped as late results. Items equal to an open proposal of the same
 * source are skipped, and open proposals from an older revision of the same memo are replaced (superseded).
 * Returns the proposals added.
 */
export function addProposals(ctx, items) {
  if (!Array.isArray(items) || items.length > 100) fail('invalid_input', 'items');
  const checkedItems = items.map(checkItem);
  const added = [];
  const t = ctx.now();
  for (const v of checkedItems) {
    let revision = null;
    if (v.sourceType === 'memo') {
      const memo = memoRow(ctx, v.sourceId);
      if (!memo || memo.deleted_at !== null) continue;
      if (v.sourceRevision !== null && v.sourceRevision !== memo.revision) continue;
      revision = memo.revision;
      const superseded = ctx.db.runSync(
        `update proposals set status='superseded',updated_at=? where workspace_id=? and source_type='memo' and source_id=? and source_revision<? and ${OPEN}`,
        [t, ctx.ws(), v.sourceId, revision],
      ).changes;
      if (superseded) ctx.touch('proposals');
    }
    const same = ctx.db.getFirstSync(
      `select 1 as ok from proposals where workspace_id=? and ${OPEN} and source_type=? and source_id is ? and kind=? and title=? and date=? and start_time=?`,
      [ctx.ws(), v.sourceType, v.sourceId, v.kind, v.title, v.date, v.start],
    );
    if (same) continue;
    const proposalId = ctx.newId();
    ctx.db.runSync(
      `insert into proposals(workspace_id,id,kind,title,date,end_date,start_time,end_time,place,assignee,priority,body,evidence,source_type,source_id,source_title,source_revision,status,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      [ctx.ws(), proposalId, v.kind, v.title, v.date, v.endDate, v.start, v.end, v.place, v.assignee, v.priority, v.body, v.evidence, v.sourceType, v.sourceId, v.sourceTitle, revision, t, t],
    );
    ctx.touch('proposals');
    added.push(getProposal(ctx, proposalId));
  }
  return added;
}

function resultOf(ctx, row) {
  const item = row.result_kind === 'memo' ? getMemo(ctx, row.result_id) : getTask(ctx, row.result_id);
  return item ? ctx.freeze({ ...item, kind: row.result_kind, ...(row.result_kind === 'task' ? { taskKind: item.kind } : {}) }) : null;
}

/**
 * Saves a proposal as a task (kind event or task) or a memo (kind memo), after the user's edits, in one transaction
 * with the proposal's status. A proposal from a memo is refused with source_changed when the memo was edited or
 * deleted after the analysis. Approving again returns the item saved the first time instead of a second copy.
 * Returns the saved item with kind 'task' or 'memo'.
 */
export function approveProposal(ctx, proposalId, edits = {}) {
  id(proposalId);
  if (!isPlainObject(edits)) fail('invalid_input', 'edits');
  const row = ctx.db.getFirstSync(`select ${COLUMNS} from proposals where workspace_id=? and id=?`, [ctx.ws(), proposalId]) ?? fail('not_found');
  if (row.status === 'approved') return resultOf(ctx, row) ?? fail('already_processed');
  if (row.status !== 'pending' && row.status !== 'hold') fail('already_processed');

  const p = toProposal(row);
  const v = {};
  for (const key of EDITABLE) v[key] = key in edits ? edits[key] : p[key];
  if (!KINDS.includes(v.kind)) fail('invalid_input', 'kind');

  let source = null;
  if (p.sourceType === 'memo') {
    source = memoRow(ctx, p.sourceId);
    if (!source || source.revision !== p.sourceRevision) fail('source_changed');
  }

  let saved;
  if (v.kind === 'memo') {
    saved = addMemo(ctx, { title: text(v.title, 'title', LIMITS.memoTitle), body: text(v.body, 'body', LIMITS.body) });
  } else {
    // kind를 그대로 넘겨서, 시간이 있는 할 일도 서버에서 할 일(tasks)로 남음. 원본 메모와의 연결도 같은 저장에 담음
    saved = addTask(ctx, {
      kind: v.kind, title: v.title, date: dateKey(v.date), endDate: v.endDate, start: v.start, end: v.end, place: v.place, assignee: v.assignee, desc: v.body,
      ...(v.priority ? { priority: v.priority } : {}),
    }, { memoId: source ? source.id : null });
  }
  const resultKind = v.kind === 'memo' ? 'memo' : 'task';
  ctx.db.runSync("update proposals set status='approved',result_kind=?,result_id=?,updated_at=? where id=?", [resultKind, saved.id, ctx.now(), proposalId]);
  ctx.touch('proposals');
  // kind는 약속대로 'task' | 'memo'. 일정·할 일의 종류('task' | 'event')는 taskKind
  return ctx.freeze({ ...saved, kind: resultKind, ...(resultKind === 'task' ? { taskKind: saved.kind } : {}) });
}

/** Moves an open proposal to 'pending', 'hold' or 'rejected'. */
export function setProposalStatus(ctx, proposalId, status) {
  id(proposalId);
  if (!['pending', 'hold', 'rejected'].includes(status)) fail('invalid_input', 'status');
  const row = ctx.db.getFirstSync('select status from proposals where workspace_id=? and id=?', [ctx.ws(), proposalId]) ?? fail('not_found');
  if (row.status !== 'pending' && row.status !== 'hold') fail('already_processed');
  if (row.status !== status) {
    ctx.db.runSync('update proposals set status=?,updated_at=? where id=?', [status, ctx.now(), proposalId]);
    ctx.touch('proposals');
  }
  return true;
}

/** The task a proposal would duplicate (same date and title), or null. Memo proposals have no duplicates. */
export function findDuplicate(ctx, fields) {
  if (!isPlainObject(fields)) fail('invalid_input', 'fields');
  if (fields.kind === 'memo' || !fields.date || typeof fields.title !== 'string') return null;
  return findSameTask(ctx, dateKey(fields.date), fields.title);
}

/** Open proposals only (waiting or on hold); a helper for lists the screens already hold. */
export function pendingOf(list) {
  return (Array.isArray(list) ? list : []).filter(p => p && (p.status === 'pending' || p.status === 'hold'));
}

/**
 * (팀 서버용) Turns the candidates of backend/cloud's POST /v1/ai/organize ({kind, title, dueDate, sourceQuote}, docs/SERVER.md)
 * into items for addProposals. `source` is { sourceType, sourceId, sourceTitle, sourceRevision }.
 */
export function candidatesToProposals(candidates, source = {}) {
  if (!Array.isArray(candidates)) fail('invalid_input', 'candidates');
  return candidates.map(c => {
    if (!isPlainObject(c) || (c.kind !== 'task' && c.kind !== 'event')) fail('invalid_input', 'candidates');
    return { kind: c.kind, title: c.title, date: c.dueDate ?? '', evidence: c.sourceQuote ?? '', ...source };
  });
}
