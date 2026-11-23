import assert from 'node:assert/strict';
import test from 'node:test';
import { searchFilesByName } from '../../frontend/Frontend_UI/src/data/memos/SearchFiles.mjs';

test('matches filenames case-insensitively and across all query terms', () => {
  const files = [
    { id: 'one', name: 'Budget-Meeting.pdf', text: 'private content' },
    { id: 'two', name: 'Budget.pdf' },
  ];

  assert.deepEqual(searchFilesByName(files, ['budget', 'MEETING']).map(file => file.id), ['one']);
});

test('does not find a file by its extracted body text', () => {
  const files = [{ id: 'one', name: 'Meeting.pdf', text: 'annual budget' }];

  assert.deepEqual(searchFilesByName(files, ['budget']), []);
});
