// feature/planner-updates에서 옮긴 기능의 테스트 (사진 메모 정리, 자동 저장, 새 메모 공간, 프로젝트 분류와 권한, AI 채팅 파일 범위).
// 원본: feature/planner-updates의 tests/integration/ai-service.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService } from '../../frontend/Frontend_UI/src/integration/ai-service.js';
import { selectChatSources } from '../../frontend/Frontend_UI/src/integration/ChatSourceScope.mjs';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { memoCreationWorkspaceId } from '../../frontend/Frontend_UI/src/features/memo/memoCreationWorkspace.js';
import { projectTaskSection } from '../../frontend/Frontend_UI/src/features/project/projectTaskKind.js';
import { fileSearchRow, rankSearchRows } from '../../frontend/Frontend_UI/src/data/memos/memoSearch.mjs';
import { canLinkProjectItems, canManageProjectItems, isWorkspaceOwner } from '../../frontend/Frontend_UI/src/features/project/projectPermissions.js';

function world() {
  const t = setup();
  const source = t.store.addMemo({ title: 'CANARY_TITLE', body: 'CANARY_BODY' });
  let session = { id: 'account', generation: 1 };
  let policy = { route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true }, excluded: false };
  const calls = [];
  let response = async () => ({ ok: true, request_id: 'fixture', draft: { summary: '검토할 요약', tasks: [], events: [] } });
  const service = createAIService({ store: t.store, newId: () => 'request', getSession: () => session,
    getPolicy: () => policy, gateway: async (...args) => { calls.push(args); return response(...args); } });
  return { ...t, source, service, calls, policy: value => { policy = value; }, session: value => { session = value; }, response: value => { response = value; } };
}

test('file-vault chat scope keeps every explicitly attached file and skips planner records', () => {
  const vaultFile = { id: 'vault-file', sourceScope: 'vault' };
  const pickedFile = { id: 'picked-file' };
  const memo = { id: 'memo', type: 'memo' };
  assert.deepEqual(selectChatSources({
    attachments: [vaultFile, pickedFile], records: [memo], fileVaultOnly: true,
  }), { attachments: [vaultFile, pickedFile], records: [] });
  assert.deepEqual(selectChatSources({
    attachments: [pickedFile], records: [memo], fileVaultOnly: false,
  }), { attachments: [pickedFile], records: [memo] });
});

test('new memos follow the selected workspace or the active workspace in all-spaces view', () => {
  assert.equal(memoCreationWorkspaceId({ selectedSpace: 'shared-a', currentWorkspaceId: 'personal' }), 'shared-a');
  assert.equal(memoCreationWorkspaceId({ selectedSpace: 'all', currentWorkspaceId: 'shared-b' }), 'shared-b');
  assert.equal(memoCreationWorkspaceId({ selectedSpace: 'all', currentWorkspaceId: 'personal' }), 'personal');
});

test('project task classification uses item kind instead of whether a start time exists', () => {
  assert.equal(projectTaskSection({ kind: 'task', start: '09:00' }), 'todos');
  assert.equal(projectTaskSection({ kind: 'task', start: '' }), 'todos');
  assert.equal(projectTaskSection({ kind: 'event', start: '' }), 'events');
  assert.equal(projectTaskSection({ kind: 'event', start: '09:00' }), 'events');
  assert.equal(projectTaskSection({ start: '09:00' }), 'events');
  assert.equal(projectTaskSection({ start: '' }), 'todos');
});

test('only workspace owners and project leaders can manage project connections', () => {
  assert.equal(isWorkspaceOwner({ personal: false, roleCode: 'OWNER' }), true);
  assert.equal(isWorkspaceOwner({ personal: false, role: '관리자' }), true);
  assert.equal(canManageProjectItems({ workspace: { personal: false, roleCode: 'EDITOR' }, projectLeader: true }), true);
  assert.equal(canManageProjectItems({ workspace: { personal: false, roleCode: 'EDITOR' }, projectLeader: false }), false);
  assert.equal(canManageProjectItems({ workspace: { personal: true, roleCode: 'OWNER' }, projectLeader: false }), true);
});

test('workspace members can link items while only owners or project leaders can unlink', () => {
  assert.equal(canLinkProjectItems({ personal: false, roleCode: 'EDITOR' }), true);
  assert.equal(canLinkProjectItems({ personal: false, role: '멤버' }), true);
  assert.equal(canLinkProjectItems({ personal: false, roleCode: 'VIEWER' }), false);
  assert.equal(canManageProjectItems({ workspace: { personal: false, roleCode: 'EDITOR' }, projectLeader: false }), false);
  assert.equal(canManageProjectItems({ workspace: { personal: false, roleCode: 'EDITOR' }, projectLeader: true }), true);
});

test('photo memo integration returns an editable preview without changing the saved memo', async () => {
  const t = world();
  t.policy({ route: 'external', allowedProviders: ['external'], consent: { external: true }, excluded: false });
  t.response(async () => ({
    ok: true,
    request_id: 'photo-merge',
    draft: { organized: '기존 내용\n\n사진에서 확인한 내용', title: '무시할 제목' },
  }));

  const result = await t.service.mergePhotoTextIntoMemo(t.source.id, '사진에서 확인한 내용', {
    sourceRevision: t.source.revision,
  });

  assert.equal(result.body, '기존 내용\n\n사진에서 확인한 내용');
  assert.equal(result.sourceRevision, t.source.revision);
  assert.equal(t.store.getMemo(t.source.id).body, 'CANARY_BODY');
  assert.equal(t.calls[0][0], 'organize');
  assert.equal(t.calls[0][2].route, 'external');
  assert.match(t.calls[0][1].text, /사진에서 확인한 내용/);
});

