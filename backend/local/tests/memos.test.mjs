import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, rejects, rejectsUnchanged } from './helpers.mjs';

const STROKES = [{ p: [[1, 2], [3, 4]], w: 2 }];

test('addMemo stores every field and returns a frozen memo that getMemo and getMemos agree on', () => {
  const t = setup();
  const task = t.store.addTask({ title: '보고서 제출', date: '2026-11-16' });
  const memo = t.store.addMemo({ title: '회의', body: '내일 보고서 제출', strokes: STROKES, photos: ['file-1'], taskIds: [task.id], favorite: true });
  assert.deepEqual(memo, {
    id: memo.id, title: '회의', body: '내일 보고서 제출', strokes: STROKES, photos: ['file-1'], taskIds: [task.id], favorite: true,
    revision: 1, createdAt: t.clock.t, updatedAt: t.clock.t, deletedAt: null,
  });
  assert.ok(Object.isFrozen(memo) && Object.isFrozen(memo.strokes) && Object.isFrozen(memo.strokes[0].p));
  assert.deepEqual(t.store.getMemo(memo.id), memo);
  assert.deepEqual(t.store.getMemos(), [memo]);
  assert.equal(t.store.getMemo('missing'), null);
  assert.equal(t.store.getMemo(undefined), null);
});

test('a memo needs a title, body or handwriting; the camera\'s title-only memo is fine', () => {
  const t = setup();
  rejectsUnchanged(t, () => t.store.addMemo({ title: '', body: '' }), 'empty_memo');
  rejectsUnchanged(t, () => t.store.addMemo({ title: '  ', body: '\n', strokes: [] }), 'empty_memo');
  assert.equal(t.store.addMemo({ title: '사진 메모', body: '' }).title, '사진 메모');
  assert.deepEqual(t.store.addMemo({ strokes: STROKES }).strokes, STROKES);
});

test('memo input is checked field by field before anything is written', () => {
  const t = setup();
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'a', kind: 'memo' }), 'invalid_input', 'kind');
  rejectsUnchanged(t, () => t.store.addMemo({ title: 1 }), 'invalid_input', 'title');
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'x'.repeat(501) }), 'invalid_input', 'title');
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'a', strokes: 'line' }), 'invalid_input', 'strokes');
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'a', photos: ['f', 'f'] }), 'invalid_input', 'photos');
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'a', favorite: 1 }), 'invalid_input', 'favorite');
  rejectsUnchanged(t, () => t.store.addMemo({ title: 'a', taskIds: ['no-such-task'] }), 'not_found', 'taskIds');
  rejectsUnchanged(t, () => t.store.addMemo(null), 'invalid_input', 'input');
});

test('content edits raise the revision and updatedAt; photos, links and favorite do not; no change writes nothing', () => {
  const t = setup();
  const memo = t.store.addMemo({ title: '회의', body: '초안' });
  const task = t.store.addTask({ title: '할 일', date: '2026-11-16' });
  let calls = 0;
  t.store.subscribeMemos(() => { calls++; });

  t.tick();
  const edited = t.store.updateMemo(memo.id, { body: '수정본' });
  assert.deepEqual([edited.revision, edited.updatedAt, edited.createdAt], [2, t.clock.t, memo.createdAt]);
  t.tick();
  const linked = t.store.updateMemo(memo.id, { taskIds: [task.id], favorite: true, photos: ['file-1'] });
  assert.deepEqual([linked.revision, linked.updatedAt, linked.taskIds, linked.favorite, linked.photos], [2, edited.updatedAt, [task.id], true, ['file-1']]);
  assert.equal(calls, 2);

  const same = t.store.updateMemo(memo.id, { title: '회의', body: '수정본', strokes: [], taskIds: [task.id] });
  assert.equal(same.revision, 2);
  assert.equal(calls, 2, 'an update that changes nothing notifies nobody');

  rejectsUnchanged(t, () => t.store.updateMemo(memo.id, { body: 'x' }, { expectedRevision: 1 }), 'revision_conflict');
  assert.equal(t.store.updateMemo(memo.id, { body: 'x' }, { expectedRevision: 2 }).revision, 3);
  rejectsUnchanged(t, () => t.store.updateMemo(memo.id, { title: '', body: '' }), 'empty_memo');
  rejectsUnchanged(t, () => t.store.updateMemo('missing', { body: 'x' }), 'not_found');
  rejectsUnchanged(t, () => t.store.updateMemo(memo.id, { id: 'other' }), 'invalid_input', 'id');
});

