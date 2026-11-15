import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejects, rejectsUnchanged } from './helpers.mjs';

const STROKES = [{ id: 's1', c: '#111111', w: 2.5, p: [[10, 20], [11, 21]] }];
const ASSET = '11111111-1111-4111-8111-111111111111';
const SERVER_WS = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

/** 공유 공간으로 전환한 저장소 */
function shared(options) {
  const t = setup(options);
  t.team = t.store.createWorkspace({ name: '팀 공간', desc: '캡스톤' });
  t.store.switchWorkspace(t.team);
  t.out = () => t.store.peekOutbox(100).map(o => o.changes);
  return t;
}

test('개인 공간의 저장은 보낼 목록에 적지 않고, 공유 공간의 저장은 서버 형식으로 같은 트랜잭션에 적는다', () => {
  const t = setup();
  t.store.addMemo({ title: '개인', photos: ['file-1'] });
  t.store.addTask({ title: '개인 할 일', date: '2026-11-16', priority: '아무 글자' });   // 개인 공간은 화면 글자를 그대로 둠
  assert.equal(t.store.outboxCount(), 0);

  const team = t.store.createWorkspace({ name: '팀' });
  t.store.switchWorkspace(team);
  const memo = t.store.addMemo({ title: '', body: '회의록', strokes: STROKES });
  const [row] = t.store.peekOutbox();
  assert.deepEqual(row, { seq: row.seq, workspaceId: team, serverId: null, createdAt: t.clock.t, changes: [
    { kind: 'create', entity: 'notes', id: memo.id, data: { title: null, body: '회의록', strokes: STROKES } },
  ] });
  // 실패한 저장은 보낼 목록에도 남지 않음
  rejectsUnchanged(t, () => t.store.updateMemo(memo.id, { title: 'x'.repeat(201) }), 'invalid_input', 'title');
  t.store.linkWorkspace(team, SERVER_WS);
  assert.equal(t.store.peekOutbox()[0].serverId, SERVER_WS);
  t.store.ackOutbox(row.seq);
  assert.equal(t.store.outboxCount(), 0);
});

test('길이 한도와 손글씨 형식은 서버 제약과 같다', () => {
  const t = setup();
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'x'.repeat(201) }), 'invalid_input', 'title');
  rejectsUnchanged(t, () => t.store.addTask({ title: 'a', date: '2026-11-16', assignee: 'x'.repeat(101) }), 'invalid_input', 'assignee');
  rejectsUnchanged(t, () => t.store.createWorkspace({ name: '팀', desc: 'x'.repeat(121) }), 'invalid_input', 'desc');
  for (const bad of [
    [{ p: [[0, 0]], w: 2 }], [{ id: '', c: '#000', w: 1, p: [[0, 0]] }], [{ id: 'a', c: '#000', w: 0, p: [[0, 0]] }], [{ id: 'a', c: '#000', w: 101, p: [[0, 0]] }],
    [{ id: 'a', c: '#000', w: 1, p: [] }], [{ id: 'a', c: '#000', w: 1, p: [[0]] }], [{ id: 'a', c: '#000', w: 1, p: [[0, '1']] }], [{ id: 'a', c: 'c'.repeat(65), w: 1, p: [[0, 0]] }],
    [[1, 2, 3]],
  ]) rejectsUnchanged(t, () => t.store.addMemo({ title: 'a', strokes: bad }), 'invalid_input', 'strokes');
  // 1MiB는 서버가 저장하는 모양(쉼표·콜론 뒤 빈칸) 기준: 점 10,000개짜리 획 9개는 넘고 5개는 통과
  const big = n => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, c: '#111111', w: 2, p: Array.from({ length: 10_000 }, (_, j) => [1000.5 + j, 2000.5 + j]) }));
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'a', strokes: big(9) }), 'invalid_input', 'strokes');
  assert.equal(t.store.addMemo({ title: 'a', strokes: big(5) }).strokes.length, 5);
  assert.equal(t.store.addMemo({ strokes: [{ ...STROKES[0], tool: 'pen' }] }).strokes[0].tool, 'pen');   // 다른 키는 서버도 받음
});

