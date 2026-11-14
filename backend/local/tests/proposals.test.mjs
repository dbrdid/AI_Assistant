import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejects, rejectsUnchanged, dump } from './helpers.mjs';
import { candidatesToProposals, pendingOf } from '../src/index.js';

// The shape AiExtract.extractFromText returns today, plus the source fields AiAnalyze adds.
function found(memo, overrides = {}) {
  return { kind: 'event', title: '팀 회의', date: '2026-11-17', start: '10:00', end: '', place: '3층', assignee: '', evidence: '내일 10시 3층에서 팀 회의',
    sourceType: 'memo', sourceId: memo.id, sourceTitle: memo.title, ...overrides };
}

function world() {
  const t = setup();
  const memo = t.store.addMemo({ title: '메모', body: '내일 10시 3층에서 팀 회의. 금요일까지 보고서 제출' });
  return { t, memo };
}

test('addProposals stores waiting proposals with the memo revision; identical suggestions are not repeated', () => {
  const { t, memo } = world();
  const added = t.store.addProposals([found(memo), found(memo, { kind: 'task', title: '보고서 제출', date: '2026-11-20', start: '' })]);
  assert.equal(added.length, 2);
  assert.deepEqual(added[0], {
    id: added[0].id, kind: 'event', title: '팀 회의', date: '2026-11-17', start: '10:00', end: '', place: '3층', assignee: '', body: '',
    evidence: '내일 10시 3층에서 팀 회의', sourceType: 'memo', sourceId: memo.id, sourceTitle: '메모', sourceRevision: 1, status: 'pending',
    createdAt: t.clock.t, updatedAt: t.clock.t,
  });
  assert.deepEqual(t.store.getProposals().map(p => p.title).sort(), ['보고서 제출', '팀 회의']);
  assert.deepEqual(t.store.addProposals([found(memo)]), [], 'the same suggestion from the same memo is skipped');
  assert.deepEqual(t.store.getProposal(added[0].id), added[0]);
  rejectsUnchanged(t, () => t.store.addProposals([found(memo, { kind: 'meeting' })]), 'invalid_input', 'kind');
  rejectsUnchanged(t, () => t.store.addProposals([found(memo, { date: '2026-02-30' })]), 'invalid_input', 'date');
  rejectsUnchanged(t, () => t.store.addProposals([found(memo, { confidence: 0.9 })]), 'invalid_input', 'confidence');
  rejectsUnchanged(t, () => t.store.addProposals([found(memo, { sourceId: null })]), 'invalid_input', 'sourceId');
  rejectsUnchanged(t, () => t.store.addProposals('x'), 'invalid_input', 'items');
});

test('late results are dropped: a memo edited, trashed or deleted after the analysis started', () => {
  const { t, memo } = world();
  t.store.updateMemo(memo.id, { body: '바뀐 내용' });
  assert.deepEqual(t.store.addProposals([found(memo, { sourceRevision: 1 })]), [], 'analysis of revision 1 arrives after revision 2');
  assert.equal(t.store.addProposals([found(memo, { sourceRevision: 2 })]).length, 1);
  const other = t.store.addMemo({ body: '다른 메모' });
  t.store.trashMemo(other.id);
  assert.deepEqual(t.store.addProposals([found(other)]), []);
  t.store.deleteMemoForever(other.id);
  assert.deepEqual(t.store.addProposals([found(other)]), []);
  assert.equal(t.store.getProposals().length, 1);
});

test('an analysis of a newer revision replaces the open proposals of the older one', () => {
  const { t, memo } = world();
  const [old1, old2] = t.store.addProposals([found(memo), found(memo, { title: '보고서', kind: 'task', start: '' })]);
  t.store.setProposalStatus(old2.id, 'hold');
  const kept = t.store.addProposals([found(memo, { title: '점심', start: '12:00' })])[0];
  t.store.approveProposal(kept.id, {});
  t.store.updateMemo(memo.id, { body: '고친 메모' });
  const fresh = t.store.addProposals([found(memo, { title: '팀 회의(변경)' })]);
  assert.deepEqual(t.store.getProposals().map(p => p.id), [fresh[0].id]);
  assert.equal(t.store.getProposal(old1.id), null);
  rejects(() => t.store.approveProposal(old2.id, {}), 'already_processed');
});

