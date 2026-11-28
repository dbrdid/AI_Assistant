import assert from 'node:assert/strict';
import test from 'node:test';
import { planChatCommand } from '../../frontend/Frontend_UI/src/features/ai/chatCommands.mjs';
import { planProjectBrief } from '../../frontend/Frontend_UI/src/features/ai/chatWorkflows.mjs';
import { executeChatReadTool, planChatReadTool } from '../../frontend/Frontend_UI/src/integration/chatReadTools.mjs';
import { filterProjects } from '../../frontend/Frontend_UI/src/data/projects/projectOperations.mjs';
import { filterTasks } from '../../frontend/Frontend_UI/src/data/tasks/taskOperations.mjs';
import { planProjectCommand } from '../../frontend/Frontend_UI/src/features/stella/projectCommands.mjs';

const today = '2026-11-28';
const memo = { id: 'm1', title: '준비 회의록', revision: 8 };
test('chat routes a named or cited document to the same command with its current revision', () => {
  assert.deepEqual(planChatCommand('“준비 회의록” 문서에서 1번 블록 삭제', { memos: [memo] }), {
    command: '1번 블록 삭제', originalRequest: '1번 블록 삭제', memoId: 'm1', revision: 8,
  });
  assert.equal(planChatCommand('제목 블록 추가: 일정', { memos: [memo], recentSources: [{ type: 'memo', id: 'm1' }] }).memoId, 'm1');
  assert.equal(planChatCommand('“준비 회의록” 문서에서 1번 블록을 체크로 바꿔줘', { memos: [memo] }).command, '1번 블록 종류 변경: 체크');
  assert.match(planChatCommand('“준비 회의록” 문서에서 1번 블록 삭제', { memos: [memo, { ...memo, id: 'm2' }] }).message, /하나 지정/u);
  assert.equal(planChatCommand('무관한 문서를 검색해 줘', { memos: [memo] }), null);
  assert.equal(planChatCommand('새 회의록 문서를 만들어줘', { memos: [] }).command, '문서 만들기: 새 회의록');
});

test('a project brief uses next week and includes only open, connected, AI-eligible tasks', () => {
  const projects = [
    { id: 'p1', title: '팀 발표', due: '2026-12-01' },
    { id: 'p2', title: '이번 주', due: '2026-11-29' },
    { id: 'hidden', title: '제외 프로젝트', due: '2026-12-03' },
  ];
  const open = { id: 't1', title: '원고 정리', date: '2026-12-01', kind: 'task', status: '진행 전', projectId: 'p1', revision: 2 };
  const tasks = [open, { ...open, id: 'closed', title: '완료 항목', status: '완료' },
    { ...open, id: 'event', title: '일정', kind: 'event' }, { ...open, id: 'none', title: '미연결', projectId: null },
    { ...open, id: 'hidden', title: '제외 할 일' }];
  const services = { queryProjects: filters => filterProjects(projects, filters), queryTasks: filters => filterTasks(tasks, filters), isExcluded: id => id === 'hidden' };
  const request = '다음 주에 마감되는 프로젝트를 찾아서 미완료 업무를 정리하고 발표 준비 문서를 만들어줘';
  const draft = planProjectBrief(request, today, services);
  assert.equal(draft.title, '발표 준비');
  assert.match(draft.text, /- \[ \] 원고 정리/u);
  assert.deepEqual(draft.sections.map(section => [section.project.id, section.tasks.map(task => task.id)]), [['p1', ['t1']]]);
  open.revision += 1;
  assert.notDeepEqual(planProjectBrief(request, today, services).sections, draft.sections);
});

test('project relations and file search never return another workspace or excluded records', () => {
  const links = { memos: ['m1', 'secret'], tasks: ['t1'], files: ['f1', 'f2'] };
  const services = {
    workspaceId: 'our', canRead: () => true, isExcluded: id => id === 'secret',
    getMemos: () => [memo, { id: 'secret', title: '제외' }],
    getProjects: () => [{ id: 'p1', title: '발표', links }],
    getTasks: () => [{ id: 't1', kind: 'task', title: '준비', date: '2026-12-03' }],
    getFiles: () => [{ id: 'f1', name: '보고서.pdf', workspaceId: 'our' }, { id: 'f2', name: '보고서.pdf', workspaceId: 'other' }],
  };
  const related = executeChatReadTool(planChatReadTool('발표 프로젝트에 연결된 항목을 보여줘', [], today), services);
  assert.deepEqual(related.sources.map(item => item.id), ['m1', 't1', 'f1']);
  const file = executeChatReadTool(planChatReadTool('보고서 파일을 찾아줘', [], today), services);
  assert.deepEqual(file.sources.map(item => item.id), ['f1']);
});

test('unlink is bound to the reviewed association and does not overwrite an intervening edit', () => {
  let task = { id: 't1', kind: 'task', title: '원고', projectId: 'p1', revision: 1 };
  const tools = {
    getProjects: () => [{ id: 'p1', title: '발표' }], getTasks: () => [task], getTask: () => task, canWrite: () => true,
    setTaskProject: (id, projectId) => { assert.equal(id, task.id); task = { ...task, projectId }; },
  };
  const request = '할 일 프로젝트 연결 해제: 원고 / 발표';
  const stale = planProjectCommand(tools, request, request);
  task = { ...task, revision: 2 };
  assert.throws(() => stale.approve(), /바뀌었어요/u);
  assert.equal(task.projectId, 'p1');
  planProjectCommand(tools, request, request).approve();
  assert.equal(task.projectId, null);
});
