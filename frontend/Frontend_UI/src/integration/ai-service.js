import { requireTransmission } from '../../../../shared/contracts/ai-policy.js';

/** I/O is injected so the exact mobile policy and stale-result path can be exercised without paid calls. */
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
      // Summary is a separate pending memo proposal: it is never silently written into the source.
      if (typeof response.draft.summary === 'string' && response.draft.summary.trim()) {
        proposals.push(...store.addProposals([{ kind: 'memo', title: `${snapshot.title || '메모'} 요약`.slice(0, 200),
          body: response.draft.summary, sourceType: 'memo', sourceId: snapshot.id,
          sourceTitle: snapshot.title, sourceRevision: snapshot.revision }]));
      }
      return { added: proposals.length, saved: 0, requestId: response.request_id };
    } finally { signal?.removeEventListener('abort', abort); active.delete(controller); }
  }
  function cancel() { for (const c of active) c.abort(); }
  return { analyzeMemo, cancel };
}
