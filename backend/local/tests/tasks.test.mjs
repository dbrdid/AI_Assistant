import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejects, rejectsUnchanged } from './helpers.mjs';

test('addTask fills the editor defaults and returns the task', () => {
  const t = setup();
  const task = t.store.addTask({ title: '팀 회의', date: '2026-11-16', start: '10:00', end: '11:00', place: '3층', project: '앱' });
  assert.deepEqual(task, {
    id: task.id, title: '팀 회의', date: '2026-11-16', start: '10:00', end: '11:00', priority: '보통', status: '진행 전', alarm: '없음',
    assignee: '', place: '3층', project: '앱', desc: '', revision: 1, createdAt: t.clock.t, updatedAt: t.clock.t,
  });
  assert.ok(Object.isFrozen(task));
  assert.deepEqual(t.store.getTask(task.id), task);
  assert.equal(t.store.getTask('missing'), null);
});

test('task fields are validated: required title and date, real calendar dates, 24-hour times', () => {
  const t = setup();
  const ok = { title: '할 일', date: '2026-11-16' };
  rejectsUnchanged(t, () => t.store.addTask({ date: '2026-11-16' }), 'invalid_input', 'title');
  rejectsUnchanged(t, () => t.store.addTask({ ...ok, title: '   ' }), 'invalid_input', 'title');
  rejectsUnchanged(t, () => t.store.addTask({ title: '할 일' }), 'invalid_input', 'date');
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-5', '16/11/2026', '']) rejectsUnchanged(t, () => t.store.addTask({ ...ok, date }), 'invalid_input', 'date');
  for (const start of ['24:00', '9:00', '10:60', '10시']) rejectsUnchanged(t, () => t.store.addTask({ ...ok, start }), 'invalid_input', 'start');
  rejectsUnchanged(t, () => t.store.addTask({ ...ok, kind: 'event' }), 'invalid_input', 'kind');
  rejectsUnchanged(t, () => t.store.addTask({ ...ok, priority: '' }), 'invalid_input', 'priority');
  rejectsUnchanged(t, () => t.store.addTask({ ...ok, desc: 3 }), 'invalid_input', 'desc');
  assert.equal(t.store.addTask({ ...ok, date: '2028-02-29' }).date, '2028-02-29');
});

test('updateTask writes only real changes; expectedRevision catches a stale editor', () => {
  const t = setup();
  const task = t.store.addTask({ title: '초안', date: '2026-11-16' });
  let calls = 0;
  t.store.subscribeTasks(() => { calls++; });
  t.tick();
  const edited = t.store.updateTask(task.id, { title: '최종', status: '진행 중' });
  assert.deepEqual([edited.title, edited.status, edited.revision, edited.updatedAt], ['최종', '진행 중', 2, t.clock.t]);
  assert.equal(t.store.updateTask(task.id, { title: '최종' }).revision, 2);
  assert.equal(calls, 1);
  rejectsUnchanged(t, () => t.store.updateTask(task.id, { title: 'x' }, { expectedRevision: 1 }), 'revision_conflict');
  rejectsUnchanged(t, () => t.store.updateTask(task.id, { date: '2026-02-30' }), 'invalid_input', 'date');
  rejectsUnchanged(t, () => t.store.updateTask('missing', { title: 'x' }), 'not_found');
});

test('toggleDone switches between 완료 and 진행 전; deleteTask removes the task', () => {
  const t = setup();
  const task = t.store.addTask({ title: 'a', date: '2026-11-16', status: '진행 중' });
  assert.equal(t.store.toggleDone(task.id).status, '완료');
  assert.equal(t.store.toggleDone(task.id).status, '진행 전');
  assert.equal(t.store.deleteTask(task.id), true);
  assert.equal(t.store.getTask(task.id), null);
  rejects(() => t.store.deleteTask(task.id), 'not_found');
  rejects(() => t.store.toggleDone(task.id), 'not_found');
});

test('tasks are listed by date, untimed first, then by start time', () => {
  const t = setup();
  t.store.addTask({ title: 'c', date: '2026-11-17', start: '09:00' });
  t.store.addTask({ title: 'b', date: '2026-11-16', start: '14:00' });
  t.store.addTask({ title: 'a', date: '2026-11-16' });
  t.store.addTask({ title: 'b0', date: '2026-11-16', start: '08:30' });
  assert.deepEqual(t.store.getTasks().map(x => x.title), ['a', 'b0', 'b', 'c']);
});

test('findOverlap: same start or overlapping ranges clash; touching ranges, untimed and done items do not', () => {
  const t = setup();
  const meeting = t.store.addTask({ title: '회의', date: '2026-11-16', start: '10:00', end: '11:00' });
  const call = t.store.addTask({ title: '통화', date: '2026-11-16', start: '15:00' });
  t.store.addTask({ title: '종일', date: '2026-11-16' });
  t.store.addTask({ title: '끝남', date: '2026-11-16', start: '13:00', end: '14:00', status: '완료' });
  const at = (start, end = '') => t.store.findOverlap({ date: '2026-11-16', start, end })?.title ?? null;
  assert.equal(at('10:30'), '회의');
  assert.equal(at('09:30', '10:15'), '회의');
  assert.equal(at('10:00'), '회의');
  assert.equal(at('11:00', '12:00'), null);
  assert.equal(at('15:00'), '통화');
  assert.equal(at('13:30'), null, 'done items do not clash');
  assert.equal(at(''), null, 'untimed items do not clash');
  assert.equal(t.store.findOverlap({ date: '2026-11-17', start: '10:30' }), null);
  assert.equal(t.store.findOverlap({ date: '2026-11-16', start: '10:30' }, meeting.id), null, 'the edited task itself is excluded');
  assert.equal(t.store.findOverlap({ date: '2026-11-16', start: '15:00' }, undefined).id, call.id);
  rejects(() => t.store.findOverlap({ date: '2026-02-30', start: '10:00' }), 'invalid_input', 'date');
});
