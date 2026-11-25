import test from 'node:test';
import assert from 'node:assert/strict';
import { createAIService } from '../../frontend/Frontend_UI/src/integration/ai-service.js';
import { selectChatSources } from '../../frontend/Frontend_UI/src/integration/ChatSourceScope.mjs';
import { setup } from '../../backend/local/tests/helpers.mjs';
import { requireTransmission, requireRoute } from '../../shared/contracts/ai-policy.js';
import { noConnectionText } from '../../frontend/Frontend_UI/src/features/project/projectConnectionText.js';
import { applyPendingMemoLinks } from '../../frontend/Frontend_UI/src/features/project/projectConnectionText.js';
import { queuePendingMemoLinks } from '../../frontend/Frontend_UI/src/features/project/projectConnectionText.js';
import { unresolvedPendingMemoLinkIds } from '../../frontend/Frontend_UI/src/features/project/projectConnectionText.js';
import { memoCreationWorkspaceId } from '../../frontend/Frontend_UI/src/features/memo/memoCreationWorkspace.js';
import { projectTaskSection } from '../../frontend/Frontend_UI/src/features/project/projectTaskKind.js';
import { canLinkProjectItems, canManageProjectItems, isWorkspaceOwner } from '../../frontend/Frontend_UI/src/features/project/projectPermissions.js';
import { isReferenceNoteProjectFailure } from '../../frontend/Frontend_UI/src/features/project/projectConnectionText.js';

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

test('project connection empty states distinguish missing memos from fully linked memos', () => {
  assert.equal(noConnectionText({ kind: 'memos', allCount: 0, candidateCount: 0, linkedCount: 0 }), '현재 공간에 메모가 없어요');
  assert.equal(noConnectionText({ kind: 'memos', allCount: 3, candidateCount: 0, linkedCount: 3 }), '모든 메모가 이미 프로젝트에 연결되어 있어요');
  assert.equal(noConnectionText({ kind: 'tasks', allCount: 0, candidateCount: 0, linkedCount: 0 }), '연결할 수 있는 항목이 없어요');
});

test('pending shared memo links override server links until synchronization succeeds', () => {
  const server = [{ note_id: 'memo-a', project_id: 'project-old' }];
  assert.deepEqual(applyPendingMemoLinks(server, { 'memo-a': 'project-new' }), [{ note_id: 'memo-a', project_id: 'project-new' }]);
  assert.deepEqual(applyPendingMemoLinks(server, { 'memo-a': null }), []);
  assert.deepEqual(applyPendingMemoLinks(server, { 'memo-b': 'project-new' }), [
    { note_id: 'memo-a', project_id: 'project-old' },
    { note_id: 'memo-b', project_id: 'project-new' },
  ]);
});

test('shared memo link actions are queued for synchronization', () => {
  assert.deepEqual(queuePendingMemoLinks({ 'memo-a': 'project-old' }, ['memo-a', 'memo-b'], 'project-new'), {
    'memo-a': 'project-new',
    'memo-b': 'project-new',
  });
  assert.deepEqual(queuePendingMemoLinks({ 'memo-a': 'project-old' }, ['memo-a'], null), {
    'memo-a': null,
  });
});

