import test from 'node:test';
import assert from 'node:assert/strict';
import { dueOptions, nextField, parseProjectRequest, summary } from '../../frontend/Frontend_UI/src/features/ai/projectTemplate.mjs';

test('project requests are recognized with or without a name', () => {
  assert.deepEqual(parseProjectRequest('프로젝트 생성해줘'), { title: '' });
  assert.deepEqual(parseProjectRequest('새 프로젝트 하나 만들어줘'), { title: '' });
  assert.deepEqual(parseProjectRequest('신제품 출시 프로젝트 만들어줘'), { title: '신제품 출시' });
  assert.deepEqual(parseProjectRequest('"졸업 전시"라는 프로젝트 만들어 줘'), { title: '졸업 전시' });
  assert.deepEqual(parseProjectRequest('프로젝트 만들기: 웹사이트 개편'), { title: '웹사이트 개편' });
  assert.equal(parseProjectRequest('중간고사 일정 알려줘'), null);
  assert.equal(parseProjectRequest('프로젝트 삭제해줘'), null);
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