test('approving saves the task, links it to the memo without a new memo revision, and closes the proposal in one step', () => {
  const { t, memo } = world();
  const [p] = t.store.addProposals([found(memo)]);
  const seen = [];
  t.store.subscribe(areas => seen.push(areas.sort().join(',')));
  t.tick();
  const saved = t.store.approveProposal(p.id, { ...p, title: '팀 회의 (확정)', body: '팀 회의\n근거: 내일 10시', assignee: '민지' });
  assert.equal(saved.kind, 'task');
  assert.deepEqual(t.store.getTask(saved.id), {
    id: saved.id, title: '팀 회의 (확정)', date: '2026-11-17', start: '10:00', end: '', priority: '보통', status: '진행 전', alarm: '없음',
    assignee: '민지', place: '3층', project: '', desc: '팀 회의\n근거: 내일 10시', revision: 1, createdAt: t.clock.t, updatedAt: t.clock.t,
  });
  const after = t.store.getMemo(memo.id);
  assert.deepEqual([after.taskIds, after.revision], [[saved.id], 1]);
  assert.equal(t.store.getProposal(p.id), null);
  assert.deepEqual(t.store.getProposals(), []);
  assert.deepEqual(seen, ['memos,proposals,tasks']);

  const again = t.store.approveProposal(p.id, {});
  assert.equal(again.id, saved.id, 'a second tap returns the first result');
  assert.equal(t.store.getTasks().length, 1);
});

test('approval is refused, with nothing written, when the memo changed after the analysis', () => {
  const { t, memo } = world();
  const [p] = t.store.addProposals([found(memo)]);
  t.store.updateMemo(memo.id, { body: '내용을 고쳤어요' });
  rejectsUnchanged(t, () => t.store.approveProposal(p.id, {}), 'source_changed');
  assert.equal(t.store.getProposal(p.id).status, 'pending');
});

test('approval follows the edited kind: a memo proposal becomes a memo; bad edits change nothing', () => {
  const { t, memo } = world();
  const [p] = t.store.addProposals([found(memo)]);
  rejectsUnchanged(t, () => t.store.approveProposal(p.id, { date: '2026-02-30' }), 'invalid_input', 'date');
  rejectsUnchanged(t, () => t.store.approveProposal(p.id, { kind: 'note' }), 'invalid_input', 'kind');
  rejectsUnchanged(t, () => t.store.approveProposal(p.id, { kind: 'memo', title: '', body: '' }), 'empty_memo');
  rejectsUnchanged(t, () => t.store.approveProposal(p.id, 'yes'), 'invalid_input', 'edits');
  const saved = t.store.approveProposal(p.id, { ...p, kind: 'memo', title: '회의 메모', body: '팀 회의\n근거: 내일 10시' });
  assert.equal(saved.kind, 'memo');
  assert.deepEqual([t.store.getMemo(saved.id).title, t.store.getMemo(saved.id).body], ['회의 메모', '팀 회의\n근거: 내일 10시']);
  assert.deepEqual(t.store.getTasks(), []);
});

test('auto mode approves with no edits; a task proposal without a date cannot be saved until a date is chosen', () => {
  const { t, memo } = world();
  const [dated, undated] = t.store.addProposals([found(memo), found(memo, { kind: 'task', title: '자료 준비', date: '', start: '' })]);
  assert.equal(t.store.approveProposal(dated.id, {}).title, '팀 회의');
  rejectsUnchanged(t, () => t.store.approveProposal(undated.id, {}), 'invalid_input', 'date');
  assert.equal(t.store.approveProposal(undated.id, { date: '2026-11-18' }).date, '2026-11-18');
});

