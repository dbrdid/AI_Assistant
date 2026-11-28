import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { parseTaskAction, taskActionFromPlan } from '../../frontend/Frontend_UI/src/features/ai/taskChatIntent.mjs';
import { planChatReadTool, executeChatReadTool } from '../../frontend/Frontend_UI/src/integration/chatReadTools.mjs';
import { filterTasks, taskSnapshot, verifyTaskSnapshot } from '../../frontend/Frontend_UI/src/data/tasks/taskOperations.mjs';

const AI_CHAT_STUBS = {
  './errors': 'export class AiError extends Error {}',
  '@supabase/supabase-js': 'export class FunctionsFetchError extends Error {} export class FunctionsHttpError extends Error {} export class FunctionsRelayError extends Error {}',
};
registerHooks({
  resolve: (specifier, context, next) => (AI_CHAT_STUBS[specifier] && context.parentURL?.endsWith('/ai-chat.ts')
    ? { url: 'data:text/javascript,' + encodeURIComponent(AI_CHAT_STUBS[specifier]), shortCircuit: true }
    : next(specifier, context)),
});
const { askAssistant } = await import('../../frontend/Frontend_UI/src/lib/stella/ai-chat.ts');

const today = '2026-11-28';

test('typed and natural requests keep the requested kind, date, title and explicit status', () => {
  assert.deepEqual(parseTaskAction('내일 할 일로 발표 자료를 추가해줘', today),
    { action: 'create', kind: 'task', fields: { kind: 'task', date: '2026-11-29', title: '발표 자료' } });
  assert.deepEqual(parseTaskAction('내일 장보기 할 일 추가해줘', today),
    { action: 'create', kind: 'task', fields: { kind: 'task', date: '2026-11-29', title: '장보기' } });
  assert.deepEqual(parseTaskAction('내일 3시에 회의 일정 추가해줘', today),
    { action: 'create', kind: 'event', fields: { kind: 'event', date: '2026-11-29', start: '15:00', title: '회의' } });
  assert.deepEqual(parseTaskAction('다음주 월요일 오전 10시에 팀 회의 일정 잡아줘', today),
    { action: 'create', kind: 'event', fields: { kind: 'event', date: '2026-11-30', start: '10:00', title: '팀 회의' } });
  assert.deepEqual(parseTaskAction('다음주 월요일까지 보고서 제출 할 일 추가해줘', today),
    { action: 'create', kind: 'task', fields: { kind: 'task', date: '2026-11-30', title: '보고서 제출' } });
  assert.deepEqual(parseTaskAction('12월 5일 오전 9시 30분 치과 일정 등록해줘', today),
    { action: 'create', kind: 'event', fields: { kind: 'event', date: '2026-12-05', start: '09:30', title: '치과' } });
  assert.deepEqual(parseTaskAction('장보기 완료', today),
    { action: 'change', kind: null, title: '장보기', fields: { status: '완료' } });
  assert.deepEqual(parseTaskAction('장보기 완료 취소', today),
    { action: 'change', kind: null, title: '장보기', fields: { status: '진행 전' } });
  assert.deepEqual(parseTaskAction('일정 추가 2026-12-02 15:00: 낭독회', today),
    { action: 'create', kind: 'event', fields: { kind: 'event', date: '2026-12-02', start: '15:00', title: '낭독회' } });
  assert.deepEqual(parseTaskAction('발표 자료 할 일을 완료 취소해줘', today),
    { action: 'change', kind: 'task', title: '발표 자료', fields: { status: '진행 전' } });
  assert.ok(parseTaskAction('일정 추가 2026-02-30: 낭독회', today).error);
  assert.ok(parseTaskAction('일정 추가 2026-12-02 25:00: 낭독회', today).error);
  assert.equal(parseTaskAction('발표 자료 할 일을 삭제해줘', today), null);
  assert.equal(parseTaskAction('장보기 완료했어?', today), null);
  assert.equal(parseTaskAction('내일 할 일 뭐 있어?', today), null);
  assert.equal(parseTaskAction('웹 리뉴얼 프로젝트 완료로 변경해줘', today), null);
});

test('LLM query/plan action intent falls back to an approval taskAction without calling query/answer', async () => {
  assert.deepEqual(taskActionFromPlan({ op: 'create', kind: 'event', title: '치과 예약', date: '2026-11-30', start: '15:00' }, today),
    { action: 'create', kind: 'event', fields: { kind: 'event', title: '치과 예약', date: '2026-11-30', start: '15:00' } });
  const paths = [];
  const client = {
    functions: {
      invoke: async (path) => {
        paths.push(path);
        return {
          data: {
            ok: true,
            request_id: 'r1',
            draft: {
              intent: 'action', reply: null, keywords: [], title_candidates: [], types: [],
              date_from: null, date_to: null, status: 'any', people: [], project: null, sort: 'relevance', limit: 8,
              action: { op: 'create', kind: 'task', title: '우유 사기', date: '2026-11-29', start: null },
            },
          },
          error: null,
        };
      },
    },
  };
  const reply = await askAssistant(client, {
    question: '내일 장 볼 때 우유 사야 해',
    today,
    newId: () => '00000000-0000-4000-8000-000000000001',
    findRecords: () => [],
  });
  assert.equal(reply.kind, 'action');
  assert.deepEqual(reply.taskAction, { action: 'create', kind: 'task', fields: { kind: 'task', title: '우유 사기', date: '2026-11-29' } });
  assert.deepEqual(paths, ['ai-gateway/query/plan']);
});

test('list and detail lookups use current scope, explicit kind and overlapping event dates', () => {
  const records = [
    { id: 'carry', kind: 'event', title: '전시', date: '2026-11-29', endDate: '2026-11-30', status: '진행 중' },
    { id: 'event', kind: 'event', title: '발표', date: '2026-12-02', status: '진행 전' },
    { id: 'outside', kind: 'event', title: '다음 전시', date: '2026-12-07', status: '진행 전' },
    { id: 'excluded', kind: 'event', title: '제외', date: '2026-12-02', status: '진행 전' },
    { id: 'other', kind: 'event', title: '타 공간', workspaceId: 'other', date: '2026-12-02', status: '진행 전' },
    { id: 'task', kind: 'task', title: '발표', date: '2026-12-02', status: '진행 전' },
  ];
  const services = { workspaceId: 'here', canRead: () => true, queryTasks: filters => filterTasks(records, filters), isExcluded: id => id === 'excluded' };
  const ask = question => executeChatReadTool(planChatReadTool(question, [], today), services);
  assert.deepEqual(ask('다음 주 일정 보여줘').sources.map(source => source.id), ['carry', 'event']);
  assert.deepEqual(ask('발표 할 일 열어줘').sources.map(source => [source.id, source.route]), [['task', 'TaskEdit']]);
  assert.deepEqual(ask('내일 미완료 할 일 보여줘').sources, []);
});

test('task creation uses the supplied ID and approvals detect intervening writes before saving', t => {
  const { store, db } = setup();
  t.after(() => db.closeSync());
  const id = 'chat-approved-task';
  const task = store.addTask({ kind: 'task', date: today, title: '발표 자료' }, { creationId: id });
  assert.equal(task.id, id);
  const before = taskSnapshot(task);
  store.updateTask(id, { status: '진행 중' });
  assert.throws(() => verifyTaskSnapshot(store.getTask(id), before), { code: 'revision_conflict' });
  assert.throws(() => store.updateTask(id, { status: '완료' }, { expectedRevision: before.revision }), { code: 'revision_conflict' });
  assert.equal(store.getTask(id).status, '진행 중');
});
