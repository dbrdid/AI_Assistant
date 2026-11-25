import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { createStellaDocumentStore } from '../../backend/local/src/stella-documents.js';
import { createDocumentWorkspace } from '../../frontend/Frontend_UI/src/integration/documentWorkspace.mjs';
import { createAiDocument, markdownBlocks, pendingDocKey } from '../../frontend/Frontend_UI/src/features/stella/aiPending.mjs';

const ids = () => { let n = 0; return () => 'b' + ++n; };

test('AI markdown becomes real heading, checklist, list, table and paragraph blocks', () => {
  const blocks = markdownBlocks('# 회의록\n\n일시: 11월 27일\n참석: 김, 이\n\n## 할 일\n- [ ] 포스터 제출\n- [x] 예산 확인\n- 메모\n1. 첫째\n\n| 이름 | 역할 |\n|---|---|\n| 김 | **발표** |\n| 이 |\n끝', ids());
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'paragraph', 'heading', 'task', 'task', 'bullet', 'bullet', 'table', 'paragraph']);
  assert.equal(blocks[1].text, '일시: 11월 27일\n참석: 김, 이');
  assert.deepEqual([blocks[3].checked, blocks[4].checked], [false, true]);
  assert.deepEqual(blocks[7].rows, [['이름', '역할'], ['김', '발표'], ['이', '']]);
  assert.deepEqual(markdownBlocks('그냥 한 문단', ids()).map(b => [b.type, b.text]), [['paragraph', '그냥 한 문단']]);
});

test('an AI answer becomes a new block document that waits for the user decision', (t) => {
  const { store, db } = setup();
  t.after(() => db.closeSync());
  const content = createStellaDocumentStore({ db, store });
  const prefs = new Map();
  const documents = createDocumentWorkspace({ store, content, read: (k, f) => prefs.get(k) ?? f, write: (k, v) => prefs.set(k, v) });
  const id = createAiDocument({ store, documents }, { title: '주간 회의', text: '## 안건\n- [ ] 예산\n| 항목 | 금액 |\n| 인쇄 | 3만 |' },
    { read: (k, f) => prefs.get(k) ?? f, write: (k, v) => prefs.set(k, v) }, ids());
  const memo = store.getMemo(id);
  assert.equal(memo.title, '주간 회의');
  assert.deepEqual(documents.blocksFor(memo).map(b => b.type), ['heading', 'task', 'table']);
  assert.equal(prefs.get(pendingDocKey(id)), true);
  assert.throws(() => createAiDocument({ store, documents }, { title: 'x', text: '  ' }, { read: () => null, write: () => {} }, ids()), /내용/);
});
