import assert from 'node:assert/strict';
import test from 'node:test';
import { rankSearchRows, searchTerms } from '../../frontend/Frontend_UI/src/data/memos/memoSearch.mjs';

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