test('일정·할 일: kind가 서버 표를 정하고, 글자는 서버 값으로, 수정은 바뀐 칸만 보낸다', () => {
  const t = shared();
  const ev = t.store.addTask({ title: '팀 회의', date: '2026-11-20', start: '14:00', end: '15:30', priority: '높음', alarm: '10분 전', place: '301', assignee: '병욱' });
  const todo = t.store.addTask({ title: '보고서', date: '2026-11-21', desc: '초안' });
  const allDay = t.store.addTask({ kind: 'event', title: '워크숍', date: '2026-11-22', endDate: '2026-11-23' });
  assert.deepEqual([ev.kind, todo.kind, allDay.kind], ['event', 'task', 'event']);
  assert.deepEqual(t.out().flat(), [
    { kind: 'create', entity: 'events', id: ev.id, data: { title: '팀 회의', description: null, status: 'TODO', priority: 3, reminder_minutes: 10, assignee_name: '병욱',
      location: '301', note_id: null, project_id: null, start_at: '2026-11-20T14:00:00+09:00', end_at: '2026-11-20T15:30:00+09:00', all_day: false, timezone: 'Asia/Seoul' } },
    { kind: 'create', entity: 'tasks', id: todo.id, data: { title: '보고서', description: '초안', status: 'TODO', priority: 2, reminder_minutes: null, assignee_name: null,
      location: null, note_id: null, project_id: null, due_at: '2026-11-21T00:00:00+09:00', all_day: true } },
    { kind: 'create', entity: 'events', id: allDay.id, data: { title: '워크숍', description: null, status: 'TODO', priority: 2, reminder_minutes: null, assignee_name: null,
      location: null, note_id: null, project_id: null, start_at: '2026-11-22T00:00:00+09:00', end_at: '2026-11-24T00:00:00+09:00', all_day: true, timezone: 'Asia/Seoul' } },
  ]);
  for (const o of t.store.peekOutbox(100)) t.store.ackOutbox(o.seq);

  t.store.toggleDone(todo.id);
  t.store.updateTask(ev.id, { start: '15:00', alarm: '2시간 전' });
  t.store.updateTask(ev.id, { project: '화면에만 쓰는 이름' });             // 서버에 없는 칸만 바뀌면 보내지 않음
  assert.deepEqual(t.out().flat(), [
    { kind: 'update', entity: 'tasks', id: todo.id, data: { status: 'DONE' } },
    { kind: 'update', entity: 'events', id: ev.id, data: { reminder_minutes: 120, start_at: '2026-11-20T15:00:00+09:00' } },
  ]);
  // 서버가 받을 수 없는 값은 공유 공간에서 막음
  rejectsUnchanged(t, () => t.store.addTask({ title: 'a', date: '2026-11-16', priority: '아무 글자' }), 'invalid_input', 'priority');
  rejectsUnchanged(t, () => t.store.updateTask(ev.id, { status: '모름' }), 'invalid_input', 'status');
  rejectsUnchanged(t, () => t.store.updateTask(ev.id, { alarm: '곧' }), 'invalid_input', 'alarm');
  rejectsUnchanged(t, () => t.store.updateTask(ev.id, { end: '14:00' }), 'invalid_input', 'end');   // 끝이 시작보다 앞
  rejectsUnchanged(t, () => t.store.updateTask(ev.id, { projectId: 'p1' }), 'invalid_input', 'projectId');
});

test('공유 공간의 일정·할 일은 휴지통으로 가고 복구·영구 삭제할 수 있다. 개인 공간은 바로 지운다', () => {
  const t = shared();
  const memo = t.store.addMemo({ title: '메모' });
  const task = t.store.addTask({ title: '할 일', date: '2026-11-16' });
  t.store.updateMemo(memo.id, { taskIds: [task.id] });
  for (const o of t.store.peekOutbox(100)) t.store.ackOutbox(o.seq);

  t.store.deleteTask(task.id);
  assert.equal(t.store.getTask(task.id), null);
  assert.deepEqual(t.store.getTasks(), []);
  assert.deepEqual(t.store.getMemo(memo.id).taskIds, []);
  assert.deepEqual(t.store.getTrashedTasks().map(x => [x.id, x.deletedAt]), [[task.id, t.clock.t]]);
  assert.equal(t.store.restoreTasks([task.id, 'missing']), 1);
  assert.deepEqual(t.store.getMemo(memo.id).taskIds, [task.id]);
  t.store.deleteTask(task.id);
  assert.equal(t.store.deleteTasksForever([task.id]), 1);
  assert.deepEqual(t.store.getTrashedTasks(), []);
  assert.deepEqual(t.out().flat().map(c => [c.kind, c.entity]), [['delete', 'tasks'], ['restore', 'tasks'], ['delete', 'tasks'], ['purge', 'tasks']]);

  t.store.switchWorkspace(t.store.getWorkspaces()[0].id);
  const mine = t.store.addTask({ title: '개인', date: '2026-11-16' });
  t.store.deleteTask(mine.id);
  assert.deepEqual(t.store.getTrashedTasks(), []);
});

