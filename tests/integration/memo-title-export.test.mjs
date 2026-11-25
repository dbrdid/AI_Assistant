// 녹음 메모 자동 제목과 HTML·JSON 내보내기 (백업 브랜치의 titleGenerator, exportService를 Atria 구조로 옮긴 것)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService } from '../../frontend/Frontend_UI/src/integration/ai-service.js';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { recordingTitle } from '../../frontend/Frontend_UI/src/services/ai/recordingTitle.mjs';
// AgendaJudge.js imports extension-less app modules node cannot load; this is its recording rule (isMeetingNote).
const isRecordingNote = memo => /^녹음\s/.test(memo?.title ?? '');
import { memoFileBase, memoJson } from '../../frontend/Frontend_UI/src/features/memo/utils/memoMarkdown.mjs';

function world(draft = { title: '  "주간 회의   일정 조율"  ', summary: 's', organized: 'o', keywords: [] }) {
  const t = setup();
  const memo = t.store.addMemo({ title: '녹음 11/25 14:30', body: '다음 주 화요일 회의 일정을 조율했다.' });
  let policy = { route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true }, excluded: false };
  const calls = [];
  const service = createAIService({ store: t.store, newId: () => 'req', getSession: () => ({ id: 'a', generation: 1 }), getPolicy: () => policy,
    gateway: async (...args) => { calls.push(args); return { ok: true, draft }; } });
  return { ...t, memo, service, calls, policy: v => { policy = v; } };
}

test('suggestTitle asks organize through the memo policy and returns one clean title', async () => {
  const t = world();
  assert.equal(await t.service.suggestTitle(t.memo.id), '주간 회의 일정 조율');
  const [path, body, options] = t.calls[0];
  assert.equal(path, 'organize');
  assert.equal(body.text, t.memo.body);
  assert.equal(options.route, 'self_hosted');
  assert.equal(t.store.getMemo(t.memo.id).title, '녹음 11/25 14:30'); // the service never writes the memo itself
});

test('suggestTitle keeps the consent boundary and rejects an empty title', async () => {
  const t = world({ title: '   ' });
  await assert.rejects(t.service.suggestTitle(t.memo.id), { code: 'INVALID_MODEL_OUTPUT' });
  t.policy({ route: 'external', allowedProviders: ['openai'], consent: {}, excluded: false });
  await assert.rejects(t.service.suggestTitle(t.memo.id), { code: 'CONSENT_REQUIRED' });
});

test('a recording keeps its 녹음 prefix, so agenda matching still finds it', () => {
  assert.equal(recordingTitle('주간 회의 일정 조율'), '녹음 주간 회의 일정 조율');
  assert.equal(recordingTitle('녹음: 강의 정리'), '녹음 강의 정리');
  assert.ok(isRecordingNote({ title: recordingTitle('예산 검토') }));
});

test('JSON export carries title, body and handwriting with a format tag; file names are safe', () => {
  const strokes = [{ points: [[0, 0], [1, 1]] }];
  const out = memoJson({ title: '회의/정리: 1차?', body: '본문', strokes }, new Date('2026-11-25T00:00:00Z'));
  assert.equal(out.name, '회의-정리- 1차-.json');
  assert.deepEqual(JSON.parse(out.content), { format: 'atria-memo', version: 1, exportedAt: '2026-11-25T00:00:00.000Z', title: '회의/정리: 1차?', body: '본문', strokes });
  assert.equal(memoFileBase(''), '메모');
  assert.equal(memoFileBase('CON'), '메모');
});
