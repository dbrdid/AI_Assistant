import assert from 'node:assert/strict';
import test from 'node:test';
import { findChatDocuments, rankSearchRows, searchTerms } from '../../frontend/Frontend_UI/src/data/memos/memoSearch.mjs';

test('chat lookup gives the literal title priority and excludes trashed notes', () => {
  const notes = [
    { id: 'short', title: 'Test' },
    { id: 'exact', title: 'Test문서' },
    { id: 'duplicate', title: 'Test 문서' },
    { id: 'trash', title: 'Test문서', deletedAt: 1 },
    { id: 'fallback', title: '', body: '회의록\n본문' },
  ];
  const find = (question) => findChatDocuments(question, notes).map(note => note.id);
  assert.deepEqual(find('Test문서 찾아줘'), ['exact', 'duplicate']);
  assert.deepEqual(find('test문서를 찾아 주세요.'), ['exact', 'duplicate']);
  assert.deepEqual(find('“회의록” 문서 검색해 줘'), ['fallback']);
  assert.deepEqual(find('Test 문서에서 일정 찾아줘'), []);
  assert.deepEqual(find('Test문서 요약해 줘'), []);
});

test('search ranks exact and prefix titles before split-field and body matches', () => {
  const rows = [
    { id: 'body', title: '기록', text: '회의 자료' },
    { id: 'split', title: '자료', text: '다음 회의에 보낼 내용' },
    { id: 'partial', title: '지난 회의', text: '기록' },
    { id: 'all-in-title', title: '자료 · 회의' },
    { id: 'prefix', title: '회의 자료 모음' },
    { id: 'exact', title: '회의 자료'.normalize('NFD') },
  ];
  assert.deepEqual(rankSearchRows(rows, searchTerms(' 회의  자료 ')).map(row => row.id),
    ['exact', 'prefix', 'all-in-title', 'split', 'body']);
  assert.deepEqual(rankSearchRows(rows, searchTerms('   ')), []);
});

test('chat opens literal titles locally before asking for other spellings', () => {
  const english = { id: 'english', title: 'Test문서' };
  const korean = { id: 'korean', title: '테스트문서' };
  const question = '테스트 문서를 열어줘';
  assert.deepEqual(findChatDocuments(question, [english]), []);
  assert.deepEqual(findChatDocuments('Test문서를 열어줘', [english]), [english]);
  assert.deepEqual(findChatDocuments(question, [english, korean]), [korean]);
  assert.deepEqual(findChatDocuments('Test문서를 열어 주세요.', [korean]), []);
  assert.deepEqual(findChatDocuments(question, [{ title: '테스트케이스 문서' }, { ...english, deletedAt: 1 }]), []);
});