test('trash, restore and permanent delete', () => {
  const t = setup();
  const [a, b, c] = ['가', '나', '다'].map(title => { t.tick(); return t.store.addMemo({ title }); });
  t.tick();
  assert.equal(t.store.trashMemo(a.id), true);
  assert.deepEqual(t.store.getMemos().map(m => m.title), ['다', '나']);
  assert.deepEqual(t.store.getTrashedMemos().map(m => [m.title, m.deletedAt]), [['가', t.clock.t]]);
  assert.equal(t.store.getMemo(a.id).deletedAt, t.clock.t, 'getMemo still finds a memo in the trash');

  assert.equal(t.store.trashMemos([a.id, b.id, 'missing']), 1, 'skips missing and already trashed memos');
  assert.equal(t.store.restoreMemos([a.id, c.id]), 1);
  assert.deepEqual(t.store.getTrashedMemos().map(m => m.title), ['나']);

  assert.equal(t.store.deleteMemosForever([b.id, 'missing']), 1);
  assert.equal(t.store.deleteMemoForever(c.id), true);
  assert.equal(t.store.getMemo(c.id), null);
  rejects(() => t.store.deleteMemoForever(c.id), 'not_found');
  rejects(() => t.store.trashMemo('missing'), 'not_found');
  rejects(() => t.store.trashMemos('not-a-list'), 'invalid_input', 'ids');
  assert.deepEqual(t.store.getMemos().map(m => m.title), ['가']);
});

test('favorites and photos change without touching the revision; repeating them changes nothing', () => {
  const t = setup();
  const a = t.store.addMemo({ title: 'a' }), b = t.store.addMemo({ title: 'b' });
  assert.equal(t.store.setFavorites([a.id, b.id], true), 2);
  assert.equal(t.store.setFavorites([a.id, b.id], true), 0);
  assert.equal(t.store.setFavorites([a.id], false), 1);
  rejects(() => t.store.setFavorites([a.id], 'yes'), 'invalid_input', 'favorite');

  assert.deepEqual(t.store.attachPhoto(a.id, 'file-1').photos, ['file-1']);
  assert.deepEqual(t.store.attachPhoto(a.id, 'file-2').photos, ['file-1', 'file-2']);
  assert.deepEqual(t.store.attachPhoto(a.id, 'file-1').photos, ['file-1', 'file-2']);
  assert.deepEqual(t.store.detachPhoto(a.id, 'file-1').photos, ['file-2']);
  assert.deepEqual(t.store.detachPhoto(a.id, 'file-9').photos, ['file-2']);
  assert.equal(t.store.getMemo(a.id).revision, 1);
  rejects(() => t.store.attachPhoto('missing', 'file-1'), 'not_found');
  rejects(() => t.store.attachPhoto(a.id, ''), 'invalid_input', 'fileId');
});

test('deleting a task removes it from the memos that linked it', () => {
  const t = setup();
  const x = t.store.addTask({ title: 'x', date: '2026-11-16' }), y = t.store.addTask({ title: 'y', date: '2026-11-16' });
  const memo = t.store.addMemo({ body: '연결', taskIds: [x.id, y.id] });
  let memoCalls = 0;
  t.store.subscribeMemos(() => { memoCalls++; });
  t.store.deleteTask(x.id);
  assert.deepEqual(t.store.getMemo(memo.id).taskIds, [y.id]);
  assert.deepEqual(t.store.getMemos()[0].taskIds, [y.id]);
  assert.equal(memoCalls, 1);
});

test('the memo list is one frozen array until a change, and unchanged memos keep their object', () => {
  const t = setup();
  const a = t.store.addMemo({ title: 'a', strokes: STROKES });
  t.tick();
  t.store.addMemo({ title: 'b' });
  const first = t.store.getMemos();
  assert.equal(t.store.getMemos(), first);
  assert.throws(() => first.push(null), TypeError);
  t.tick();
  t.store.updateMemo(first[0].id, { title: 'b2' });
  const second = t.store.getMemos();
  assert.notEqual(second, first);
  assert.equal(second.find(m => m.id === a.id), first.find(m => m.id === a.id), 'memo a was not re-read');
});
