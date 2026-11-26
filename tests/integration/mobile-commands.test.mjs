import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { createStellaDocumentStore } from '../../backend/local/src/stella-documents.js';
import { createDocumentWorkspace } from '../../frontend/Frontend_UI/src/integration/documentWorkspace.mjs';
import { planCommand, screens, splitRequest } from '../../frontend/Frontend_UI/src/features/stella/appCommands.mjs';
import { originalEvidence, locateFile, statedTimes, verifiedStart, unstatedTimeWarning } from '../../frontend/Frontend_UI/src/integration/recordEvidence.mjs';
import { ROUTES } from '../../frontend/Frontend_UI/src/navigation/routes.js';

function fixture(t) {
  const { store, db } = setup();
  t.after(() => db.closeSync());
  const content = createStellaDocumentStore({ db, store });
  const prefs = new Map();
  const documents = createDocumentWorkspace({ store, content, read: (key, fallback) => prefs.get(key) ?? fallback, write: (key, value) => prefs.set(key, value) });
  const rt = { store, documents, closedSpaces: new Set() };
  const memo = store.addMemo({ title: '합성 문서', body: '원본' });
  let id = 0;
  const plan = input => planCommand(rt, input, memo.id, () => 'block-' + ++id);
  return { rt, memo, plan, run: input => plan(input).approve(rt), blocks: () => documents.blocksFor(store.getMemo(memo.id)) };
}
test('approval controls real SQLite block text, types, order, table cells, and repeated execution', t => {
  const { rt, plan, run, blocks, memo } = fixture(t);
  const proposal = plan('제목 블록 추가: 처음');
  assert.equal(blocks().length, 1);
  proposal.approve(rt);
  assert.throws(() => proposal.approve(rt), /이미/);
  run('2 번 블록을 1 번으로 이동');
  run('1번 블록을 두번째로 수정');
  run('1번 블록 복제');
  run('1번 블록 삭제');
  run('표 블록 추가');
  run('3번 블록의 2행 1열 수정: 변경');
  run('체크 블록 추가: 검증');
  run('4번 블록 체크');
  run('문서 제목 변경: 합성 결과');
  run('즐겨찾기에 추가');
  run('현재 버전 저장');
  const saved = rt.store.getMemo(memo.id);
  assert.equal(saved.favorite, true);
  assert.equal(saved.title, '합성 결과');
  assert.equal(blocks()[0].type, 'heading');
  assert.equal(blocks()[0].text, '두번째');
  assert.equal(blocks()[1].text, '원본');
  assert.equal(blocks()[2].rows[1][0], '변경');
  assert.equal(blocks()[3].checked, true);
  assert.equal(rt.documents.listVersions(memo.id).length, 1);
});
test('account, access, stale document and invalid targets cannot change content', t => {
  const { rt, memo, plan, run, blocks } = fixture(t);
  const stale = plan('1번 블록 삭제');
  run('문단 블록 추가: 보존');
  assert.throws(() => stale.approve(rt), /바뀌/);
  assert.throws(() => plan('1번 블록을 9번으로 이동'), /없습니다/);
  assert.throws(() => plan('1번 블록의 1행 1열 수정: 값'), /없습니다/);
  assert.throws(() => plan('기기 전체 삭제'), /지원/);
  assert.throws(() => plan('1번 블록 삭제').approve({ ...rt }), /계정/);
  const lost = plan('1번 블록 삭제');
  rt.closedSpaces.add(rt.store.getCurrentWorkspace().id);
  assert.throws(() => lost.approve(rt), /공간/);
  assert.deepEqual(blocks().map(b => b.text), ['원본', '보존']);
  assert.equal(rt.store.getMemo(memo.id).title, '합성 문서');
});
test('document and timed event appear only after approval, and navigation is allowlisted', t => {
  const { rt, plan, run } = fixture(t);
  const create = plan('문서 만들기: 새 파일');
  assert.equal(rt.store.getMemos().length, 1);
  const opened = create.approve(rt);
  assert.equal(opened.route, ROUTES.MemoEdit);
  assert.equal(rt.store.getMemo(opened.params.memoId).title, '새 파일');
  const event = plan('일정 추가 2026-12-02 15:00: 낭독회');
  assert.equal(rt.store.getTasks().length, 0);
  const { params } = event.approve(rt);
  assert.equal(rt.store.getTask(params.taskId).start, '15:00');
  assert.equal(rt.store.getTask(params.taskId).kind, 'event');
  for (const [name, route] of Object.entries(screens)) assert.equal(run(name + ' 열어줘').route, route);
});
test('file location requires an actual local filename hit and quotations retain original spelling', () => {
  const history = [{ role: 'user', text: '단풍 회의에 대해 찾아줘.' }];
  const request = '그 회의 자료 파일은 어디 있어?';
  const terms = ['단풍 회의', '자료', '파일'];
  const files = [{ id: 'file', name: '단풍 회의 최종.pdf' }];
  assert.equal(locateFile(request, history, terms, files).sources[0].id, 'file');
  assert.equal(locateFile(request, history, terms, []).sources.length, 0);
  assert.equal(locateFile('안녕하세요', [], [], files), null);
  assert.equal(originalEvidence('작은 상자 12개', '상자 12 개'), '상자 12개');
  assert.equal(originalEvidence('작은 상자 12개', '상자 13 개'), '');
});