test('메모 연결·사진·즐겨찾기·삭제가 서버 모양으로 나간다', () => {
  const t = shared();
  const a = t.store.addMemo({ title: 'A' }), b = t.store.addMemo({ title: 'B' });
  const task = t.store.addTask({ title: '할 일', date: '2026-11-16' });
  for (const o of t.store.peekOutbox(100)) t.store.ackOutbox(o.seq);

  t.store.updateMemo(a.id, { taskIds: [task.id] });
  t.store.updateMemo(b.id, { taskIds: [task.id] });          // 서버는 항목마다 메모 하나: A에서 B로 옮겨짐
  assert.deepEqual([t.store.getMemo(a.id).taskIds, t.store.getMemo(b.id).taskIds], [[], [task.id]]);
  t.store.attachPhoto(a.id, ASSET);
  t.store.detachPhoto(a.id, ASSET);
  t.store.setFavorites([a.id, b.id], true);
  t.store.trashMemo(a.id);
  t.store.restoreMemos([a.id]);
  t.store.deleteMemoForever(b.id);                            // 휴지통에 없던 메모: 삭제와 영구 삭제를 따로
  assert.deepEqual(t.out(), [
    [{ kind: 'update', entity: 'tasks', id: task.id, data: { note_id: a.id } }],
    [{ kind: 'update', entity: 'tasks', id: task.id, data: { note_id: b.id } }],
    [{ kind: 'link', entity: 'note_attachments', data: { note_id: a.id, asset_id: ASSET, position: 0 } }],
    [{ kind: 'unlink', entity: 'note_attachments', data: { note_id: a.id, asset_id: ASSET } }],
    [{ kind: 'favorite', entity: 'note_favorites', data: { note_ids: [a.id, b.id], favorite: true } }],
    [{ kind: 'delete', entity: 'notes', id: a.id }],
    [{ kind: 'restore', entity: 'notes', id: a.id }],
    [{ kind: 'delete', entity: 'notes', id: b.id }],
    [{ kind: 'purge', entity: 'notes', id: b.id }],
  ]);
});

