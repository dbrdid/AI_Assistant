import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, pendingKey, proposeBlocks } from '../../frontend/Frontend_UI/src/features/stella/aiPending.mjs';

const b = (id, text, type = 'paragraph') => ({ id, type, text, checked: false });
function setup(blocks) {
  let memo = { id: 'm1', title: '회의록', revision: 1 };
  let current = blocks;
  const prefs = new Map();
  const documents = {
    blocksFor: () => current,
    saveContent(id, content, revision) { assert.equal(revision, memo.revision); current = content.blocks; memo = { ...memo, revision: revision + 1 }; return memo; },
  };
  let n = 0;
  const propose = next => proposeBlocks(documents, memo, current, next, { read: (k, d) => prefs.get(k) ?? d, write: (k, v) => prefs.set(k, v) }, () => 'new' + ++n);
  return { propose, blocks: () => current, pending: () => prefs.get(pendingKey('m1')) };
}

test('a changed block waits under the original and replaces it only on accept', () => {
  const s = setup([b('a', 'Test'), b('z', '')]);
  s.propose([b('a', 'Test', 'task'), b('z', '')]);
  assert.deepEqual(s.blocks().map(x => x.id), ['a', 'new1', 'z']);
  assert.equal(s.blocks()[1].type, 'task');
  assert.deepEqual(s.pending(), [{ id: 'new1', replaces: 'a' }]);
  const accepted = decide(s.blocks(), s.pending(), ['new1'], true);
  assert.deepEqual(accepted.blocks.map(x => x.id), ['new1', 'z']);
  const rejected = decide(s.blocks(), s.pending(), ['new1'], false);
  assert.deepEqual(rejected.blocks.map(x => x.id), ['a', 'z']);
});

test('added, deleted and moved blocks become waiting proposals', () => {
  const s = setup([b('a', '1'), b('b', '2'), b('c', '3')]);
  s.propose([b('a', '1'), b('c', '3'), b('d', '4')]);   // b 삭제, d 추가
  assert.deepEqual(s.blocks().map(x => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(s.pending(), [{ id: 'd' }, { id: 'b', deletes: true }]);
  // 삭제 제안: 수용하면 빠지고, 거절하면 그대로
  assert.deepEqual(decide(s.blocks(), s.pending(), ['b'], true).blocks.map(x => x.id), ['a', 'c', 'd']);
  assert.deepEqual(decide(s.blocks(), s.pending(), ['b'], false).blocks.map(x => x.id), ['a', 'b', 'c', 'd']);

  const m = setup([b('a', '1'), b('b', '2'), b('c', '3')]);
  m.propose([b('c', '3'), b('a', '1'), b('b', '2')]);   // c를 맨 앞으로
  assert.deepEqual(m.blocks().map(x => x.id), ['new1', 'a', 'b', 'c']);
  assert.deepEqual(m.pending(), [{ id: 'new1', replaces: 'c' }]);
  assert.throws(() => setup([b('a', '1')]).propose([b('a', '1')]), /바뀌는 내용이 없습니다/);
});
