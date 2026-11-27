import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, livePending, pendingKey, previewOrder, proposeBlocks } from '../../frontend/Frontend_UI/src/features/stella/aiPending.mjs';

const b = (id, text, type = 'paragraph') => ({ id, type, text, checked: false });
function setup(blocks) {
  let memo = { id: 'm1', title: '회의록', revision: 1 };
  let current = blocks;
  const prefs = new Map();
  const documents = {
    blocksFor: () => current,
    saveContent(id, content, revision) { assert.equal(revision, memo.revision); current = content.blocks; memo = { ...memo, revision: revision + 1 }; return memo; },
  };
  const propose = next => proposeBlocks(documents, memo, current, next, { read: (k, d) => prefs.get(k) ?? d, write: (k, v) => prefs.set(k, v) });
  return { propose, blocks: () => current, revision: () => memo.revision, pending: () => prefs.get(pendingKey('m1')) };
}

test('a checkbox preview uses the original position and id without saving until accepted', () => {
  const original = [b('a', 'Test'), b('z', '')];
  const next = [b('a', 'Test', 'task'), original[1]];
  const s = setup(original);
  s.propose(next);
  assert.strictEqual(s.blocks(), original);
  assert.equal(s.revision(), 1);
  assert.deepEqual(s.pending(), [{ id: 'a', original: original[0], preview: [next[0]] }]);
  assert.deepEqual(decide(s.blocks(), s.pending(), ['a'], true).blocks, next);
  assert.strictEqual(decide(s.blocks(), s.pending(), ['a'], false).blocks, original);
  const changed = [b('a', 'Independent edit'), original[1]];
  assert.deepEqual(livePending(s.pending(), changed), []);
  assert.strictEqual(decide(changed, s.pending(), ['a'], true).blocks, changed);
});

test('added, deleted and moved blocks become waiting proposals', () => {
  const s = setup([b('a', '1'), b('b', '2'), b('c', '3')]);
  s.propose([b('a', '1'), b('c', '3'), b('d', '4')]);   // b 삭제, d 추가
  assert.deepEqual(s.blocks().map(x => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(s.pending(), [{ id: 'd' }, { id: 'b', original: b('b', '2'), deletes: true }]);
  // 삭제 제안: 수용하면 빠지고, 거절하면 그대로
  assert.deepEqual(decide(s.blocks(), s.pending(), ['b'], true).blocks.map(x => x.id), ['a', 'c', 'd']);
  assert.deepEqual(decide(s.blocks(), s.pending(), ['b'], false).blocks.map(x => x.id), ['a', 'b', 'c', 'd']);

  const m = setup([b('a', '1'), b('b', '2'), b('c', '3')]);
  m.propose([b('c', '3'), b('a', '1'), b('b', '2')]);   // c를 맨 앞으로
  assert.deepEqual(m.blocks().map(x => x.id), ['a', 'b', 'c']);
  assert.deepEqual(previewOrder(m.blocks(), m.pending()).map(x => x.id), ['c', 'a', 'b']);
  assert.deepEqual(decide(m.blocks(), m.pending(), ['c'], true).blocks.map(x => x.id), ['c', 'a', 'b']);
  assert.strictEqual(decide(m.blocks(), m.pending(), ['c'], false).blocks, m.blocks());
  assert.throws(() => setup([b('a', '1')]).propose([b('a', '1')]), /바뀌는 내용이 없습니다/);
});
