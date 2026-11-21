import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { createDocumentWorkspace } from '../../frontend/Frontend_UI/src/integration/documentWorkspace.mjs';

function fixture() {
  const { store } = setup();
  const preferences = new Map();
  const state = { active: true, closed: false };
  const documents = createDocumentWorkspace({ store, read: (key, fallback) => preferences.get(key) ?? fallback, write: (key, value) => preferences.set(key, value), isActive: () => state.active, isClosed: () => state.closed });
  return { store, documents, preferences, state };
}
test('uses existing hierarchy and stable snapshots without replacing Markdown', () => {
  const t = fixture(), parent = t.store.addMemo({ title: '상위' }), child = t.store.addMemo({ title: '하위', body: '# 제목\n\n- [ ] 할 일' });
  t.store.setMemoParent(child.id, parent.id);
  const rows = t.documents.listDocuments();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(item => item.id === child.id).parentId, parent.id);
  assert.strictEqual(t.documents.listDocuments(), rows);
  t.documents.savePosition(child.id, 100, -42);
  assert.equal(t.documents.listDocuments().find(item => item.id === child.id).x, 100);
  assert.equal(t.store.getMemo(child.id).body, child.body);
});
test('source links survive removal of a manual link and trashed notes are hidden', () => {
  const t = fixture(), target = t.store.addMemo({ title: '원본' }), source = t.store.addMemo({ body: `[원본](memo:${target.id})` });
  t.documents.setLink(source.id, target.id, true);
  assert.equal(t.documents.links().length, 2);
  t.documents.setLink(source.id, target.id, false);
  assert.equal(t.documents.links()[0].kind, 'source');
  t.store.trashMemo(target.id);
  assert.equal(t.documents.links().length, 0);
  assert.throws(() => t.documents.savePosition(target.id, 1, 2));
});
test('invalid positions and anchors cannot be persisted', () => {
  const t = fixture(), a = t.store.addMemo({ title: '검증 문서' }), b = t.store.addMemo({ title: '검증 문서' });
  assert.throws(() => t.documents.savePosition(a.id, NaN, 1));
  assert.throws(() => t.documents.setLink(a.id, b.id, true, { source: { side: 'top', offset: 2 } }));
  assert.equal(t.preferences.size, 0);
});
test('canonical link direction reverses endpoint and bend metadata', () => {
  const t = fixture(), a = t.store.addMemo({ title: '검증 문서' }), b = t.store.addMemo({ title: '검증 문서' });
  t.documents.setLink(b.id, a.id, true, { source: { side: 'top', offset: .2 }, target: { side: 'left', offset: .8 }, via: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  const link = t.documents.links()[0];
  assert.equal(link.source, a.id);
  assert.equal(link.anchors.source.side, 'left');
  assert.deepEqual(link.anchors.via, [{ x: 3, y: 4 }, { x: 1, y: 2 }]);
});
test('stale sessions and closed workspaces cannot read or edit diagram state', () => {
  const t = fixture(), memo = t.store.addMemo({ title: '검증 문서' });
  t.state.closed = true;
  assert.throws(() => t.documents.listDocuments());
  assert.throws(() => t.documents.savePosition(memo.id, 1, 2));
  t.state.closed = false; t.state.active = false;
  assert.throws(() => t.documents.links());
  assert.equal(t.preferences.size, 0);
});
