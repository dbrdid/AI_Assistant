import test from 'node:test';
import assert from 'node:assert/strict';
import { dueOptions, nextField, parseProjectRequest, parseProjectStatusRequest, projectDraftValues, summary } from '../../frontend/Frontend_UI/src/features/ai/projectTemplate.mjs';
import { filterProjects, projectSnapshot, verifyProjectSnapshot } from '../../frontend/Frontend_UI/src/data/projects/projectOperations.mjs';

test('project requests are recognized with or without a name', () => {
  assert.deepEqual(parseProjectRequest('프로젝트 생성해줘'), { title: '' });
  assert.deepEqual(parseProjectRequest('새 프로젝트 하나 만들어줘'), { title: '' });
  assert.deepEqual(parseProjectRequest('프로젝트 하나 만들어줘'), { title: '' });
  assert.deepEqual(parseProjectRequest('신제품 출시 프로젝트 만들어줘'), { title: '신제품 출시' });
  assert.deepEqual(parseProjectRequest('"졸업 전시"라는 프로젝트 만들어 줘'), { title: '졸업 전시' });
  assert.deepEqual(parseProjectRequest('프로젝트 만들기: 웹사이트 개편'), { title: '웹사이트 개편' });
  assert.equal(parseProjectRequest('중간고사 일정 알려줘'), null);
  assert.equal(parseProjectRequest('프로젝트 삭제해줘'), null);
  assert.equal(parseProjectRequest('프로젝트 알파 문서를 열어줘'), null);
  assert.equal(parseProjectRequest('알파 프로젝트 하나 찾아줘'), null);
  assert.equal(parseProjectRequest('프로젝트에 문서를 추가해줘'), null);
});

test('the chat draft only requires a name before the existing confirmation', () => {
  assert.equal(nextField(projectDraftValues('')).key, 'title');
  assert.equal(nextField(projectDraftValues('실기기 테스트')), null);
  assert.deepEqual(projectDraftValues('실기기 테스트'), { title: '실기기 테스트', status: '진행 전', priority: '보통', due: '' });
});

test('project status commands preserve the named target and explicit status', () => {
  assert.deepEqual(parseProjectStatusRequest('AITest 프로젝트 상태를 완료로 바꿔줘'), { title: 'AITest', status: '완료' });
  assert.deepEqual(parseProjectStatusRequest('프로젝트 상태 변경: AITest / 진행중'), { title: 'AITest', status: '진행 중' });
  assert.equal(parseProjectStatusRequest('AITest 프로젝트를 열어줘'), null);
  assert.equal(parseProjectStatusRequest('AITest 프로젝트를 삭제해줘'), null);
});

test('project lookup keeps duplicate IDs visible and approval detects changed fields or revisions', () => {
  const row = { id: 'one', title: 'AITest 프로젝트', status: '진행 전', revision: 2 };
  const duplicate = { ...row, id: 'two', revision: 1 };
  assert.deepEqual(filterProjects([row, duplicate], { title: 'AI Test' }).map(item => item.id), ['one', 'two']);
  const approved = projectSnapshot(row);
  assert.doesNotThrow(() => verifyProjectSnapshot({ ...row }, approved));
  for (const latest of [null, duplicate, { ...row, status: '보류' }, { ...row, revision: 3 }]) {
    assert.throws(() => verifyProjectSnapshot(latest, approved), { code: 'PROJECT_CONFLICT' });
  }
});

test('the template asks each required field in order, then summarizes', () => {
  assert.equal(nextField({}).key, 'title');
  assert.equal(nextField({ title: 'A' }).key, 'status');
  assert.equal(nextField({ title: 'A', status: '진행 중', priority: '높음' }).key, 'due');
  assert.equal(nextField({ title: 'A', status: '진행 중', priority: '높음', due: '' }), null);
  assert.equal(summary({ title: 'A', status: '진행 중', priority: '높음', due: '2026-11-27' }), '이름: A\n상태: 진행 중\n중요도: 높음\n마감: 11월 27일');
  assert.equal(summary({ title: 'A' }), '이름: A'); // 고르지 않은 항목은 보이지 않음
  assert.equal(summary({ title: 'A', status: '보류', priority: '낮음', due: '' }).split('\n').at(-1), '마감: 정하지 않음');
});

test('due options are concrete dates from today', () => {
  const options = dueOptions(new Date(2026, 10, 26)); // 목요일
  assert.deepEqual(options, [['이번 주 금요일', '2026-11-27'], ['이번 달 말', '2026-11-30'], ['다음 달 말', '2026-12-31'], ['정하지 않음', '']]);
  assert.equal(dueOptions(new Date(2026, 10, 27))[0][1], '2026-12-04'); // 금요일이면 다음 주 금요일
});
