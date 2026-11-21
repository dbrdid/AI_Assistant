import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalStore } from '../../backend/local/src/index.js';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { readMemoBlocks, splitEditedBlock, writeMemoBlocks } from '../../frontend/Frontend_UI/src/features/memo/utils/memoBlocks.mjs';
import { visibleMemoTree } from '../../frontend/Frontend_UI/src/features/memo/utils/memoTree.mjs';
import { memoMarkdown, readMemoMarkdown } from '../../frontend/Frontend_UI/src/features/memo/utils/memoMarkdown.mjs';
import { appendMemoReference, memoReferenceIds, removeMemoReference } from '../../frontend/Frontend_UI/src/features/memo/utils/memoReferences.mjs';

test('existing note text remains editable after a block reorder, check, and database read', () => {
  const { store, db } = setup();
  const body = '기존 메모\n\n## 회의\n- [ ] 검토\n- 공유';
  const original = store.addMemo({ title: '회의록', body });
  const blocks = readMemoBlocks(original.body);
  assert.equal(writeMemoBlocks(blocks), body);
  const [intro, blank, heading, todo, bullet] = blocks;
  const editedBody = writeMemoBlocks([intro, blank, heading, bullet, { ...todo, checked: true }]);
  store.updateMemo(original.id, { body: editedBody }, { expectedRevision: original.revision });

  const reopened = createLocalStore({ db });
  const saved = reopened.getMemo(original.id);
  assert.equal(saved.body, '기존 메모\n\n## 회의\n- 공유\n- [x] 검토');
  assert.deepEqual(readMemoBlocks(saved.body).at(-1), { type: 'todo', text: '검토', checked: true });
  reopened.trashMemo(original.id);
  assert.equal(reopened.getMemos().some(({ id }) => id === original.id), false);
  assert.equal(reopened.getTrashedMemos().some(({ id }) => id === original.id), true);
  reopened.restoreMemos([original.id]);
  assert.equal(reopened.getMemo(original.id).body, saved.body);
});

test('enter continues a checklist without inheriting its check and paste keeps explicit block types', () => {
  const [checked] = readMemoBlocks('- [x] 검토');
  assert.equal(writeMemoBlocks(splitEditedBlock(checked, '검토\n')), '- [x] 검토\n- [ ] ');
  const [heading] = readMemoBlocks('## 회의');
  assert.equal(writeMemoBlocks(splitEditedBlock(heading, '회의\r\n본문\r\n- 자료')), '## 회의\n본문\n- 자료');
  assert.equal(writeMemoBlocks(splitEditedBlock(checked, '검\n토')), '- [x] 검\n- [ ] 토');
});

test('enter on an empty list block returns to plain text while multiline paste keeps explicit blocks', () => {
  const [todo] = readMemoBlocks('- [ ] ');
  const [bullet] = readMemoBlocks('- ');
  assert.deepEqual(splitEditedBlock(todo, '\n'), [{ type: 'text', text: '' }]);
  assert.deepEqual(splitEditedBlock(bullet, '\r\n'), [{ type: 'text', text: '' }]);
  assert.equal(writeMemoBlocks(splitEditedBlock(todo, '검토\r- 자료\r\n## 다음')), '- [ ] 검토\n- 자료\n## 다음');
});

test('Markdown export keeps the block syntax and uses a portable file name', () => {
  const body = '## 결정\n- [x] 검토\n- 자료';
  assert.deepEqual(memoMarkdown({ title: '회의/요약', body }), {
    name: '회의-요약.md',
    content: `# 회의/요약\n\n${body}`,
  });
  assert.deepEqual(memoMarkdown({ title: '  ', body }), { name: '메모.md', content: body });
  assert.equal(memoMarkdown({ title: 'CON.txt', body }).name, '메모.md');
});

