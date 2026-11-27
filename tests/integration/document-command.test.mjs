import test from 'node:test';
import assert from 'node:assert/strict';
import { planDocumentCommand } from '../../frontend/Frontend_UI/src/features/stella/itemCommands.mjs';

function runtime() {
  const memos = [];
  return { memos, store: { addMemo: ({ title }) => { const memo = { id: 'n' + memos.length, title }; memos.push(memo); return memo; } } };
}
const plan = (rt, command, originalRequest) => planDocumentCommand(rt, command, { originalRequest, canWrite: () => true });

test('natural document requests create the titled document once approved', () => {
  for (const [request, command, title] of [
    ['회의록 만들어줘', '문서 만들기: 회의록', '회의록'],
    ['모바일 앱 개발에 대한 문서 만들어줘', '문서 만들기: 모바일 앱 개발', '모바일 앱 개발'],
    ['모바일 앱 개발에 대한 문서 만들어줘', '문서 만들기: 모바일 앱 개발에 대한 문서', '모바일 앱 개발에 대한 문서'],
    ['"주간 보고" 문서 하나 만들어 주세요', '문서 만들기: 주간 보고', '주간 보고'],
    ['회의록이라는 문서 작성해줘', '새 문서 만들기: 회의록', '회의록'],
  ]) {
    const rt = runtime();
    const step = plan(rt, command, request);
    assert.ok(step, request);
    assert.equal(rt.memos.length, 0, 'nothing is created before approval');
    assert.equal(step.approve().params.memoId, 'n0');
    assert.equal(rt.memos[0].title, title);
    assert.throws(() => step.approve(), /이미 처리한/);
  }
});

test('titles not in the request, other actions and typed commands are left to the existing check', () => {
  const rt = runtime();
  assert.equal(plan(rt, '문서 만들기: 회의록', '주간 보고 만들어줘'), null);
  assert.equal(plan(rt, '문서 만들기: 회의록', '회의록 지워줘'), null);
  assert.equal(plan(rt, '문서 만들기: 회의록', '회의록 공유해서 만들어줘'), null);
  assert.equal(plan(rt, '문서 만들기: 회의록', undefined), null);
  assert.equal(plan(rt, '할 일 추가 2026-12-01: 회의록', '회의록 만들어줘'), null);
});

test('a read-only space cannot create the document', () => {
  const rt = runtime();
  const step = planDocumentCommand(rt, '문서 만들기: 회의록', { originalRequest: '회의록 만들어줘', canWrite: () => false });
  assert.throws(() => step.approve(), /권한/);
  assert.equal(rt.memos.length, 0);
});