test('applyServer: 서버 행을 기기 칸으로 바꿔 넣고, 보낼 목록에는 적지 않는다', () => {
  const t = shared();
  t.store.linkWorkspace(t.team, SERVER_WS);
  const N = '44444444-4444-4444-8444-444444444444', T = '55555555-5555-4555-8555-555555555555', E = '66666666-6666-4666-8666-666666666666';
  const note = { id: N, title: null, body: '서버 메모', strokes: [{ c: '#111111', p: [[10, 20], [11, 21]], w: 2.5, id: 's1' }], created_at: '2026-11-15T01:00:00Z', updated_at: '2026-11-15T02:00:00Z', deleted_at: null };
  const count = t.store.applyServer(SERVER_WS, [
    { entity: 'tasks', data: { id: T, title: '서버 할 일', description: null, status: 'IN_PROGRESS', priority: 0, due_at: null, all_day: false, reminder_minutes: 1440, assignee_name: '민지', location: null, note_id: N, project_id: null, deleted_at: null } },
    { entity: 'events', data: { id: E, title: '서버 일정', description: '설명', status: 'TODO', priority: 1, start_at: '2026-11-20T05:00:00Z', end_at: '2026-11-21T06:30:00Z', all_day: false, reminder_minutes: 45, location: '강당', note_id: null, deleted_at: null } },
    { entity: 'notes', data: note },
    { entity: 'note_attachments', data: { note_id: N, asset_id: ASSET, position: 0 } },
  ]);
  assert.deepEqual(count, { notes: 1, tasks: 2, photos: 1 });
  assert.equal(t.store.outboxCount(), 0);
  const memo = t.store.getMemo(N);
  assert.deepEqual([memo.title, memo.body, memo.strokes, memo.photos, memo.taskIds, memo.revision, memo.updatedAt],
    ['', '서버 메모', STROKES, [ASSET], [T], 1, Date.parse('2026-11-15T02:00:00Z')]);
  const task = t.store.getTask(T), ev = t.store.getTask(E);
  assert.deepEqual([task.kind, task.date, task.start, task.status, task.priority, task.alarm, task.assignee], ['task', '', '', '진행 중', '보통', '하루 전', '민지']);
  assert.deepEqual([ev.kind, ev.date, ev.start, ev.endDate, ev.end, ev.priority, ev.alarm, ev.place, ev.desc], ['event', '2026-11-20', '14:00', '2026-11-21', '15:30', '낮음', '45분 전', '강당', '설명']);

  // 같은 내용을 다시 받으면(키 순서만 다른 손글씨 포함) 아무것도 바뀌지 않음 → AI 제안의 원본 변경 판단이 흔들리지 않음
  const [proposal] = t.store.addProposals([{ kind: 'task', title: '제안', date: '2026-11-18', sourceType: 'memo', sourceId: N }]);
  assert.deepEqual(t.store.applyServer(SERVER_WS, [{ entity: 'notes', data: { ...note, updated_at: '2026-11-15T03:00:00Z' } }]), { notes: 0, tasks: 0, photos: 0 });
  assert.equal(t.store.getMemo(N).revision, 1);
  // 다른 사람이 내용을 고치면 revision이 올라 승인이 막힘
  t.store.applyServer(SERVER_WS, [{ entity: 'notes', data: { ...note, body: '고친 메모', updated_at: '2026-11-15T04:00:00Z' } }]);
  assert.equal(t.store.getMemo(N).revision, 2);
  rejects(() => t.store.approveProposal(proposal.id), 'source_changed');
  // 휴지통·영구 삭제·사진 해제
  t.store.applyServer(SERVER_WS, [{ entity: 'tasks', data: { id: T, title: '서버 할 일', status: 'IN_PROGRESS', priority: 0, note_id: N, deleted_at: '2026-11-15T05:00:00Z' } }]);
  assert.deepEqual([t.store.getTask(T), t.store.getTrashedTasks().length], [null, 1]);
  t.store.applyServer(SERVER_WS, [{ entity: 'events', data: { id: E }, purged: true }, { entity: 'note_attachments', data: { note_id: N, asset_id: ASSET }, removed: true }, { entity: 'notes', data: { id: N }, purged: true }]);
  assert.deepEqual([t.store.getTask(E), t.store.getMemo(N), t.store.getProposals()], [null, null, []]);
  // 화면이 다른 키 순서로 저장한 손글씨도 같은 내용이면 바뀐 것으로 보지 않음
  const inked = t.store.addMemo({ strokes: [{ p: [[1, 2]], w: 1, c: '#000000', id: 'k1' }] });
  assert.deepEqual(t.store.applyServer(SERVER_WS, [{ entity: 'notes', data: { id: inked.id, title: null, body: '', strokes: [{ c: '#000000', id: 'k1', p: [[1, 2]], w: 1 }], deleted_at: null } }]), { notes: 0, tasks: 0, photos: 0 });
  assert.equal(t.store.getMemo(inked.id).revision, 1);
  // 내 즐겨찾기
  const m2 = t.store.addMemo({ title: '즐겨찾기' });
  assert.equal(t.store.applyFavorites(SERVER_WS, [m2.id]), 1);
  assert.equal(t.store.getMemo(m2.id).favorite, true);
  rejects(() => t.store.applyServer(t.store.getWorkspaces()[0].id, []), 'personal_workspace');
});

