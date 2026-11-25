import { requireTransmission } from '../../../../shared/contracts/ai-policy.js';
import { reviewReason } from '../features/proposal/proposalRules.js';
import { originalEvidence, sourceSpelling, statedTimes, unstatedTimeWarning, verifiedStart } from './recordEvidence.mjs';

/** I/O is injected so the exact mobile policy and stale-result path can be exercised without paid calls. */
export function createAIService({ store, gateway, getSession, getPolicy, newId }) {
  const active = new Set();
  const error = code => Object.assign(new Error(code), { code });
  async function mergePhotoTextIntoMemo(id, photoText, { sourceRevision, sessionId, sessionGeneration, workspaceId, signal } = {}) {
    if (signal?.aborted) throw error('CANCELLED');
    const session = getSession();
    const source = store.getMemo(id);
    if (!session || !source || source.deletedAt !== null) throw error('SOURCE_CHANGED');
    if (sourceRevision !== undefined && source.revision !== sourceRevision) throw error('SOURCE_CHANGED');
    if ((sessionId !== undefined && session.id !== sessionId)
      || (sessionGeneration !== undefined && session.generation !== sessionGeneration)
      || (workspaceId !== undefined && store.getCurrentWorkspace().id !== workspaceId)) throw error('SOURCE_CHANGED');
    const policy = getPolicy(source);
    if (policy.route !== 'external') throw error('ROUTE_UNSUPPORTED');
    requireTransmission(policy.route, [policy], policy.consent);

    const text = String(photoText ?? '').trim();
    if (!text) throw error('INVALID_MODEL_OUTPUT');
    const input = [
      `기존 메모 제목: ${source.title || '(제목 없음)'}`,
      '기존 메모 본문:',
      source.body,
      '',
      '사진에서 추출한 새 내용:',
      text,
    ].join('\n');
    if (input.length > 8000) throw error('INPUT_TOO_LONG');

    const snapshot = {
      id: source.id,
      revision: source.revision,
      title: source.title,
      body: source.body,
      workspace: store.getCurrentWorkspace().id,
      generation: session.generation,
      accountId: session.id,
    };
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await gateway('organize', {
        client_request_id: newId(),
        text: input,
        workspace_id: policy.workspaceId ?? null,
      }, { route: policy.route, signal: controller.signal });

      const current = getSession();
      const memo = store.getMemo(snapshot.id);
      if (controller.signal.aborted || current?.generation !== snapshot.generation || current?.id !== snapshot.accountId) {
        throw error('CANCELLED');
      }
      if (store.getCurrentWorkspace().id !== snapshot.workspace || !memo || memo.deletedAt !== null
        || memo.revision !== snapshot.revision || memo.body !== snapshot.body || memo.title !== snapshot.title) {
        throw error('SOURCE_CHANGED');
      }
      const latest = getPolicy(memo);
      requireTransmission(policy.route, [latest], latest.consent);
      if (!response?.ok || typeof response.draft?.organized !== 'string' || !response.draft.organized.trim()) {
        throw error('INVALID_MODEL_OUTPUT');
      }
      return {
        body: response.draft.organized.trim(),
        sourceId: snapshot.id,
        sourceRevision: snapshot.revision,
        requestId: response.request_id,
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      active.delete(controller);
    }
  }

  async function analyzeMemo(id, { preview = false, signal } = {}) {
    if (signal?.aborted) throw error('CANCELLED');
    const session = getSession();
    const source = store.getMemo(id);
    if (!session || !source || source.deletedAt !== null) throw error('SOURCE_CHANGED');
    const policy = getPolicy(source);
    requireTransmission(policy.route, [policy], policy.consent);
    const snapshot = { id: source.id, revision: source.revision, title: source.title, text: source.body,
      workspace: store.getCurrentWorkspace().id, generation: session.generation, accountId: session.id };
    const controller = new AbortController(); active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await gateway('analyze', { client_request_id: newId(), text: snapshot.text,
        timezone: policy.timezone ?? 'Asia/Seoul', kind: 'MEMO', workspace_id: policy.workspaceId ?? null },
      { route: policy.route, signal: controller.signal });
      const current = getSession(); const memo = store.getMemo(snapshot.id);
      if (controller.signal.aborted || current?.generation !== snapshot.generation || current?.id !== snapshot.accountId) throw error('CANCELLED');
      if (store.getCurrentWorkspace().id !== snapshot.workspace || !memo || memo.deletedAt !== null
        || memo.revision !== snapshot.revision || memo.body !== snapshot.text || memo.title !== snapshot.title) throw error('SOURCE_CHANGED');
      const latest = getPolicy(memo);
      requireTransmission(policy.route, [latest], latest.consent);
      if (!response?.ok || !response.draft) throw error('INVALID_MODEL_OUTPUT');
      if (preview) {
        if (typeof response.draft.summary !== 'string' || !response.draft.summary.trim()) throw error('INVALID_MODEL_OUTPUT');
        return { summary: response.draft.summary, sourceId: id, sourceRevision: snapshot.revision };
      }
      const candidates = store.serverMap.proposalsFromAnalyze(response.draft, {
        sourceType: 'memo', sourceId: snapshot.id, sourceTitle: snapshot.title, sourceRevision: snapshot.revision,
      });
      const planned = candidates.flatMap(proposal => {
        const evidence = originalEvidence(snapshot.text, proposal.evidence);
        // A task without a time keeps none: a time in its sentence may belong to another event.
        const timeSource = statedTimes(evidence).length ? evidence : candidates.length === 1 ? snapshot.text : '';
        const start = proposal.kind === 'task' && !proposal.start ? '' : verifiedStart(proposal.start, timeSource);
        if (start === null) return [];
        return [{ ...proposal, evidence, start, end: !proposal.endDate && proposal.end && proposal.end < start ? '' : proposal.end,
          title: sourceSpelling(snapshot.text, proposal.title), body: sourceSpelling(snapshot.text, proposal.body) }];
      });
      const proposals = store.addProposals(planned);
      const stored = saved => planned.some(item => ['kind', 'title', 'date', 'start', 'evidence'].every(key => saved[key] === item[key]));
      if (!proposals.every(stored)) {
        for (const proposal of proposals) store.setProposalStatus(proposal.id, 'rejected');
        throw error('INVALID_MODEL_OUTPUT');
      }
      const blocked = candidates.length - planned.length;
      // Summary is a separate pending memo proposal: it is never silently written into the source.
      if (typeof response.draft.summary === 'string' && response.draft.summary.trim()) {
        proposals.push(...store.addProposals([{ kind: 'memo', title: `${snapshot.title || '메모'} 요약`.slice(0, 200),
          body: response.draft.summary, sourceType: 'memo', sourceId: snapshot.id,
          sourceTitle: snapshot.title, sourceRevision: snapshot.revision }]));
      }
      // 자동 저장(설정 > AI 확인 방식): 원문 근거 검사를 통과한 일정, 할 일 중 날짜가 있고 중복, 시간 충돌이 없는 것만 바로 저장.
      // 요약(메모 제안)과 확인이 필요한 것은 작업 검토에 남긴다.
      let saved = 0;
      if (latest.confirmMode === 'auto') {
        for (const proposal of proposals) {
          // 작업 검토 화면과 같은 기준: 메모에 없던 시각이 들어간 결과도 사람이 확인
          if (proposal.kind === 'memo' || unstatedTimeWarning(proposal, snapshot.text) || reviewReason(proposal, {
            findDuplicate: fields => store.findDuplicate(fields),
            findOverlap: fields => store.findOverlap(fields),
          })) continue;
          try { store.approveProposal(proposal.id, {}); saved += 1; } catch { /* 원본이 바뀌었으면 검토 목록에 남음 */ }
        }
      }
      return { added: proposals.length, saved, pending: proposals.length - saved, requestId: response.request_id, ...(blocked ? { blocked } : {}) };
    } finally { signal?.removeEventListener('abort', abort); active.delete(controller); }
  }
  /**
   * A title for the memo from its content (the gateway's organize draft, 40 characters at most). Same consent and
   * route checks as analyzeMemo. Only the title is returned; the caller decides whether to use it.
   */
  async function suggestTitle(id, { signal } = {}) {
    if (signal?.aborted) throw error('CANCELLED');
    const session = getSession();
    const source = store.getMemo(id);
    if (!session || !source || source.deletedAt !== null || !source.body.trim()) throw error('SOURCE_CHANGED');
    const policy = getPolicy(source);
    requireTransmission(policy.route, [policy], policy.consent);
    const controller = new AbortController(); active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // organize takes 8,000 characters; the opening of a long transcript is enough to name it.
      const response = await gateway('organize', { client_request_id: newId(), text: source.body.slice(0, 8000), workspace_id: policy.workspaceId ?? null },
        { route: policy.route, signal: controller.signal });
      if (controller.signal.aborted || getSession()?.generation !== session.generation) throw error('CANCELLED');
      const title = typeof response?.draft?.title === 'string' ? response.draft.title.replace(/\s+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim().slice(0, 40) : '';
      if (!response?.ok || !title) throw error('INVALID_MODEL_OUTPUT');
      return title;
    } finally { signal?.removeEventListener('abort', abort); active.delete(controller); }
  }
  function cancel() { for (const c of active) c.abort(); }
  return { analyzeMemo, suggestTitle, mergePhotoTextIntoMemo, cancel };
}