test('photo memo integration rejects stale source revisions and source edits during generation', async () => {
  const t = world();
  t.policy({ route: 'external', allowedProviders: ['external'], consent: { external: true }, excluded: false });
  await assert.rejects(t.service.mergePhotoTextIntoMemo(t.source.id, '사진 내용', {
    sourceRevision: t.source.revision + 1,
  }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(t.service.mergePhotoTextIntoMemo(t.source.id, '사진 내용', {
    sessionId: 'another-account',
  }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(t.service.mergePhotoTextIntoMemo(t.source.id, '사진 내용', {
    workspaceId: 'another-workspace',
  }), { code: 'SOURCE_CHANGED' });
  assert.equal(t.calls.length, 0);

  t.response(async () => {
    t.store.updateMemo(t.source.id, { body: '다른 기기에서 바뀐 내용' });
    return { ok: true, draft: { organized: '오래된 초안' } };
  });
  await assert.rejects(t.service.mergePhotoTextIntoMemo(t.source.id, '사진 내용'), { code: 'SOURCE_CHANGED' });
  assert.equal(t.store.getMemo(t.source.id).body, '다른 기기에서 바뀐 내용');
});

test('photo memo integration never routes through local AI or bypasses external consent', async () => {
  const t = world();
  await assert.rejects(t.service.mergePhotoTextIntoMemo(t.source.id, '사진 내용'), { code: 'ROUTE_UNSUPPORTED' });
  assert.equal(t.calls.length, 0);

  t.policy({ route: 'external', allowedProviders: ['external'], consent: {}, excluded: false });
  await assert.rejects(t.service.mergePhotoTextIntoMemo(t.source.id, '사진 내용'), { code: 'CONSENT_REQUIRED' });
  assert.equal(t.calls.length, 0);
});

// 원본과 다른 점: 여기서는 요약(메모 제안)을 자동 저장하지 않고 작업 검토에 남긴다 (일정과 할 일만 자동 저장)
test('auto-save commits safe results and leaves the summary, missing-date, duplicate, and overlapping items pending', async () => {
  const t = world();
  const date = '2026-11-30';
  t.store.addTask({ kind: 'task', title: '기존 항목', date });
  t.store.addTask({ kind: 'event', title: '기존 일정', date, start: '10:00', end: '11:00' });
  t.policy({ route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true }, confirmMode: 'auto' });
  t.response(async () => ({
    ok: true,
    request_id: 'fixture',
    draft: {
      summary: '자동 저장 요약',
      tasks: [
        { title: '날짜 없는 일', due_date: '', due_time: '', description: '' },
        { title: '기존 항목', due_date: date, due_time: '', description: '' },
        { title: '시간 충돌', due_date: date, due_time: '10:30', description: '' },
        { title: '새 할 일', due_date: date, due_time: '', description: '' },
      ],
      events: [],
    },
  }));

  const result = await t.service.analyzeMemo(t.source.id);
  assert.deepEqual({ added: result.added, saved: result.saved, pending: result.pending }, { added: 5, saved: 1, pending: 4 });
  assert.equal(t.store.getMemos().length, 1);
  assert.equal(t.store.getTasks().some(task => task.title === '새 할 일'), true);
  assert.deepEqual(new Set(t.store.getProposals().map(proposal => proposal.title)), new Set(['날짜 없는 일', '기존 항목', '시간 충돌', 'CANARY_TITLE 요약']));
});


test('recording analysis keeps safe results pending against the finalized title revision', async () => {
  const t = world();
  const memo = t.store.updateMemo(t.source.id, { title: '녹음 주간 회의' });
  t.policy({ route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true }, confirmMode: 'auto' });
  t.response(async () => ({
    ok: true,
    draft: { tasks: [{ title: '자료 보내기', due_date: '2099-11-30', due_time: '' }], events: [] },
  }));

  const result = await t.service.analyzeMemo(memo.id, { requireReview: true });
  assert.deepEqual([result.added, result.saved, result.pending], [1, 0, 1]);
  assert.equal(t.store.getTasks().length, 0);
  const [proposal] = t.store.getProposals();
  assert.equal(proposal.sourceRevision, memo.revision);
  t.store.approveProposal(proposal.id);
  assert.equal(t.store.getTasks()[0].title, '자료 보내기');
});

// 원본: feature/planner-updates의 file-name-search.test.mjs (여기서는 main의 검색 함수로 같은 동작을 확인)
test('matches filenames case-insensitively and across all query terms', () => {
  const files = [
    { id: 'one', name: 'Budget-Meeting.pdf', text: 'private content', kind: '문서' },
    { id: 'two', name: 'Budget.pdf', kind: '문서' },
  ];
  assert.deepEqual(rankSearchRows(files.map(fileSearchRow), ['budget', 'MEETING']).map(file => file.id), ['one']);
});

test('does not find a file by its extracted body text', () => {
  const files = [{ id: 'one', name: 'Meeting.pdf', text: 'annual budget', kind: '문서' }];
  assert.deepEqual(rankSearchRows(files.map(fileSearchRow), ['budget']), []);
});