test('워크스페이스: 서버 공간 넣기·고치기, 역할 글자, 보기 전용은 쓰기 거절', () => {
  const t = setup();
  const id = t.store.upsertServerWorkspace({ id: SERVER_WS, name: '캡스톤', description: '', role: 'EDITOR', members: 4 });
  assert.equal(id, SERVER_WS);
  assert.deepEqual(t.store.getWorkspaces()[1], { id: SERVER_WS, name: '캡스톤', desc: '', personal: false, createdAt: t.clock.t, serverId: SERVER_WS, roleCode: 'EDITOR', role: '멤버', members: 4 });
  assert.equal(t.store.upsertServerWorkspace({ id: SERVER_WS, role: 'VIEWER', members: 5 }), SERVER_WS);
  assert.deepEqual([t.store.getWorkspaces().length, t.store.getWorkspaces()[1].role, t.store.getWorkspaces()[1].members], [2, '보기 전용', 5]);
  t.store.switchWorkspace(SERVER_WS);
  rejectsUnchanged(t, () => t.store.addMemo({ title: '안 됨' }), 'read_only');
  rejectsUnchanged(t, () => t.store.linkWorkspace(t.store.getWorkspaces()[0].id, ASSET), 'personal_workspace');
  const local = t.store.createWorkspace({ name: '새 공간' });
  rejectsUnchanged(t, () => t.store.linkWorkspace(local, SERVER_WS), 'invalid_input', 'serverId');   // 이미 다른 공간이 쓰는 서버 id
  rejectsUnchanged(t, () => t.store.linkWorkspace(local, 'nope'), 'invalid_input', 'serverId');
});

test('AI: ai-gateway /analyze 초안 → 제안 → 승인 (시간 있는 할 일은 할 일로, 중요도·끝 날짜 유지)', () => {
  const t = shared();
  const memo = t.store.addMemo({ title: '회의', body: '금요일 3시까지 보고서, 22~23일 워크숍' });
  const draft = {
    tasks: [{ title: '보고서 제출', description: '초안 포함', assignee_name: '병욱', due_date: '2026-11-20', due_time: '15:00', priority: 3, evidence: '금요일 3시까지 보고서' }],
    events: [{ title: '워크숍', description: null, location: '강당', date: '2026-11-22', start_time: null, end_date: '2026-11-23', end_time: null, all_day: true, evidence: '22~23일 워크숍' }],
  };
  const items = t.store.serverMap.proposalsFromAnalyze(draft, { sourceType: 'memo', sourceId: memo.id, sourceTitle: '회의', sourceRevision: memo.revision });
  const [p1, p2] = t.store.addProposals(items);
  assert.deepEqual([p1.kind, p1.date, p1.start, p1.priority, p1.assignee, p1.evidence], ['task', '2026-11-20', '15:00', '높음', '병욱', '금요일 3시까지 보고서']);
  assert.deepEqual([p2.kind, p2.date, p2.endDate, p2.start, p2.place], ['event', '2026-11-22', '2026-11-23', '', '강당']);
  for (const o of t.store.peekOutbox(100)) t.store.ackOutbox(o.seq);
  const saved = t.store.approveProposal(p1.id, { ...p1 });
  assert.deepEqual([saved.kind, saved.taskKind, saved.priority, saved.start], ['task', 'task', '높음', '15:00']);
  t.store.approveProposal(p2.id);
  const [c1, c2] = t.out().flat();
  assert.deepEqual([c1.entity, c1.data.due_at, c1.data.all_day, c1.data.priority, c1.data.note_id], ['tasks', '2026-11-20T15:00:00+09:00', false, 3, memo.id]);
  assert.deepEqual([c2.entity, c2.data.start_at, c2.data.end_at, c2.data.all_day, c2.data.note_id], ['events', '2026-11-22T00:00:00+09:00', '2026-11-24T00:00:00+09:00', true, memo.id]);
  assert.deepEqual(t.store.getMemo(memo.id).taskIds.length, 2);
  rejects(() => t.store.serverMap.proposalsFromAnalyze({ tasks: [] }), 'invalid_input', 'draft');
});