test('shared memo actions stay pending when their requested project link has not synced', () => {
  assert.deepEqual(unresolvedPendingMemoLinkIds({
    'memo-a': 'project-new',
    'memo-b': null,
    'memo-c': 'project-other',
  }, ['memo-a', 'memo-b', 'memo-c', 'memo-d'], 'project-new'), ['memo-a']);
  assert.deepEqual(unresolvedPendingMemoLinkIds({ 'memo-b': null }, ['memo-b'], null), ['memo-b']);
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

test('failed note-project foreign-key batches are identified for stale-batch cleanup', () => {
  assert.equal(isReferenceNoteProjectFailure({
    status: 'FAILED',
    lastError: 'REFERENCE_NOT_FOUND: insert or update on table note_projects',
    changes: [{ kind: 'link', entity: 'note_projects', data: { note_id: 'memo', project_id: 'project' } }],
  }), true);
  assert.equal(isReferenceNoteProjectFailure({
    status: 'FAILED',
    lastError: 'NETWORK: timed out',
    changes: [{ kind: 'link', entity: 'note_projects', data: {} }],
  }), false);
  assert.equal(isReferenceNoteProjectFailure({
    status: 'PENDING',
    lastError: 'REFERENCE_NOT_FOUND',
    changes: [{ kind: 'link', entity: 'note_projects', data: {} }],
  }), false);
});

test('manual summary preview calls the same policy boundary without saving proposals or editing the source', async () => {
  const t = world();
  const result = await t.service.analyzeMemo(t.source.id, { preview: true });
  assert.deepEqual(result, { summary: '검토할 요약', sourceId: t.source.id, sourceRevision: t.source.revision });
  assert.equal(t.calls.length, 1);
  assert.equal(t.store.getProposals().length, 0);
  assert.equal(t.store.getMemo(t.source.id).body, 'CANARY_BODY');
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

test('caller cancellation prevents a late manual summary preview even if the transport ignores abort', async () => {
  const t = world(); const controller = new AbortController();
  t.response(async () => {
    controller.abort();
    return { ok: true, draft: { summary: 'must not display', tasks: [], events: [] } };
  });
  await assert.rejects(t.service.analyzeMemo(t.source.id, { preview: true, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(t.store.getProposals().length, 0);
});

test('policy intersection refuses off-device data before any transport, including title canaries', async () => {
  const t = world();
  t.policy({ route: 'self_hosted', allowedProviders: [], consent: { self_hosted: true } });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'TRANSMISSION_DENIED' });
  assert.deepEqual(t.calls, []);
  t.policy({ route: 'external', allowedProviders: ['external'], consent: {} });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'CONSENT_REQUIRED' });
  assert.deepEqual(t.calls, []);
});

test('source exclusion and forged provider fail closed', async () => {
  const t = world();
  t.policy({ route: 'self_hosted', allowedProviders: ['self_hosted'], consent: { self_hosted: true }, excluded: true });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'TRANSMISSION_DENIED' });
  assert.throws(() => requireRoute('https://attacker.invalid'), { code: 'INVALID_AI_ROUTE' });
  assert.throws(() => requireTransmission('self_hosted', [{ allowedProviders: ['external'] }], { self_hosted: true }));
  assert.equal(t.calls.length, 0);
});

test('real local store + cloud-shaped response yields only pending proposals and preserves request revision', async () => {
  const t = world(); await t.service.analyzeMemo(t.source.id);
  assert.equal(t.calls[0][2].route, 'self_hosted');
  assert.equal(t.calls[0][1].text, 'CANARY_BODY');
  assert.equal(t.store.getMemos().length, 1);
  const proposal = t.store.getProposals()[0];
  assert.equal(proposal.sourceRevision, t.source.revision);
  assert.equal(proposal.status, 'pending');
  t.store.approveProposal(proposal.id);
  assert.equal(t.store.getMemos().length, 2);
});

test('auto-save commits safe results and leaves missing-date, duplicate, and overlapping items pending', async () => {
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
  assert.deepEqual({ added: result.added, saved: result.saved, pending: result.pending }, { added: 5, saved: 2, pending: 3 });
  assert.equal(t.store.getMemos().length, 2);
  assert.equal(t.store.getTasks().some(task => task.title === '새 할 일'), true);
  assert.deepEqual(new Set(t.store.getProposals().map(proposal => proposal.title)), new Set(['날짜 없는 일', '기존 항목', '시간 충돌']));
});

test('source edit while awaiting provider rejects even an otherwise valid response', async () => {
  const t = world();
  t.response(async () => { t.store.updateMemo(t.source.id, { body: 'new source' }); return { ok: true, draft: { summary: 'old summary', tasks: [], events: [] } }; });
  await assert.rejects(t.service.analyzeMemo(t.source.id), { code: 'SOURCE_CHANGED' });
  assert.equal(t.store.getProposals().length, 0);
});

test('account replacement, cancellation, and consent withdrawal cannot save a late result', async () => {
  for (const change of ['account', 'cancel', 'consent']) {
    const t = world();
    t.response(async () => {
      if (change === 'account') t.session({ id: 'other', generation: 2 });
      if (change === 'cancel') t.service.cancel();
      if (change === 'consent') t.policy({ route: 'self_hosted', allowedProviders: [], consent: { self_hosted: false } });
      return { ok: true, draft: { summary: 'late', tasks: [], events: [] } };
    });
    await assert.rejects(t.service.analyzeMemo(t.source.id));
    assert.equal(t.store.getProposals().length, 0);
  }
});

test('service forwards caller cancellation signal and never falls back after a self-hosted error', async () => {
  const t = world(); t.response(async () => { throw new Error('SELF_HOSTED_UNAVAILABLE'); });
  await assert.rejects(t.service.analyzeMemo(t.source.id));
  assert.equal(t.calls.length, 1);
  assert.ok(t.calls[0][2].signal instanceof AbortSignal);
  assert.equal(t.calls[0][2].route, 'self_hosted');
});
