import { fail } from './errors.js';
import { LIMITS, dateKey, id, isPlainObject, onlyKeys, optionalDateKey, positiveInt, text, timeOfDay } from './validate.js';
import { addMemo, getMemo, memoRow } from './memos.js';
import { addTask, findSameTask, getTask } from './tasks.js';

const KINDS = ['event', 'task', 'memo'];
const ITEM_FIELDS = ['kind', 'title', 'date', 'endDate', 'start', 'end', 'place', 'assignee', 'priority', 'body', 'evidence', 'sourceType', 'sourceId', 'sourceTitle', 'sourceRevision'];
/** 확인 화면에서 승인 전에 바꿀 수 있는 항목입니다. edits의 다른 키(화면은 제안 전체를 펼쳐 전달함)는 무시합니다. */
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

/** 현재 작업 공간에서 대기 중이거나 보류 중인 제안을 최신순으로 가져옵니다. */
export function listProposals(ctx) {
  return ctx.db.getAllSync(`select ${COLUMNS} from proposals where workspace_id=? and ${OPEN} order by created_at desc, id`, [ctx.ws()])
    .map(r => ctx.freeze(toProposal(r)));
}

/** 처리 중인 제안을 반환합니다. 승인·거부·대체된 경우에는 null을 반환합니다(확인 화면에 "이미 처리됨"으로 표시). */
export function getProposal(ctx, proposalId) {
  if (typeof proposalId !== 'string') return null;
  const r = ctx.db.getFirstSync(`select ${COLUMNS} from proposals where workspace_id=? and id=? and ${OPEN}`, [ctx.ws(), proposalId]);
  return r ? ctx.freeze(toProposal(r)) : null;
}

/**
 * AI 제안을 사용자가 확인할 수 있도록 대기 상태로 저장합니다. 메모에서 제안한 경우 메모의 리비전을 기록합니다.
 * 분석에서 읽은 리비전(텍스트를 전송한 시점의 memo.revision)을 sourceRevision으로 전달합니다. 메모가 삭제되었거나
 * 리비전이 달라진 항목은 늦게 도착한 결과로 보고 제외합니다. 같은 출처의 처리 중인 제안과 같은 항목은 건너뛰고,
 * 같은 메모의 이전 리비전에서 생성된 처리 중 제안은 대체됨(superseded)으로 바꿉니다.
 * 추가된 제안을 반환합니다.
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
 * 사용자가 수정한 제안을 일정 또는 할 일(kind event 또는 task), 메모(kind memo)로 저장하고 제안 상태도 한 트랜잭션에서
 * 갱신합니다. 분석 후 메모가 수정되거나 삭제되었다면 메모에서 나온 제안은 source_changed 오류로 거부합니다.
 * 다시 승인하면 중복 항목을 만들지 않고 처음 저장한 항목을 반환합니다.
 * kind가 'task' 또는 'memo'인 저장 항목을 반환합니다.
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

/** 처리 중인 제안의 상태를 'pending', 'hold' 또는 'rejected'로 바꿉니다. */
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

/** 제안을 저장할 때 날짜와 제목이 같은 기존 할 일을 반환합니다. 중복이 없거나 메모 제안이면 null을 반환합니다. */
export function findDuplicate(ctx, fields) {
  if (!isPlainObject(fields)) fail('invalid_input', 'fields');
  if (fields.kind === 'memo' || !fields.date || typeof fields.title !== 'string') return null;
  return findSameTask(ctx, dateKey(fields.date), fields.title);
}

/** 대기 중이거나 보류 중인 제안만 필터링합니다. 화면에서 이미 보유한 목록에 사용합니다. */
export function pendingOf(list) {
  return (Array.isArray(list) ? list : []).filter(p => p && (p.status === 'pending' || p.status === 'hold'));
}

/**
 * (팀 서버용) backend/cloud의 POST /v1/ai/organize에서 받은 후보({kind, title, dueDate, sourceQuote}, docs/SERVER.md)를
 * addProposals에 전달할 항목으로 변환합니다. `source`는 { sourceType, sourceId, sourceTitle, sourceRevision }입니다.
 */
export function candidatesToProposals(candidates, source = {}) {
  if (!Array.isArray(candidates)) fail('invalid_input', 'candidates');
  return candidates.map(c => {
    if (!isPlainObject(c) || (c.kind !== 'task' && c.kind !== 'event')) fail('invalid_input', 'candidates');
    return { kind: c.kind, title: c.title, date: c.dueDate ?? '', evidence: c.sourceQuote ?? '', ...source };
  });
}
