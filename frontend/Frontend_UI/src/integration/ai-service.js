import { requireTransmission } from '../../../../shared/contracts/ai-policy.js';
import { reviewReason } from '../features/proposal/proposalRules.js';

/** 유료 호출 없이 모바일 정책과 오래된 결과 처리 경로를 그대로 검증할 수 있도록 I/O를 주입합니다. */
export function createAIService({ store, gateway, getSession, getPolicy, newId }) {
  const active = new Set();
  const error = code => Object.assign(new Error(code), { code });
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
      const proposals = store.addProposals(store.serverMap.proposalsFromAnalyze(response.draft, {
        sourceType: 'memo', sourceId: snapshot.id, sourceTitle: snapshot.title, sourceRevision: snapshot.revision,
      }));
      // 요약은 원본을 덮어쓰지 않는 별도 메모 결과이며 자동 저장 모드의 안전 검사도 동일하게 거칩니다.
      if (typeof response.draft.summary === 'string' && response.draft.summary.trim()) {
        proposals.push(...store.addProposals([{ kind: 'memo', title: `${snapshot.title || '메모'} 요약`.slice(0, 200),
          body: response.draft.summary, sourceType: 'memo', sourceId: snapshot.id,
          sourceTitle: snapshot.title, sourceRevision: snapshot.revision }]));
      }
      let saved = 0;
      let pending = proposals.length;
      if (latest.confirmMode === 'auto') {
        pending = 0;
        for (const proposal of proposals) {
          if (reviewReason(proposal, {
            findDuplicate: fields => store.findDuplicate(fields),
            findOverlap: fields => store.findOverlap(fields),
          })) {
            pending += 1;
            continue;
          }
          store.approveProposal(proposal.id, {});
          saved += 1;
        }
      }
      return { added: proposals.length, saved, pending, requestId: response.request_id };
    } finally { signal?.removeEventListener('abort', abort); active.delete(controller); }
  }
  function cancel() { for (const c of active) c.abort(); }
  return { analyzeMemo, cancel };
}
