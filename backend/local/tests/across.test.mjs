import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejects, rejectsUnchanged } from './helpers.mjs';

const VIEWER_WS = '11111111-2222-4333-8444-555555555555';

/** 개인 공간 + 팀 공간에 일정·메모가 하나씩 있는 저장소 (현재 공간은 개인) */
function twoSpaces() {
  const t = setup();
  t.personal = t.store.getCurrentWorkspace().id;
  t.mine = t.store.addTask({ title: '개인 일정', date: '2026-11-17', start: '10:00' });
  t.store.addMemo({ title: '개인 메모' });
  t.team = t.store.createWorkspace({ name: '팀 공간' });
  t.store.switchWorkspace(t.team);
  t.theirs = t.store.addTask({ title: '팀 할 일', date: '2026-11-18' });
  t.store.addMemo({ title: '팀 메모' });
  t.store.switchWorkspace(t.personal);
  return t;
}

test('getAllTasks·getAllMemos는 모든 공간의 항목을 workspaceId와 함께 돌려주고, 현재 공간은 그대로 둔다', () => {
  const t = twoSpaces();
  const all = t.store.getAllTasks();
  assert.deepEqual(all.map(x => [x.title, x.workspaceId]), [['개인 일정', t.personal], ['팀 할 일', t.team]]);
  assert.deepEqual(t.store.getAllMemos().map(m => [m.title, m.workspaceId]).sort(), [['개인 메모', t.personal], ['팀 메모', t.team]]);
  assert.equal(t.store.getCurrentWorkspace().id, t.personal);
  assert.deepEqual(t.store.getTasks().map(x => x.title), ['개인 일정'], '현재 공간 목록은 그 공간 것만');
  assert.ok(Object.isFrozen(all) && Object.isFrozen(all[0]));
  assert.equal(t.store.getAllTasks(), all, '바뀌기 전까지 같은 배열 (useSyncExternalStore)');
});

test('inWorkspace는 다른 공간의 항목을 고치고 그 공간의 보낼 목록에 적는다. 현재 공간은 바뀌지 않는다', () => {
  const t = twoSpaces();
  const before = t.store.getAllTasks();
  t.store.inWorkspace(t.team, 'toggleDone', t.theirs.id);
  assert.notEqual(t.store.getAllTasks(), before, '쓰면 합친 목록도 새로 만듦');
  assert.equal(t.store.getAllTasks().find(x => x.id === t.theirs.id).status, '완료');
  t.store.inWorkspace(t.team, 'updateTask', t.theirs.id, { date: '2026-11-19' });
  assert.equal(t.store.getAllTasks().find(x => x.id === t.theirs.id).date, '2026-11-19');
  assert.equal(t.store.getCurrentWorkspace().id, t.personal);

  const out = t.store.peekOutbox(100);
  assert.ok(out.length > 0 && out.every(o => o.workspaceId === t.team), '팀 공간의 변경으로 적힘');

  const memo = t.store.inWorkspace(t.team, 'addMemo', { title: '입력줄에서 팀으로' });
  assert.ok(t.store.getAllMemos().some(m => m.id === memo.id && m.workspaceId === t.team));
  assert.ok(!t.store.getMemos().some(m => m.id === memo.id), '개인 공간 목록에는 없음');

  t.store.inWorkspace(t.team, 'trashMemos', [memo.id]);
  assert.ok(!t.store.getAllMemos().some(m => m.id === memo.id), '휴지통 메모는 합친 목록에서 빠짐');
  t.store.inWorkspace(t.team, 'restoreMemos', [memo.id]);
  assert.ok(t.store.getAllMemos().some(m => m.id === memo.id));

  t.store.inWorkspace(t.personal, 'deleteTask', t.mine.id);
  assert.deepEqual(t.store.getAllTasks().map(x => x.title), ['팀 할 일']);
});

test('inWorkspace는 다른 공간의 id·없는 공간·모르는 동작·보기 전용 공간을 막고, 실패하면 아무것도 바꾸지 않는다', () => {
  const t = twoSpaces();
  rejectsUnchanged(t, () => t.store.inWorkspace(t.personal, 'toggleDone', t.theirs.id), 'not_found');
  rejectsUnchanged(t, () => t.store.inWorkspace('no-such-space', 'toggleDone', t.mine.id), 'not_found');
  rejects(() => t.store.inWorkspace(t.team, 'clearAll'), 'invalid_input', 'name');
  rejects(() => t.store.inWorkspace(t.team, 'toString'), 'invalid_input', 'name');

  const viewer = t.store.upsertServerWorkspace({ id: VIEWER_WS, name: '보기 전용', role: 'VIEWER', members: 3 });
  rejectsUnchanged(t, () => t.store.inWorkspace(viewer, 'addTask', { title: 'x', date: '2026-11-20' }), 'read_only');
  assert.equal(t.store.getCurrentWorkspace().id, t.personal, '실패해도 현재 공간은 그대로');
});