test('Markdown import creates a separate memo and retains exported blocks', () => {
  const { store } = setup();
  const original = store.addMemo({ title: '회의', body: '## 결정\n- [x] 검토' });
  const exported = memoMarkdown(original);
  const imported = store.addMemo(readMemoMarkdown(exported.name, '\uFEFF' + exported.content.replace(/\n/g, '\r\n')));
  assert.notEqual(imported.id, original.id);
  assert.equal(imported.title, original.title);
  assert.equal(imported.body, original.body);
  assert.deepEqual(readMemoMarkdown('메모.markdown', '- [ ] 할 일'), { title: '메모', body: '- [ ] 할 일' });
  assert.throws(() => readMemoMarkdown('메모.txt', '텍스트'), /\.markdown/);
  assert.throws(() => readMemoMarkdown('메모.md', 'a'.repeat(100001)), /길이/);
});

test('an untitled export keeps its opening heading in the body on import', () => {
  const { store } = setup();
  const body = '# 본문 제목\n\n- [x] 확인';
  const original = store.addMemo({ body });
  const exported = memoMarkdown(original);
  const imported = store.addMemo(readMemoMarkdown(exported.name, exported.content.replace(/\n/g, '\r\n')));
  assert.equal(imported.title, '');
  assert.equal(imported.body, body);
  assert.equal(readMemoMarkdown('외부.md', body).title, '본문 제목');
});

test('references use the page ID across renames and survive storage and export', () => {
  const { store } = setup();
  const target = store.addMemo({ title: '자료 [최신]' });
  const body = appendMemoReference('## 회의', target.id, target.title);
  const source = store.addMemo({ title: '결정', body });
  store.updateMemo(target.id, { title: '이름 변경' });
  const saved = store.getMemo(source.id);
  assert.deepEqual([...memoReferenceIds(saved.body)], [target.id]);
  assert.equal(appendMemoReference(saved.body, target.id, '이름 변경'), saved.body);
  assert.deepEqual([...memoReferenceIds(memoMarkdown(saved).content)], [target.id]);
  store.updateMemo(source.id, { body: removeMemoReference(saved.body, target.id) });
  assert.equal(store.getMemo(source.id).body, '## 회의');
  assert.equal(store.getMemo(target.id).title, '이름 변경');
  assert.deepEqual([...memoReferenceIds('[외부](https://example.com)\n[잘못된 참조](memo:123)')], []);
});

test('empty headings and checklist items survive the store’s trimming rules', () => {
  const { store } = setup();
  for (const type of ['heading', 'bullet', 'todo']) {
    const body = writeMemoBlocks([{ type, text: '' }]);
    const [block] = readMemoBlocks(store.addMemo({ body }).body);
    assert.equal(block.type, type);
    assert.equal(block.text, '');
  }
});

test('page tree preserves sibling order while hiding collapsed descendants', () => {
  const { store } = setup();
  const root = store.addMemo({ title: '상위' });
  const first = store.addMemo({ title: '첫째' });
  const second = store.addMemo({ title: '둘째' });
  const nested = store.addMemo({ title: '하위' });
  store.setMemoParent(first.id, root.id);
  store.setMemoParent(second.id, root.id);
  store.setMemoParent(nested.id, first.id);
  const rows = collapsed => visibleMemoTree(store.getMemos(), new Set(collapsed)).map(({ memo, depth }) => [memo.id, depth]);
  assert.deepEqual(rows([]), [[root.id, 0], [first.id, 1], [nested.id, 2], [second.id, 1]]);
  assert.deepEqual(rows([first.id]), [[root.id, 0], [first.id, 1], [second.id, 1]]);
  store.trashMemo(root.id);
  assert.deepEqual(rows([]), [[first.id, 0], [nested.id, 1], [second.id, 0]]);
  store.restoreMemos([root.id]);
  assert.deepEqual(rows([]), [[root.id, 0], [first.id, 1], [nested.id, 2], [second.id, 1]]);
  store.trashMemo(root.id);
  store.deleteMemoForever(root.id);
  assert.deepEqual(rows([]), [[first.id, 0], [nested.id, 1], [second.id, 0]]);
  assert.equal(store.getMemo(first.id).parentMemoId, null);
});