test('hold and reject: held proposals stay listed, rejected ones close for good', () => {
  const { t, memo } = world();
  const [a, b] = t.store.addProposals([found(memo), found(memo, { title: '보고서', kind: 'task', start: '' })]);
  assert.equal(t.store.setProposalStatus(a.id, 'hold'), true);
  assert.deepEqual(t.store.getProposals().map(p => [p.title, p.status]).sort(), [['보고서', 'pending'], ['팀 회의', 'hold']]);
  t.store.setProposalStatus(b.id, 'rejected');
  assert.equal(t.store.getProposal(b.id), null);
  rejectsUnchanged(t, () => t.store.approveProposal(b.id, {}), 'already_processed');
  rejectsUnchanged(t, () => t.store.setProposalStatus(b.id, 'pending'), 'already_processed');
  rejectsUnchanged(t, () => t.store.setProposalStatus(a.id, 'approved'), 'invalid_input', 'status');
  rejectsUnchanged(t, () => t.store.setProposalStatus('missing', 'hold'), 'not_found');
  assert.equal(t.store.setProposalStatus(a.id, 'pending'), true);
  assert.deepEqual(pendingOf(t.store.getProposals()).length, 1);
});

test('deleting the memo for good withdraws its open proposals', () => {
  const { t, memo } = world();
  const [p] = t.store.addProposals([found(memo)]);
  t.store.deleteMemoForever(memo.id);
  assert.deepEqual(t.store.getProposals(), []);
  rejects(() => t.store.approveProposal(p.id, {}), 'already_processed');
});

test('findDuplicate finds a task on the same date with the same title, ignoring case and spacing', () => {
  const { t } = world();
  const task = t.store.addTask({ title: 'Team  회의', date: '2026-11-17', start: '09:00' });
  assert.equal(t.store.findDuplicate({ kind: 'event', title: ' team 회의 ', date: '2026-11-17' }).id, task.id);
  assert.equal(t.store.findDuplicate({ kind: 'event', title: 'team 회의', date: '2026-11-18' }), null);
  assert.equal(t.store.findDuplicate({ kind: 'memo', title: 'team 회의', date: '2026-11-17' }), null);
  assert.equal(t.store.findDuplicate({ kind: 'task', title: 'team 회의', date: '' }), null);
  rejects(() => t.store.findDuplicate({ kind: 'task', title: 'x', date: '2026-02-30' }), 'invalid_input', 'date');
});

test('proposals from a recording have no revision to check; cloud organize candidates map onto proposals', () => {
  const { t, memo } = world();
  const [rec] = t.store.addProposals([{ kind: 'task', title: '녹음 할 일', date: '2026-11-19', sourceType: 'record', sourceId: 'file-7', sourceTitle: '녹음' }]);
  assert.equal(rec.sourceRevision, null);
  assert.equal(t.store.approveProposal(rec.id, {}).title, '녹음 할 일');

  const candidates = [{ kind: 'task', title: '보고서 제출', dueDate: '2026-11-20', sourceQuote: '금요일까지 보고서 제출' }, { kind: 'event', title: '회의', dueDate: null, sourceQuote: '회의' }];
  const items = candidatesToProposals(candidates, { sourceType: 'memo', sourceId: memo.id, sourceTitle: memo.title, sourceRevision: memo.revision });
  assert.deepEqual(items[0], { kind: 'task', title: '보고서 제출', date: '2026-11-20', evidence: '금요일까지 보고서 제출', sourceType: 'memo', sourceId: memo.id, sourceTitle: '메모', sourceRevision: 1 });
  assert.equal(items[1].date, '');
  assert.equal(t.store.addProposals(items).length, 2);
  rejects(() => candidatesToProposals([{ kind: 'memo', title: 'x' }]), 'invalid_input', 'candidates');
});

test('a failure in the middle of an approval leaves no task, link or status change behind', () => {
  let failOn = null;
  const t = setup({ onStatement: sql => { if (failOn && sql.startsWith(failOn)) throw new Error('disk full (simulated)'); } });
  const memo = t.store.addMemo({ body: '내일 10시 회의' });
  const [p] = t.store.addProposals([found(memo)]);
  const before = dump(t.db);
  const snapshot = t.store.getProposals();
  let calls = 0;
  t.store.subscribe(() => { calls++; });
  failOn = "update proposals set status='approved'";
  assert.throws(() => t.store.approveProposal(p.id, {}), /disk full/);
  failOn = null;
  assert.deepEqual(dump(t.db), before);
  assert.equal(calls, 0);
  assert.equal(t.store.getProposals(), snapshot, 'cached lists stay valid after a rollback');
  assert.equal(t.store.approveProposal(p.id, {}).kind, 'task');
});
