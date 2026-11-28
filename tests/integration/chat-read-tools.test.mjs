import assert from 'node:assert/strict';
import test from 'node:test';
import { executeChatReadTool, planChatReadTool } from '../../frontend/Frontend_UI/src/integration/chatReadTools.mjs';

const today = '2026-11-28';
const question = '마감일이 다음주인 프로젝트를 알려줘';
const workspaceId = 'personal';
const projects = [
  { id: 'third', title: 'Test3', due: '2026-12-03', updatedAt: 0, status: '진행 전' },
  { id: 'second', title: 'Test2', due: '2026-12-01', updatedAt: 0, status: '진행 전' },
  { id: 'first', title: 'AITest', due: '2026-11-30', updatedAt: 0, status: '진행 전' },
  { id: 'previous', title: '이전', due: '2026-11-29' },
  { id: 'outside', title: '다다음 주', due: '2026-12-07' },
  { id: 'deleted', title: '삭제됨', due: '2026-12-03', deletedAt: 42 },
  { id: 'other-space', title: '다른 공간', due: '2026-12-03', workspaceId: 'other' },
  { id: 'excluded', title: 'AI 제외', due: '2026-12-03' },
];
const services = {
  workspaceId, canRead: () => true, getProjects: () => projects,
  getMemos: () => [
    { id: 'body', title: '회의록', body: '이전 테스트에서 기록한 저장 오류' },
    { id: 'title', title: '이전 테스트 문서', body: '' },
    { id: 'memo-trash', title: '이전 테스트', body: '', deletedAt: 42 },
  ],
  isExcluded: id => id === 'excluded',
};

test('next week projects are queried by due date, in local scope, with original links', () => {
  const plan = planChatReadTool(question, [], today);
  assert.deepEqual(plan.args, { from: '2026-11-30', before: '2026-12-07', label: '다음 주' });
  const result = executeChatReadTool(plan, services);
  assert.match(result.text, /총 3개/u);
  assert.match(result.text, /AITest \(11월 30일, 진행 전\)/u);
  assert.deepEqual(result.sources.map(source => [source.id, source.route]), [['first', 'ProjectDetail'], ['second', 'ProjectDetail'], ['third', 'ProjectDetail']]);
  assert.equal(executeChatReadTool(plan, { ...services, canRead: () => false }), null);
  assert.equal(executeChatReadTool({ name: 'delete_project', args: {} }, services), null);
});

test('the reported typo and an explicit follow-up preserve the same due-date query', () => {
  const base = planChatReadTool(question, [], today);
  assert.deepEqual(planChatReadTool('다음즈 프로젝트를 알려줘', [], today), base);
  assert.deepEqual(planChatReadTool('그 프로젝트들을 다시 보여줘', [{ role: 'user', text: question }], today), base);
  assert.equal(planChatReadTool('다음 주 프로젝트를 삭제해줘', [], today), null);
  assert.equal(planChatReadTool('다음 주 프로젝트 중에서 완료된 것만 알려줘', [], today), null);
});

test('document search uses title and body without changing exact-name open semantics', () => {
  const plan = planChatReadTool('이전 테스트의 문서 검색', [], today);
  assert.deepEqual(plan.args, { terms: ['이전', '테스트'] });
  assert.deepEqual(executeChatReadTool(plan, services).sources.map(source => source.id), ['title', 'body']);
  assert.equal(planChatReadTool('프로젝트 알파 문서를 열어줘', [], today), null);
});
