import test from 'node:test';
import assert from 'node:assert/strict';
import { itemExamples, isItemCommand, planItemCommand, routeItemCommand } from '../../frontend/Frontend_UI/src/features/stella/itemCommands.mjs';

// 메모리 안의 작은 런타임: 할 일과 문서 하나
function fakeRuntime() {
  const tasks = [
    { id: 't1', kind: 'task', title: '포스터 제출', date: '2026-11-27', start: '', priority: '보통', alarm: '없음', status: '진행 전', revision: 1 },
    { id: 'e1', kind: 'event', title: '낭독회', date: '2026-12-02', start: '15:00', priority: '보통', alarm: '없음', status: '진행 전', revision: 1 },
  ];
  let memo = { id: 'm1', title: '회의록', revision: 1, deletedAt: null };
  let blocks = [
    { id: 'b1', type: 'paragraph', text: '준비물 확인', checked: false },
    { id: 'b2', type: 'table', text: '', checked: false, rows: [['이름', '담당'], ['포스터', '']] },
  ];
  const store = {
    getTasks: () => tasks.slice(),
    getTask: id => tasks.find(task => task.id === id),
    updateTask(id, patch) { const task = tasks.find(item => item.id === id); Object.assign(task, patch, { revision: task.revision + 1 }); return { ...task }; },
    deleteTask(id) { tasks.splice(tasks.findIndex(task => task.id === id), 1); },
    getMemo: () => memo,
  };
  const documents = {
    listDocuments: () => [memo],
    blocksFor: () => blocks,
    saveContent(id, content, revision) { assert.equal(revision, memo.revision); blocks = content.blocks; memo = { ...memo, revision: memo.revision + 1 }; },
  };
  return { rt: { store, documents }, tasks, blocks: () => blocks };
}
const plan = (rt, command, originalRequest) => planItemCommand(rt, command, { memoId: 'm1', originalRequest, canWrite: () => true });

test('all examples are item commands', () => {
  for (const example of itemExamples) assert.ok(isItemCommand(example), example);
  assert.equal(planItemCommand({}, '문서 만들기: 회의록', { canWrite: () => true }), null);
});

test('task completion, rename, priority and alarm need the user words and run once', () => {
  const { rt, tasks } = fakeRuntime();
  const done = plan(rt, '할 일 완료: 포스터 제출', '포스터 제출 완료했어');
  done.approve();
  assert.equal(tasks[0].status, '완료');
  assert.throws(() => done.approve(), /이미 처리/);
  plan(rt, '할 일 우선순위 변경: 포스터 제출 / 높음', '포스터 제출 우선순위 높음으로').approve();
  assert.equal(tasks[0].priority, '높음');
  plan(rt, '할 일 알림 변경: 포스터 제출 / 10분 전', '포스터 제출 10분 전에 알려줘').approve();
  assert.equal(tasks[0].alarm, '10분 전');
  // 모델이 지어낸 값, 요청과 다른 동작은 거절
  assert.throws(() => plan(rt, '할 일 이름 변경: 포스터 제출 / 최종본', '포스터 제출 이름 바꿔줘'), /요청에 없는 값/);
  assert.throws(() => plan(rt, '할 일 삭제: 포스터 제출', '포스터 제출 완료했어'), /요청한 작업/);
  assert.throws(() => plan(rt, '할 일 완료: 없는 일', '없는 일 완료'), /특정할 수 없습니다/);
});

test('dates may be said in Korean forms; deletion needs a delete word', () => {
  const { rt, tasks } = fakeRuntime();
  plan(rt, '일정 날짜 변경: 낭독회 / 2026-12-03 16:00', '낭독회를 12월 3일 오후 4시로 옮겨줘').approve();
  assert.equal(tasks[1].date, '2026-12-03');
  assert.equal(tasks[1].start, '16:00');
  assert.throws(() => plan(rt, '일정 날짜 변경: 낭독회 / 2026-12-09', '낭독회 날짜 바꿔줘'), /요청에 없는 날짜/);
  plan(rt, '일정 삭제: 낭독회', '낭독회 일정 지워줘').approve();
  assert.equal(tasks.some(task => task.id === 'e1'), false);
});

test('block type change and table rows act on the reviewed document only', () => {
  const { rt, blocks } = fakeRuntime();
  plan(rt, '1번 블록 종류 변경: 체크', '1번 블록을 체크로 바꿔줘').approve();
  assert.equal(blocks()[0].type, 'task');
  plan(rt, '2번 블록 표 행 추가', '2번 표에 행 추가해줘').approve();
  assert.deepEqual(blocks()[1].rows.at(-1), ['', '']);
  const column = plan(rt, '2번 블록 표 열 추가', '2번 표에 열 추가');
  rt.documents.saveContent('m1', { blocks: blocks() }, rt.store.getMemo().revision);   // 검토 뒤 다른 곳에서 문서가 저장됨
  assert.throws(() => column.approve(), /문서가 바뀌었습니다/);
  assert.throws(() => plan(rt, '1번 블록 표 행 추가', '1번 블록에 행 추가'), /표가 아닙니다/);
});

test('clear block requests become commands without the model', () => {
  assert.deepEqual(routeItemCommand('이 블록을 체크로 변경해줘', { index: 0, type: 'paragraph' }), { command: '1번 블록 종류 변경: 체크' });
  assert.deepEqual(routeItemCommand('행 하나 추가해줘', { index: 1, type: 'table' }), { command: '2번 블록 표 행 추가' });
  assert.deepEqual(routeItemCommand('체크로 바꿔줘', { index: 1, type: 'table' }), {});
  assert.deepEqual(routeItemCommand('요약해줘', { index: 0, type: 'paragraph' }), {});
});