test('only a unique live target can be linked or selected as the parent', t => {
  const { rt, memo, run, plan } = fixture(t);
  const other = rt.store.addMemo({ title: '회의록' });
  run('상위 문서 변경: 회의록');
  assert.equal(rt.store.getMemo(memo.id).parentMemoId, other.id);
  run('최상위로 이동');
  assert.equal(rt.store.getMemo(memo.id).parentMemoId, null);
  run('문서 연결: 회의록');
  assert.equal(rt.documents.links().length, 1);
  run('문서 연결 해제: 회의록');
  assert.equal(rt.documents.links().length, 0);
  const stale = plan('문서 연결: 회의록');
  rt.store.updateMemo(other.id, { title: '다른 이름' });
  assert.throws(() => stale.approve(rt), /바뀌/);
  rt.store.addMemo({ title: '다른 이름' });
  assert.throws(() => plan('상위 문서 변경: 다른 이름'), /특정/);
});

test('English 12-hour times count as stated times, once each', () => {
  assert.deepEqual(statedTimes('Budget review tomorrow at 3pm'), [['15:00']]);
  assert.deepEqual(statedTimes('standup 10:30am, lunch 12 p.m.'), [['10:30'], ['12:00']]);
  assert.deepEqual(statedTimes('step 3 meeting'), []);
  assert.deepEqual(statedTimes('오후 3시 회의'), [['15:00']]);
  assert.equal(verifiedStart('22:30', 'standup at 10:30am'), '10:30');
  assert.equal(unstatedTimeWarning({ start: '15:00', end: '' }, 'meeting with Kim at 3pm'), '');
});

test('a multi-step request verifies each model step against its own part of the request', t => {
  const { rt, memo } = fixture(t);
  const request = '2026-11-28 보고서 할 일 추가하고 2026-11-29 15:00 회의 일정 추가해줘';
  const parts = splitRequest(request);
  assert.deepEqual(parts, ['2026-11-28 보고서 할 일 추가해줘', '2026-11-29 15:00 회의 일정 추가해줘']);
  // 전체 요청으로는 복합 요청이라 막히고, 자기 조각으로는 통과한다 (화면의 planStep과 같은 순서)
  assert.throws(() => planCommand(rt, '할 일 추가 2026-11-28: 보고서', memo.id, () => 'x', request), /복합 요청/);
  const why = [];
  const pick = command => { for (const part of parts) { try { return planCommand(rt, command, memo.id, () => 'x', part); } catch (e) { why.push(part + ' → ' + e.message); } } return null; };
  assert.ok(pick('할 일 추가 2026-11-28: 보고서'), why.join('\n'));
  assert.ok(pick('일정 추가 2026-11-29 15:00: 회의'), why.join('\n'));
  assert.equal(pick('일정 추가 2026-11-30 15:00: 회의'), null, '요청에 없는 날짜는 어느 조각으로도 통과 못 함');
});