test('백업·계정: 개인 공간 내보내기·가져오기, 전체 지우기, 계정 묶기', () => {
  const t = shared();
  t.store.addMemo({ title: '공유 메모' });
  t.store.switchWorkspace(t.store.getWorkspaces()[0].id);
  const task = t.store.addTask({ title: '개인 할 일', date: '2026-11-16' });
  const memo = t.store.addMemo({ title: '개인 메모', strokes: STROKES, taskIds: [task.id], favorite: true });
  t.store.addProposals([{ kind: 'task', title: '제안', date: '2026-11-17', sourceType: 'memo', sourceId: memo.id }]);
  const backup = JSON.parse(JSON.stringify(t.store.exportAll()));
  assert.deepEqual([backup.format, backup.counts, backup.memos.length], [1, { memos: 1, tasks: 1, proposals: 1 }, 1]);

  const other = setup();                                    // 새 기기
  other.store.addMemo({ title: '지워질 메모' });
  assert.deepEqual(other.store.importAll(backup), { memos: 1, tasks: 1, proposals: 1 });
  assert.deepEqual(other.store.getMemos().map(m => [m.id, m.title, m.strokes, m.taskIds, m.favorite]), [[memo.id, '개인 메모', STROKES, [task.id], true]]);
  assert.equal(other.store.getProposals().length, 1);
  rejectsUnchanged(other, () => other.store.importAll({ ...backup, format: 2 }), 'unsupported_backup');
  rejectsUnchanged(other, () => other.store.importAll({ ...backup, schemaVersion: backup.schemaVersion + 1 }), 'unsupported_backup');   // 더 새 앱의 백업
  rejectsUnchanged(other, () => other.store.importAll({ ...backup, memos: [{ ...backup.memos[0], favorite: 7 }] }), 'unsupported_backup');
  assert.equal(other.store.getMemos().length, 1);           // 실패한 가져오기는 이전 기록을 지우지 않음

  assert.equal(t.store.bindAccount(ACCOUNT), ACCOUNT);
  assert.equal(t.store.bindAccount(ACCOUNT), ACCOUNT);
  rejectsUnchanged(t, () => t.store.bindAccount(ASSET), 'account_mismatch');
  t.store.clearAll();
  assert.deepEqual([t.store.getWorkspaces().length, t.store.getWorkspaces()[0].personal, t.store.getMemos(), t.store.getTasks(), t.store.outboxCount(), t.store.getAccount()], [1, true, [], [], 0, null]);
  assert.equal(t.store.bindAccount(ASSET), ASSET);
});

test('다리: 보낼 목록을 엔진에 넘기고, 엔진 기록으로 화면용 표를 맞춘다 (연결 전 호출 뒤에도 다시 돎)', async () => {
  const { createBridge } = await import('../src/index.js');
  const t = shared();
  const records = { notes: [], tasks: [], events: [], note_attachments: [] };
  const saved = [];
  const engine = {
    saveLocal: async (ctx, changes) => { saved.push([ctx.workspaceId, changes.map(c => c.kind)]); },
    syncNow: async () => ({ flush: { status: 'DONE', sent: saved.length }, pull: { status: 'OK', applied: 0, lastSeq: 1 } }),
    listLocal: async (db, ws, entity) => records[entity].map(data => ({ key: data.id, data })),
  };
  const favoriteCalls = [];
  const bridge = createBridge({ store: t.store, engine, db: {}, transport: {}, favorites: { set: async (...args) => { favoriteCalls.push(args); }, list: async () => [] } });
  const memo = t.store.addMemo({ title: '내 메모' });
  t.store.setFavorites([memo.id], true);
  assert.deepEqual(await bridge.syncAll(), {});                       // 아직 서버 공간과 연결 전
  assert.equal(t.store.outboxCount(), 2);
  t.store.linkWorkspace(t.team, SERVER_WS);
  const unlinked = t.store.createWorkspace({ name: '아직 서버에 없는 공간' });
  t.store.switchWorkspace(unlinked);
  t.store.addMemo({ title: '기다리는 메모' });
  t.store.switchWorkspace(t.team);
  records.notes = [{ id: memo.id, title: '내 메모', body: '', strokes: [] }, { id: '77777777-7777-4777-8777-777777777777', title: '남의 메모', body: '', strokes: [] }];
  const [first, second] = await Promise.all([bridge.syncAll(), bridge.syncAll()]);   // 동시에 불러도 한 번만
  assert.equal(first, second);
  assert.deepEqual([first[t.team].status, first[t.team].applied], ['OK', { notes: 1, tasks: 0, photos: 0 }]);
  assert.deepEqual(saved, [[SERVER_WS, ['create']]]);
  assert.deepEqual(favoriteCalls, [[SERVER_WS, [memo.id], true]]);
  assert.deepEqual([t.store.outboxCount(), t.store.getMemos().map(m => m.title).sort(), t.store.getMemo(memo.id).favorite], [1, ['남의 메모', '내 메모'], false]);   // 연결 안 된 공간의 1줄은 남음
  records.notes = [records.notes[0]];                                 // 서버에서 사라진 기록은 기기에서도 지움
  await bridge.syncAll();
  assert.deepEqual(t.store.getMemos().map(m => m.title), ['내 메모']);
  assert.deepEqual(await bridge.syncWorkspace(t.store.getWorkspaces()[0].id), { status: 'NOT_SHARED' });
});

