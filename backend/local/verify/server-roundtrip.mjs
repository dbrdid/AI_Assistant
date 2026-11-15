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
import { openDatabaseSync } from '../tests/expo-sqlite-node.mjs';
import { createLocalStore, createBridge } from '../src/index.js';

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
  const bridge = createBridge({ store, engine, db: dev.db, transport: user.transport(), accountId, favorites });
  return { store, bridge, dev };
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
  check('마지막에 양쪽 보낼 목록이 비고 상태가 같음', a.store.outboxCount() === 0 && b.store.outboxCount() === 0 && same(view(a.store), view(b.store)));
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
