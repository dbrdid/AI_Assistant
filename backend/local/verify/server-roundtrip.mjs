// 새 기기 저장소 ↔ 실제 서버 스키마 왕복 검증 (로컬 Postgres에 마이그레이션 전부 적용한 DB)
//   기기 A·B 각각: 저장소(store) + 동기화 엔진(local-sync) + 다리(bridge). 서버는 sync_push·sync_pull·sync_snapshot 그대로.
//   실행: supabase/tests/reset.sh ../migrations/*.sql 뒤에
//         node verify/server-roundtrip.mjs            (stella-sync-verify가 옆 폴더에 있어야 함, STELLA_VERIFY로 경로 지정 가능)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { openDatabaseSync } from '../tests/expo-sqlite-node.mjs';
import { createLocalStore, createBridge } from '../src/index.js';
import { appendMemoReference, memoReferenceIds, removeMemoReference } from '../../../frontend/Frontend_UI/src/features/memo/utils/memoReferences.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifyDir = process.env.STELLA_VERIFY ?? path.resolve(here, '../../../tests/sync-verify');
const require = createRequire(path.join(verifyDir, 'verify.js'));
const engine = require('./lib/local-sync.js');
const { localAdmin, localUser } = require('./src/server-local.js');
const { newDevice } = require('./src/device.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `  → ${detail}`}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const STROKES = [{ id: 's1', c: '#111111', w: 2.5, p: [[10, 20], [11.5, 21.25]] }];

const admin = await localAdmin();
const stamp = Date.now();
const idA = await admin.createUser(`store-a-${stamp}@test.dev`, '병욱');
const idB = await admin.createUser(`store-b-${stamp}@test.dev`, '주원');
const A = await localUser(idA, 'a'), B = await localUser(idB, 'b');
const ws = await A.rpc('create_workspace', { p_name: '저장소 왕복 검증', p_description: '새 기기 저장소' });
const inv = await A.rpc('create_invite', { p_workspace_id: ws, p_role: 'EDITOR', p_expires_in_hours: 1, p_max_uses: 1 });
await B.rpc('accept_invite', { p_code: inv.code });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-roundtrip-'));
async function device(name, user, accountId) {
  const store = createLocalStore({ db: openDatabaseSync(':memory:'), newId: randomUUID });
  const dev = newDevice(dir, name);
  await engine.setupLocalSync(dev.db);
  const favorites = {
    set: (w, ids, on) => user.rpc('set_note_favorites', { p_workspace_id: w, p_note_ids: ids, p_favorite: on }),
    list: async w => (await user.select('note_favorites', 'workspace_id', w)).filter(r => r.account_id === accountId).map(r => r.note_id),
  };
  // 엔진이 서버와 주고받은 직후(다리가 화면용 표를 맞추기 전)에 화면에서 저장하는 상황을 넣을 수 있게 함
  const hook = { during: null };
  const hooked = { ...engine, syncNow: async (ctx, opts) => { const r = await engine.syncNow(ctx, opts); const fn = hook.during; hook.during = null; fn?.(); return r; } };
  const bridge = createBridge({ store, engine: hooked, db: dev.db, transport: user.transport(), accountId, favorites });
  return { store, bridge, dev, hook, favorites, user };
}
const a = await device('storeA', A, idA), b = await device('storeB', B, idB);
const view = s => ({
  memos: [...s.getMemos()].sort((x, y) => x.id.localeCompare(y.id)).map(m => [m.id, m.title, m.body, m.strokes, [...m.taskIds].sort()]),
  trashedMemos: s.getTrashedMemos().map(m => m.id).sort(),
  tasks: [...s.getTasks()].sort((x, y) => x.id.localeCompare(y.id)).map(t => [t.id, t.kind, t.title, t.date, t.endDate, t.start, t.end, t.priority, t.status, t.alarm, t.assignee, t.place, t.desc]),
  trashedTasks: s.getTrashedTasks().map(t => t.id).sort(),
});
const syncBoth = async () => { const ra = await a.bridge.syncAll(); const rb = await b.bridge.syncAll(); const ra2 = await a.bridge.syncAll(); return [ra, rb, ra2]; };
const flushOf = (r, s) => Object.values(r)[0]?.flush?.status ?? Object.values(r)[0]?.status ?? `none(${s})`;

try {
  // 1. A: 기기에서 먼저 공간을 만들고 저장한 뒤 서버 공간과 연결 (그동안 쌓인 변경이 올라가야 함)
  const localWs = a.store.createWorkspace({ name: '저장소 왕복 검증', desc: '새 기기 저장소' });
  a.store.switchWorkspace(localWs);
  const memo = a.store.addMemo({ title: '', body: '금요일 3시까지 보고서, 22~23일 워크숍', strokes: STROKES });
  const titled = a.store.addMemo({ title: 'x'.repeat(200), body: '제목 200자' });
  const ev = a.store.addTask({ title: '팀 회의', date: '2026-11-20', start: '14:00', end: '15:30', priority: '높음', alarm: '10분 전', place: '공학관 301', assignee: '병욱', desc: '안건 3개' });
  const todo = a.store.addTask({ title: '보고서', date: '2026-11-21' });
  const allDay = a.store.addTask({ kind: 'event', title: '워크숍', date: '2026-11-22', endDate: '2026-11-23', alarm: '하루 전' });
  const timedTask = a.store.addTask({ kind: 'task', title: '제출', date: '2026-11-20', start: '15:00', status: '진행 중', priority: '낮음' });
  const pointEv = a.store.addTask({ title: '전화', date: '2026-11-24', start: '09:00' });
  a.store.updateMemo(memo.id, { taskIds: [ev.id, todo.id] });
  check('연결 전에는 보낼 목록에 쌓이기만 함', a.store.outboxCount() === 8 && same(await a.bridge.syncAll(), {}), `outbox=${a.store.outboxCount()}`);
  a.store.linkWorkspace(localWs, ws);
  b.store.upsertServerWorkspace({ id: ws, name: '저장소 왕복 검증', description: '새 기기 저장소', role: 'EDITOR', members: 2 });
  b.store.switchWorkspace(ws);
  let [ra, rb] = await syncBoth();
  check('A의 저장 8번이 서버에 모두 받아들여짐 (서버 check 제약 통과)', flushOf(ra) === 'DONE' && a.store.outboxCount() === 0, JSON.stringify(ra).slice(0, 600));
  check('B가 받은 메모·일정·할 일이 A와 같음', same(view(a.store), view(b.store)), `\nA ${JSON.stringify(view(a.store))}\nB ${JSON.stringify(view(b.store))}`);
  check('B에서 종류·시간·글자가 그대로 (일정 5칸 · 할 일 2칸)', b.store.getTasks().length === 5
    && same(b.store.getTask(allDay.id) && [b.store.getTask(allDay.id).start, b.store.getTask(allDay.id).endDate, b.store.getTask(allDay.id).alarm], ['', '2026-11-23', '하루 전'])
    && same([b.store.getTask(timedTask.id).kind, b.store.getTask(timedTask.id).start, b.store.getTask(timedTask.id).status], ['task', '15:00', '진행 중'])
    && same([b.store.getTask(pointEv.id).start, b.store.getTask(pointEv.id).end], ['09:00', '']), JSON.stringify(b.store.getTasks()));
  const server = { notes: await A.select('notes', 'workspace_id', ws), tasks: await A.select('tasks', 'workspace_id', ws), events: await A.select('events', 'workspace_id', ws) };
  check('서버 행: 빈 제목은 null, 일정 3·할 일 2, note_id 연결', server.notes.find(n => n.id === memo.id).title === null && server.events.length === 3 && server.tasks.length === 2
    && server.events.find(e => e.id === ev.id).note_id === memo.id && server.tasks.find(t => t.id === todo.id).note_id === memo.id
    && server.tasks.find(t => t.id === timedTask.id).all_day === false && server.events.find(e => e.id === allDay.id).all_day === true, JSON.stringify(server.tasks));

  // 2. B가 고침 → A에 반영 (바뀐 칸만 보내므로 서로 다른 칸 수정은 덮이지 않음)
  b.store.updateTask(ev.id, { start: '15:00', end: '16:00', place: '강당' });
  b.store.toggleDone(todo.id);
  b.store.updateMemo(memo.id, { body: 'B가 고친 본문', taskIds: [ev.id] });
  a.store.updateTask(ev.id, { alarm: '1시간 전' });                     // 같은 일정의 다른 칸을 A가 동시에 고침
  [ra, rb] = await syncBoth();
  const afterB = Object.values(rb)[0];
  check('B의 수정 보내기: 받아들여지거나 충돌로 멈춤(같은 기록을 A가 먼저 고친 경우)', ['DONE', 'CONFLICT'].includes(afterB.flush.status), afterB.flush.status);
  if (afterB.flush.status === 'CONFLICT') {
    await engine.resolveConflict({ db: b.dev.db, transport: B.transport(), workspaceId: ws, myAccountId: idB }, afterB.flush.outboxSeq, 'keep_mine');
    await syncBoth();
  }
  await syncBoth();
  check('양쪽이 같은 상태로 모임', same(view(a.store), view(b.store)), `\nA ${JSON.stringify(view(a.store).tasks)}\nB ${JSON.stringify(view(b.store).tasks)}`);
  const evA = a.store.getTask(ev.id);
  check('A·B가 고친 칸이 모두 살아 있음 (시간·장소 = B, 알림 = A)', same([evA.start, evA.end, evA.place, evA.alarm], ['15:00', '16:00', '강당', '1시간 전']), JSON.stringify(evA));
  check('메모 내용이 바뀌면 A의 기기 revision이 오르고 연결이 줄어듦', a.store.getMemo(memo.id).revision === 2 && same(a.store.getMemo(memo.id).taskIds, [ev.id])
    && a.store.getTask(todo.id).status === '완료', JSON.stringify(a.store.getMemo(memo.id)));

  // 3. AI 제안 승인 → 서버 (시간 있는 할 일은 tasks로)
  const m = a.store.getMemo(memo.id);
  const items = a.store.serverMap.proposalsFromAnalyze({
    tasks: [{ title: 'AI 할 일', description: null, assignee_name: '주원', due_date: '2026-11-25', due_time: '18:00', priority: 3, evidence: '근거' }],
    events: [{ title: 'AI 일정', description: null, location: null, date: '2026-11-26', start_time: '10:00', end_date: null, end_time: null, all_day: false, evidence: '근거' }],
  }, { sourceType: 'memo', sourceId: m.id, sourceTitle: '메모', sourceRevision: m.revision });
  const saved = a.store.addProposals(items).map(p => a.store.approveProposal(p.id));
  await syncBoth();
  const aiTask = (await A.select('tasks', 'id', saved[0].id))[0], aiEvent = (await A.select('events', 'id', saved[1].id))[0];
  check('승인한 제안이 서버에 할 일·일정으로, 메모와 연결돼 저장됨', aiTask?.priority === 3 && aiTask.all_day === false && aiTask.note_id === memo.id && aiTask.assignee_name === '주원'
    && aiEvent?.note_id === memo.id && new Date(aiEvent.start_at).getTime() === new Date(aiEvent.end_at).getTime(), JSON.stringify([aiTask, aiEvent]));
  check('B의 메모에 승인된 항목 2개가 연결돼 보임', same([...b.store.getMemo(memo.id).taskIds].sort(), [ev.id, saved[0].id, saved[1].id].sort()), JSON.stringify(b.store.getMemo(memo.id).taskIds));

  // 4. 휴지통·복구·영구 삭제
  a.store.deleteTask(pointEv.id);
  a.store.trashMemo(titled.id);
  await syncBoth();
  check('휴지통이 B에도 보임', same(b.store.getTrashedTasks().map(t => t.id), [pointEv.id]) && same(b.store.getTrashedMemos().map(x => x.id), [titled.id]) && b.store.getTask(pointEv.id) === null);
  b.store.restoreTasks([pointEv.id]);
  a.store.deleteMemoForever(titled.id);
  const scratch = a.store.addMemo({ title: '바로 영구 삭제' });
  a.store.deleteMemoForever(scratch.id);                                  // 휴지통에 없던 메모: 삭제 → 영구 삭제 두 번에 나눠 보냄
  [ra, rb] = await syncBoth();
  check('복구·영구 삭제가 서버에 받아들여짐', flushOf(ra) === 'DONE' && flushOf(rb) === 'DONE', `${flushOf(ra)} ${flushOf(rb)}`);
  await syncBoth();
  check('복구한 일정은 양쪽에 보이고, 영구 삭제한 메모는 양쪽·서버에서 사라짐', a.store.getTask(pointEv.id) !== null && b.store.getMemo(titled.id) === null && b.store.getMemo(scratch.id) === null
    && (await A.select('notes', 'id', titled.id)).length === 0 && (await A.select('notes', 'id', scratch.id)).length === 0 && same(view(a.store), view(b.store)));

  // 5. 즐겨찾기는 사람마다 따로
  a.store.setFavorites([memo.id], true);
  await syncBoth();
  check('A의 즐겨찾기는 서버에 A 것으로만 저장되고 B에는 안 보임', a.store.getMemo(memo.id).favorite === true && b.store.getMemo(memo.id).favorite === false
    && (await A.select('note_favorites', 'note_id', memo.id)).length === 1 && a.store.outboxCount() === 0);

  // 6. 기기 한도 = 서버 한도: 기기에서 통과한 큰 손글씨는 서버도 받음
  const big = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, c: '#111111', w: 2, p: Array.from({ length: 10_000 }, (_, j) => [1000.5 + j, 2000.5 + j]) }));
  const inked = a.store.addMemo({ strokes: big });
  [ra] = await syncBoth();
  check('점 5만 개 손글씨(기기 한도 안)를 서버가 받고 B에서 같은 획으로 보임', flushOf(ra) === 'DONE' && same(b.store.getMemo(inked.id)?.strokes, big), flushOf(ra));
  // 7. 프로젝트 화면 값 → 서버 (프로젝트는 저장소가 아니라 엔진으로 바로 저장)
  const projectId = randomUUID();
  const form = { title: '발표 준비', due: '2026-11-30', priority: '높음', status: '보류', alarm: '하루 전', assignee: '병욱', place: '공학관', desc: '캡스톤' };
  await engine.saveLocal({ db: a.dev.db, transport: A.transport(), workspaceId: ws, myAccountId: idA }, [{ kind: 'create', entity: 'projects', id: projectId, data: a.store.serverMap.projectData(form) }]);
  [ra] = await syncBoth();
  const projectRow = (await B.select('projects', 'id', projectId))[0];
  check('프로젝트 화면 값이 서버에 받아들여지고 다시 같은 화면 값으로 돌아옴', flushOf(ra) === 'DONE' && !!projectRow
    && same(b.store.serverMap.projectFromServer({ ...projectRow, due_date: typeof projectRow.due_date === 'string' ? projectRow.due_date : new Date(projectRow.due_date.getTime() + 9 * 3600000).toISOString().slice(0, 10) }), { id: projectId, ...form }), JSON.stringify(projectRow));

  // 8. 동기화 도중에 한 저장: 화면에서 사라지지 않고, 같은 syncAll 안에서 서버까지 올라감 (새 메모의 별표도)
  let midNew, midEdit, midProposal;
  a.hook.during = () => {
    midNew = a.store.addMemo({ title: '동기화 중에 쓴 메모', body: '내일 3시 회의', favorite: true });
    [midProposal] = a.store.addProposals([{ kind: 'event', title: '회의', date: '2026-11-27', start: '15:00', sourceType: 'memo', sourceId: midNew.id, sourceTitle: midNew.title, sourceRevision: midNew.revision }]);
    midEdit = a.store.updateMemo(memo.id, { body: '동기화 중에 고친 본문' });
  };
  ra = await a.bridge.syncAll();
  const midServer = (await A.select('notes', 'id', midNew.id))[0];
  check('동기화 도중에 쓴 메모·수정·AI 제안이 화면에 그대로 있고 같은 호출에서 서버에 올라감', flushOf(ra) === 'DONE' && a.store.outboxCount() === 0
    && a.store.getMemo(midNew.id)?.title === '동기화 중에 쓴 메모' && a.store.getMemo(memo.id).body === '동기화 중에 고친 본문' && a.store.getMemo(memo.id).revision === midEdit.revision
    && a.store.getProposal(midProposal.id)?.status === 'pending' && midServer?.body === '내일 3시 회의'
    && (await A.select('notes', 'id', memo.id))[0].body === '동기화 중에 고친 본문', JSON.stringify([ra, a.store.getMemo(midNew.id), midServer]));
  check('새 메모에 바로 누른 별표가 첫 동기화에서 서버에 저장되고 화면에 켜져 있음', a.store.getMemo(midNew.id).favorite === true
    && (await A.select('note_favorites', 'note_id', midNew.id)).length === 1, JSON.stringify(a.store.getMemo(midNew.id)));
  await syncBoth();
  check('B도 그 메모와 수정을 받음', b.store.getMemo(midNew.id)?.body === '내일 3시 회의' && b.store.getMemo(memo.id).body === '동기화 중에 고친 본문' && same(view(a.store), view(b.store)));

  // 9. 한 번에 120개를 휴지통으로 → 영구 삭제 (엔진은 한 묶음 100개까지)
  const bulk = Array.from({ length: 120 }, (_, i) => a.store.addMemo({ title: `정리할 메모 ${i}` }).id);
  await syncBoth();
  a.store.trashMemos(bulk);
  const bulkRows = a.store.peekOutbox(10).map(r => r.changes.length);
  [ra] = await syncBoth();
  const trashedOnServer = (await A.select('notes', 'workspace_id', ws)).filter(n => bulk.includes(n.id) && n.deleted_at).length;
  check('120개를 한 번에 휴지통으로: 100+20으로 나눠 보내고 서버·B 휴지통에 120개', same(bulkRows, [100, 20]) && flushOf(ra) === 'DONE' && trashedOnServer === 120
    && b.store.getTrashedMemos().filter(m => bulk.includes(m.id)).length === 120, `${JSON.stringify(bulkRows)} ${flushOf(ra)} 서버 ${trashedOnServer}`);
  a.store.deleteMemosForever(bulk);
  [ra] = await syncBoth();
  await syncBoth();
  const leftOnServer = (await A.select('notes', 'workspace_id', ws)).filter(n => bulk.includes(n.id)).length;
  check('120개 영구 삭제도 막히지 않고 서버·양쪽 기기에서 사라짐', flushOf(ra) === 'DONE' && leftOnServer === 0 && a.store.outboxCount() === 0
    && b.store.getTrashedMemos().every(m => !bulk.includes(m.id)) && same(view(a.store), view(b.store)), `${flushOf(ra)} 서버에 남은 ${leftOnServer}`);

  // 10. 넘긴 직후 앱이 꺼짐: 엔진에는 들어갔는데 보낼 목록에서 못 지움 → 다시 넘겨도 서버에는 한 번만 (충돌 없음)
  const crashed = a.store.addMemo({ title: '넘긴 직후 꺼진 메모' });
  let crashOnce = true;
  const flaky = { ...a.store, ackOutbox: seq => { if (crashOnce) { crashOnce = false; throw new Error('앱이 꺼짐'); } return a.store.ackOutbox(seq); } };
  const restarted = createBridge({ store: flaky, engine, db: a.dev.db, transport: A.transport(), accountId: idA, favorites: a.favorites });
  const firstTry = Object.values(await restarted.syncAll())[0];
  const secondTry = Object.values(await restarted.syncAll())[0];
  const crashedRows = await A.select('notes', 'id', crashed.id);
  check('넘긴 직후 꺼져 같은 저장을 다시 넘겨도 충돌 없이 한 번만 저장됨', firstTry.status === 'ERROR' && secondTry.status === 'OK' && secondTry.flush.status === 'DONE'
    && a.store.outboxCount() === 0 && crashedRows.length === 1 && Number(crashedRows[0].revision) === 1
    && (await engine.getSyncStatus(a.dev.db, ws)).pending === 0, JSON.stringify([firstTry, secondTry.flush, crashedRows.map(r => r.revision)]));
  await syncBoth();

  // 12. 충돌 스스로 합치기: 같은 메모의 다른 줄·다른 칸을 두 기기가 동시에 고쳐도 화면에서 고를 것 없이 둘 다 남음
  const shared = a.store.addMemo({ title: '회의 안건', body: '안건\n1. 일정\n2. 예산\n3. 역할' });
  await syncBoth();
  a.store.updateMemo(shared.id, { body: '안건\n1. 일정 확정\n2. 예산\n3. 역할\n4. A가 더한 줄' });
  b.store.updateMemo(shared.id, { title: 'B가 고친 제목', body: '안건\n1. 일정\n2. 예산\n3. 역할 분담\n4. B가 더한 줄' });
  [ra, rb] = await syncBoth();
  await syncBoth();
  const mergedRow = (await A.select('notes', 'id', shared.id))[0];
  check('다른 줄·다른 칸 동시 수정이 스스로 합쳐져 서버·양쪽 기기에 둘 다 남음', flushOf(rb) === 'DONE' && Object.values(rb)[0].merged === 1 && mergedRow.title === 'B가 고친 제목'
    && mergedRow.body === '안건\n1. 일정 확정\n2. 예산\n3. 역할 분담\n4. B가 더한 줄\n4. A가 더한 줄' && a.store.getMemo(shared.id).body === mergedRow.body && same(view(a.store), view(b.store)),
    JSON.stringify([flushOf(rb), Object.values(rb)[0].merged, mergedRow.title, mergedRow.body]));
  // 같은 줄을 다르게 고치면 스스로 합치지 않고, 화면에 무엇이 다른지 알려 준 뒤 고른 대로 품
  a.store.updateMemo(shared.id, { body: mergedRow.body.replace('2. 예산', '2. 예산 100만') });
  b.hook.during = () => b.store.updateMemo(shared.id, { body: mergedRow.body.replace('2. 예산', '2. 예산 200만') });
  [ra, rb] = await syncBoth();
  const found = await b.bridge.issues(ws);
  const field = found.conflicts[0]?.items[0]?.fields[0];
  check('서버 변경을 받은 직후 화면에서 같은 줄을 저장해도 두 편집과 편집 기준이 남음', flushOf(rb) === 'CONFLICT' && found.conflicts.length === 1 && found.conflicts[0].mergeable === false
    && field?.field === 'body' && field.mine.includes('200만') && field.server.includes('100만') && field.base === mergedRow.body
    && (await b.bridge.status()).state === 'attention' && b.store.getMemo(shared.id).body.includes('200만'), JSON.stringify([flushOf(rb), found]).slice(0, 500));
  const solved = await b.bridge.resolve(ws, found.conflicts[0].outboxSeq, 'keep_both');
  await syncBoth();
  const bothRow = (await A.select('notes', 'id', shared.id))[0];
  check("'둘 다 남기기'로 풀면 두 줄이 모두 서버·양쪽 기기에 남고 상태가 정상으로 돌아옴", solved.status === 'OK' && solved.flush.status === 'DONE'
    && same(bothRow.body.split('\n').filter(l => l.startsWith('2.')), ['2. 예산 200만', '2. 예산 100만']) && same(view(a.store), view(b.store))
    && (await b.bridge.status()).state === 'synced' && (await b.bridge.issues(ws)).conflicts.length === 0, JSON.stringify([solved.status, solved.flush, bothRow.body]));

  const blockBase = '## 회의\n- [ ] 초안 검토\n- 공유할 자료';
  const blockNote = a.store.addMemo({ title: '팀 체크리스트', body: blockBase });
  await syncBoth();
  const checkedBody = blockBase.replace('- [ ]', '- [x]');
  const editedHeading = blockBase.replace('## 회의', '## 월간 회의');
  a.store.updateMemo(blockNote.id, { body: checkedBody });
  b.store.updateMemo(blockNote.id, { body: editedHeading });
  [, rb] = await syncBoth();
  await syncBoth();
  const expectedBlockBody = editedHeading.replace('- [ ]', '- [x]');
  const serverBlock = (await A.select('notes', 'id', blockNote.id))[0];
  check('두 기기의 소제목 수정과 체크 상태가 서버 및 양쪽 기기에 함께 남음',
    flushOf(rb) === 'DONE' && serverBlock.body === expectedBlockBody &&
    a.store.getMemo(blockNote.id).body === expectedBlockBody && b.store.getMemo(blockNote.id).body === expectedBlockBody,
    JSON.stringify([flushOf(rb), serverBlock.body]));
  check('동기화가 본문을 합친 뒤 각 기기에서 합치기 전 편집을 확인할 수 있음',
    a.store.listMemoVersions(blockNote.id).some(version => version.body === checkedBody) &&
    b.store.listMemoVersions(blockNote.id).some(version => version.body === editedHeading));

  const priorVersion = b.store.listMemoVersions(blockNote.id).find(version => version.body === editedHeading);
  assert.ok(priorVersion, 'Expected a version that can be restored');
  const { title, body, strokes } = priorVersion;
  b.store.updateMemo(blockNote.id, { title, body, strokes });
  [, rb] = await syncBoth();
  const restoredRows = await A.select('notes', 'id', blockNote.id);
  check('편집 기록에서 불러와 저장한 본문이 서버와 두 기기에 반영됨',
    flushOf(rb) === 'DONE' && restoredRows[0]?.body === editedHeading &&
    [a, b].every(device => device.store.getMemo(blockNote.id)?.body === editedHeading));
  check('이전 버전 저장 후에도 복원 직전 본문을 두 기기의 편집 기록에서 찾을 수 있음',
    [a, b].every(device => device.store.listMemoVersions(blockNote.id)
      .some(version => version.body === expectedBlockBody)));

  const childId = a.store.addMemo({ title: '하위 페이지', parentMemoId: blockNote.id }).id;
  const pushHierarchy = (op) => A.transport().push(ws, randomUUID(), [{ entity: 'notes', ...op }]);
  await syncBoth();
  check('공유 페이지에 상위 페이지를 지정할 수 있음',
    (await B.select('notes', 'id', childId))[0]?.parent_note_id === blockNote.id &&
    b.store.getMemo(childId)?.parentMemoId === blockNote.id);
  b.store.setMemoParent(childId, null);
  await syncBoth();
  check('다른 기기에서 최상위로 옮긴 페이지가 양쪽에 반영됨', a.store.getMemo(childId)?.parentMemoId === null);
  b.store.setMemoParent(childId, blockNote.id);
  await syncBoth();
  a.store.setMemoParent(childId, shared.id);
  b.hook.during = () => b.store.setMemoParent(childId, null);
  [, rb] = await syncBoth();
  const moveIssue = (await b.bridge.issues(ws)).conflicts[0];
  const parentField = moveIssue?.items[0]?.fields.find(field => field.field === 'parent_note_id');
  check('같은 페이지를 옮기면 내 위치·서버 위치·원래 위치가 모두 남음',
    flushOf(rb) === 'CONFLICT' && parentField?.base === blockNote.id &&
    parentField.mine === null && parentField.server === shared.id);
  assert.ok(moveIssue, 'Expected page move conflict');
  await b.bridge.resolve(ws, moveIssue.outboxSeq, 'use_server');
  await syncBoth();
  check('서버 위치를 선택하면 양쪽 페이지 계층이 같은 위치로 맞춰짐',
    a.store.getMemo(childId)?.parentMemoId === shared.id && b.store.getMemo(childId)?.parentMemoId === shared.id);

  const firstPage = a.store.addMemo({ title: '첫 번째 페이지' });
  const secondPage = a.store.addMemo({ title: '두 번째 페이지' });
  await syncBoth();
  a.store.setMemoParent(firstPage.id, secondPage.id);
  b.store.setMemoParent(secondPage.id, firstPage.id);
  b.store.updateMemo(secondPage.id, { body: '이동 뒤 작성한 본문' });
  [, rb] = await syncBoth();
  const rejectedMove = (await b.bridge.issues(ws)).rejected.find(issue =>
    issue.changes.length === 1 && issue.changes[0].id === secondPage.id &&
    issue.changes[0].data.parent_note_id === firstPage.id);
  assert.equal(flushOf(rb), 'BLOCKED');
  assert.ok(rejectedMove, 'Expected a rejected page move in the outbox');
  const discarded = await b.bridge.discard(ws, rejectedMove.outboxSeq);
  await syncBoth();
  check('거절된 이동을 취소하면 양쪽의 계층이 일치하고 대기하던 본문이 저장됨',
    discarded.flush?.status === 'DONE' && [a, b].every(device =>
      device.store.getMemo(firstPage.id)?.parentMemoId === secondPage.id &&
      device.store.getMemo(secondPage.id)?.parentMemoId === null &&
      device.store.getMemo(secondPage.id)?.body === '이동 뒤 작성한 본문'));

  a.store.setMemoParent(childId, blockNote.id);
  await syncBoth();
  await assert.rejects(() => pushHierarchy({
    op: 'UPSERT', id: blockNote.id, base_revision: restoredRows[0].revision, data: { parent_note_id: childId },
  }), /cycle/i);
  check('공유 페이지의 순환 이동을 서버에서 거부함', (await B.select('notes', 'id', blockNote.id))[0]?.parent_note_id === null);
  const parentTrash = await pushHierarchy({ op: 'DELETE', id: blockNote.id, base_revision: restoredRows[0].revision, data: {} });
  const parentPurge = await pushHierarchy({ op: 'PURGE', id: blockNote.id, base_revision: parentTrash.results[0].revision, data: {} });
  check('상위 페이지를 영구 삭제하면 하위 페이지는 연결만 해제됨', parentTrash.status === 'ACCEPTED' &&
    parentPurge.status === 'ACCEPTED' && (await B.select('notes', 'id', childId))[0]?.parent_note_id === null);
  await syncBoth();
  check('서버에서 해제한 계층을 두 기기에 반영함',
    a.store.getMemo(childId)?.parentMemoId === null && b.store.getMemo(childId)?.parentMemoId === null);

  // listLocal orders by key, so the new child is projected before the old link is cleared.
  const [earlierId, laterId] = [randomUUID(), randomUUID()].sort();
  const hierarchyTransport = A.transport();
  const hierarchyBatch = (changes) => hierarchyTransport.push(ws, randomUUID(),
    changes.map(change => ({ entity: 'notes', op: 'UPSERT', ...change })));
  const initialHierarchy = await hierarchyBatch([
    { id: earlierId, data: { title: '처음 상위' } },
    { id: laterId, data: { title: '처음 하위', parent_note_id: earlierId } },
  ]);
  assert.equal(initialHierarchy.status, 'ACCEPTED');
  await b.bridge.syncAll();
  assert.equal(b.store.getMemo(laterId).parentMemoId, earlierId);
  const reverseHierarchy = await hierarchyBatch([
    { id: laterId, base_revision: initialHierarchy.results[1].revision, data: { parent_note_id: null } },
    { id: earlierId, base_revision: initialHierarchy.results[0].revision, data: { parent_note_id: laterId } },
  ]);
  assert.equal(reverseHierarchy.status, 'ACCEPTED');
  await b.bridge.syncAll();
  check('서버 계층의 상하 반전을 한 번의 동기화에서 반영함',
    b.store.getMemo(laterId).parentMemoId === null && b.store.getMemo(earlierId).parentMemoId === laterId);

  const referenced = a.store.addMemo({ title: '참조 대상', body: '자료' });
  const referencing = a.store.addMemo({ title: '참조 원본', body: '회의 본문' });
  await syncBoth();
  a.store.updateMemo(referencing.id, {
    body: appendMemoReference(referencing.body, referenced.id, referenced.title),
  });
  b.store.updateMemo(referenced.id, { title: '새 자료 제목' });
  b.store.updateMemo(referencing.id, { body: '다른 기기에서 수정한 회의 본문' });
  await syncBoth();
  await syncBoth();
  const linkOnB = b.store.getMemo(referencing.id).body;
  check('공유 메모의 연결 추가와 다른 기기의 본문 수정이 함께 동기화됨',
    linkOnB.includes('다른 기기에서 수정한 회의 본문') && memoReferenceIds(linkOnB).has(referenced.id) &&
    a.store.getMemo(referencing.id).body === linkOnB && a.store.getMemo(referenced.id).title === '새 자료 제목');
  a.store.trashMemo(referenced.id);
  await syncBoth();
  assert.equal(b.store.getMemos().some(note => note.id === referenced.id), false);
  assert.ok(memoReferenceIds(b.store.getMemo(referencing.id).body).has(referenced.id));
  b.store.restoreMemos([referenced.id]);
  await syncBoth();
  check('참조 대상이 휴지통에서 복원되면 양쪽 기기에서 같은 ID를 다시 열 수 있음',
    [a, b].every(({ store }) => store.getMemos().some(note => note.id === referenced.id) &&
      memoReferenceIds(store.getMemo(referencing.id).body).has(referenced.id)));
  a.store.updateMemo(referencing.id, { body: removeMemoReference(a.store.getMemo(referencing.id).body, referenced.id) });
  await syncBoth();
  check('공유 메모 연결을 해제해도 양쪽 기기에 대상 메모는 남음',
    [a, b].every(({ store }) => store.getMemo(referencing.id).body === '다른 기기에서 수정한 회의 본문' &&
      store.getMemo(referenced.id).title === '새 자료 제목'));

  const boardTask = a.store.addTask({ kind: 'task', title: '보드 검증', date: '2026-11-25', projectId });
  await syncBoth();
  const boardCardBefore = b.store.getTask(boardTask.id);
  a.store.updateTask(boardTask.id, { status: '진행 중' }, { expectedRevision: boardTask.revision });
  await syncBoth();
  assert.throws(() => b.store.updateTask(boardTask.id, { status: '취소' },
    { expectedRevision: boardCardBefore.revision }), { code: 'revision_conflict' });
  const activeBoardCard = b.store.getTask(boardTask.id);
  check('공유 보드에서 상태 변경을 받으면 이전 카드로 덮어쓰지 못함',
    activeBoardCard.status === '진행 중' && activeBoardCard.projectId === projectId);
  b.store.updateTask(boardTask.id, { status: '완료' }, { expectedRevision: activeBoardCard.revision });
  await syncBoth();
  const finishedBoardTask = (await A.select('tasks', 'id', boardTask.id))[0];
  check('다른 기기에서 바꾼 할 일 상태가 프로젝트 연결을 유지하면서 동기화됨',
    finishedBoardTask.status === 'DONE' && finishedBoardTask.project_id === projectId &&
    [a, b].every(device => device.store.getTask(boardTask.id)?.status === '완료'));

  const tableProperties = {
    fields: [{ key: 'property:review', label: '검토', type: 'checkbox' }],
    properties: { [`tasks:${boardTask.id}`]: { 'property:review': false } },
  };
  const projectBeforeTable = (await A.select('projects', 'id', projectId))[0];
  const pushProjectSettings = (revision, data) => A.transport().push(ws, randomUUID(), [
    { entity: 'projects', op: 'UPSERT', id: projectId, base_revision: revision, data },
  ]);
  const savedTable = await pushProjectSettings(projectBeforeTable.revision, { table_properties: tableProperties });
  assert.equal(savedTable.status, 'ACCEPTED');
  const updatedProject = await pushProjectSettings(savedTable.results[0].revision, { name: '표 설정 유지 검증' });
  assert.equal(updatedProject.status, 'ACCEPTED');
  await assert.rejects(() => pushProjectSettings(updatedProject.results[0].revision, { table_properties: [] }));
  const invalidTablePayloads = [
    { ...tableProperties, fields: [...tableProperties.fields, ...tableProperties.fields] },
    { ...tableProperties, properties: { [`tasks:${boardTask.id}`]: { 'property:review': 'false' } } },
    { ...tableProperties, properties: { [`tasks:${boardTask.id}`]: { 'property:unknown': false } } },
  ];
  for (const invalid of invalidTablePayloads) {
    await assert.rejects(() => pushProjectSettings(updatedProject.results[0].revision, { table_properties: invalid }));
  }
  check('잘못된 공유 표 속성이 기존 프로젝트 리비전을 바꾸지 않음',
    Number((await A.select('projects', 'id', projectId))[0].revision) === Number(updatedProject.results[0].revision));
  await syncBoth();
  const synchronizedProject = await engine.getLocal(b.dev.db, ws, 'projects', projectId);
  check('공유 프로젝트 속성 정의와 체크 해제 값이 다른 클라이언트에 전달됨',
    synchronizedProject?.data.name === '표 설정 유지 검증' &&
    synchronizedProject.data.table_properties?.fields?.[0]?.key === 'property:review' &&
    synchronizedProject.data.table_properties?.properties?.[`tasks:${boardTask.id}`]?.['property:review'] === false);

  // 13. 공간의 내 역할·멤버 수: 관리자가 B를 보기 전용으로 바꾸면 B 기기에서도 저장이 막힘
  const wsB = () => b.store.getWorkspaces().find(w => w.serverId === ws);
  const before = [wsB().role, wsB().members];
  await A.rpc('change_member_role', { p_workspace_id: ws, p_account_id: idB, p_role: 'VIEWER' });
  await syncBoth();
  const blockedSave = (() => { try { b.store.addMemo({ title: '보기 전용이라 못 씀' }); return 'saved'; } catch (e) { return e.code; } })();
  assert.throws(() => b.store.updateTask(boardTask.id, { status: '취소' },
    { expectedRevision: b.store.getTask(boardTask.id).revision }), { code: 'read_only' });
  check('보기 전용이 된 기기는 공유 보드 상태를 바꿀 수 없음', b.store.getTask(boardTask.id).status === '완료');
  check('멤버 수와 내 역할이 기기에 맞춰지고, 보기 전용이 되면 기기에서 저장이 막힘', same(before, ['멤버', 2]) && wsB().role === '보기 전용' && blockedSave === 'read_only',
    JSON.stringify([before, wsB().role, blockedSave]));
  await A.rpc('change_member_role', { p_workspace_id: ws, p_account_id: idB, p_role: 'EDITOR' });
  await syncBoth();

  check('마지막에 양쪽 보낼 목록이 비고 상태가 같음', a.store.outboxCount() === 0 && b.store.outboxCount() === 0 && same(view(a.store), view(b.store)) && wsB().role === '멤버');

  // 11. 같은 기기에서 계정이 바뀜: A가 못 보낸 수정이 B 이름으로 올라가지 않음 (A의 기기 DB를 B가 이어서 씀)
  await engine.saveLocal({ db: a.dev.db, transport: A.transport(), workspaceId: ws, myAccountId: idA }, [{ kind: 'update', entity: 'notes', id: memo.id, data: { body: 'A가 못 보낸 수정' } }]);
  const pendingOfA = (await engine.getSyncStatus(a.dev.db, ws)).pending;
  const nextStore = createLocalStore({ db: openDatabaseSync(':memory:'), newId: randomUUID });
  nextStore.bindAccount(idB);
  nextStore.upsertServerWorkspace({ id: ws, name: '저장소 왕복 검증', description: '새 기기 저장소', role: 'EDITOR', members: 2 });
  nextStore.switchWorkspace(ws);
  const nextBridge = createBridge({ store: nextStore, engine, db: a.dev.db, transport: B.transport(), accountId: idB, favorites: b.favorites });
  const nextRun = Object.values(await nextBridge.syncAll())[0];
  const afterSwitch = (await A.select('notes', 'id', memo.id))[0];
  check('계정이 바뀌면 앞 계정이 못 보낸 수정을 버리고, 새 계정은 서버 값으로 다시 받음', pendingOfA === 1 && nextRun.status === 'OK' && nextRun.flush.sent === 0
    && afterSwitch.body === '동기화 중에 고친 본문' && (await engine.getSyncAccount(a.dev.db)) === idB
    && nextStore.getMemo(memo.id)?.body === '동기화 중에 고친 본문' && same(view(nextStore), view(b.store)), JSON.stringify([pendingOfA, nextRun.status, nextRun.flush, afterSwitch.body]));
  const wrongStore = createLocalStore({ db: openDatabaseSync(':memory:'), newId: randomUUID });
  wrongStore.bindAccount(idA);
  const refused = await createBridge({ store: wrongStore, engine, db: a.dev.db, transport: B.transport(), accountId: idB }).syncAll().then(() => 'ran', e => e.code);
  check('기기 저장소가 다른 계정 것이면 동기화하지 않음 (account_mismatch)', refused === 'account_mismatch' && (await engine.getSyncAccount(a.dev.db)) === idB, String(refused));
} catch (error) {
  fail++;
  console.log(' FAIL  예외:', error?.stack ?? error);
} finally {
  await A.rpc('delete_workspace', { p_workspace_id: ws }).catch(() => undefined);
  a.dev.close(); b.dev.close();
  await A.close(); await B.close(); await admin.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n결과: ${pass}개 통과 / ${fail}개 실패`);
process.exit(fail ? 1 : 0);
