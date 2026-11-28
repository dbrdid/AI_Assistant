import assert from 'node:assert/strict';
import test from 'node:test';
import { documentSubtitle, duplicateTitleSet, filterDockEntities, formatShortUpdatedAt } from '../../frontend/Frontend_UI/src/features/stella/model.mjs';

test('duplicateTitleSet flags only titles that appear more than once and documentSubtitle distinguishes them', () => {
  const now = new Date(2026, 10, 28, 19, 45).getTime();
  const docs = [
    { id: '1', title: 'ReviewUiS22', body: '첫 번째 메모 본문', updatedAt: new Date(2026, 10, 28, 18, 48).getTime() },
    { id: '2', title: 'ReviewUiS22', body: '', updatedAt: new Date(2026, 10, 27, 9, 5).getTime() },
    { id: '3', title: '발표', body: '단독 문서', updatedAt: now },
  ];
  const duplicates = duplicateTitleSet(docs, d => d.title);
  assert.equal(duplicates.has('ReviewUiS22'), true);
  assert.equal(duplicates.has('발표'), false);
  assert.equal(formatShortUpdatedAt(docs[0].updatedAt, now), '18:48');
  assert.equal(formatShortUpdatedAt(docs[1].updatedAt, now), '11월 27일 09:05');
  assert.equal(documentSubtitle(docs[0], now), '18:48 · 첫 번째 메모 본문');
  assert.equal(documentSubtitle(docs[1], now), '11월 27일 09:05');
});

test('filterDockEntities searches tasks, events, projects, and files when query is present and honors titleOnly', () => {
  const tasks = [
    { id: 't1', kind: 'task', title: '발표 원고 점검', date: '2026-12-01', place: '회의실A', workspaceId: 'w1' },
    { id: 'e1', kind: 'event', title: '팀 미팅', date: '2026-12-02', start: '14:00', place: '강당', workspaceId: 'w2' },
    { id: 't2', kind: 'task', title: '삭제된 항목', date: '2026-12-01', deletedAt: 123, workspaceId: 'w1' },
  ];
  const projects = [
    { id: 'p1', title: '발표 준비', due: '2026-12-03', status: '진행 중', desc: '최종 리허설' },
  ];
  const files = [
    { id: 'f1', name: '발표_슬라이드.pdf', storage: 'local' },
  ];
  const spaceNames = { w1: '개인 공간', w2: 'team2 발표준비' };

  assert.deepEqual(filterDockEntities({ query: '   ', tasks, projects, files, spaceNames }), { tasks: [], projects: [], files: [] });

  const broad = filterDockEntities({ query: '발표', tasks, projects, files, spaceNames });
  assert.deepEqual(broad.tasks.map(t => t.id), ['t1']);
  assert.deepEqual(broad.projects.map(p => p.id), ['p1']);
  assert.deepEqual(broad.files.map(f => f.id), ['f1']);

  const byPlace = filterDockEntities({ query: '강당', titleOnly: false, tasks, projects, files, spaceNames });
  assert.deepEqual(byPlace.tasks.map(t => [t.id, t.type]), [['e1', 'event']]);
  assert.match(byPlace.tasks[0].meta, /team2 발표준비/);

  const titleOnly = filterDockEntities({ query: '강당', titleOnly: true, tasks, projects, files, spaceNames });
  assert.equal(titleOnly.tasks.length, 0);
});