test('서버에 맞추기 전 스키마로 만든 DB 파일은 조용히 쓰지 않고 열 때 알린다', async () => {
  const { openDatabaseSync } = await import('./expo-sqlite-node.mjs');
  const { createLocalStore } = await import('../src/index.js');
  const db = openDatabaseSync();
  db.execSync('create table workspaces(id text primary key, name text not null); pragma user_version = 1');
  assert.throws(() => createLocalStore({ db }), /이전 스키마/);
});

test('화면이 그대로 부르는 모양: switchWorkspace(\'personal\'), joinWorkspace, 프로젝트 화면 값 변환', () => {
  const t = shared();
  const personal = t.store.getWorkspaces()[0].id;
  assert.equal(t.store.switchWorkspace('personal'), personal);            // BackupScreen
  assert.equal(t.store.getCurrentWorkspace().personal, true);
  const joined = t.store.joinWorkspace({ id: SERVER_WS, name: '팀 프로젝트 회의', role: '멤버', members: 3 });   // WorkspaceInviteScreen + accept_invite 결과
  assert.deepEqual([joined, t.store.getWorkspaces().find(w => w.id === joined).role, t.store.getWorkspaces().find(w => w.id === joined).members], [SERVER_WS, '멤버', 3]);
  rejectsUnchanged(t, () => t.store.joinWorkspace({ name: '서버 id 없음', role: '멤버', members: 2 }), 'invalid_input', 'id');
  rejectsUnchanged(t, () => t.store.joinWorkspace({ id: ASSET, name: 'x', role: '손님' }), 'invalid_input', 'role');

  const map = t.store.serverMap;
  const form = { title: '발표 준비', due: '2026-11-30', priority: '높음', status: '보류', alarm: '하루 전', assignee: '병욱', place: '', desc: '' };   // ProjectEditScreen
  const data = map.projectData(form);
  assert.deepEqual(data, { name: '발표 준비', due_date: '2026-11-30', priority: 3, progress_status: 'ON_HOLD', reminder_minutes: 1440, assignee_name: '병욱', location: null, description: null });
  assert.deepEqual(map.projectFromServer({ id: 'p', ...data }), { id: 'p', ...form });
  assert.deepEqual(map.projectData({ status: '완료' }), { progress_status: 'DONE' });
  rejects(() => map.projectData({ status: '모름' }), 'invalid_input', 'status');
  rejects(() => map.projectData({ due: '11/30' }), 'invalid_input', 'due');
});

test('스키마 단계 올리기: 다음 단계가 생겨도 기존 기록은 남고, 실패한 단계는 없던 일이 된다', async () => {
  const { migrate } = await import('../src/schema.js');
  const { createLocalStore } = await import('../src/index.js');
  const t = setup();
  const memo = t.store.addMemo({ title: '올리기 전의 메모' });
  const opts = { now: () => 1, newId: () => '00000000-0000-4000-8000-000000009999' };
  const version = () => t.db.getFirstSync('pragma user_version').user_version;
  const columns = () => t.db.getAllSync('pragma table_info(memos)').map(c => c.name);
  const next = 'alter table memos add column pinned integer not null default 0';
  assert.throws(() => migrate(t.db, opts, ['', `${next}; insert into 없는_표 values (1)`]));
  assert.deepEqual([version(), columns().includes('pinned')], [1, false]);                 // 실패한 단계는 통째로 되돌려짐
  migrate(t.db, opts, ['', next]);
  migrate(t.db, opts, ['', next]);                                                         // 이미 올린 DB는 그대로
  assert.deepEqual([version(), columns().includes('pinned'), t.db.getFirstSync('select title, pinned from memos where id=?', [memo.id])], [2, true, { title: '올리기 전의 메모', pinned: 0 }]);
  assert.equal(t.db.getAllSync('select id from workspaces').length, 1);                    // 개인 공간을 또 만들지 않음
  assert.throws(() => createLocalStore({ db: t.db }), /Unsupported local database version 2/);   // 더 새 앱이 만든 DB를 예전 앱이 열면 알림
});
