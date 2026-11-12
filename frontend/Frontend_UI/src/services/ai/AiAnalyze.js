// ============================================================
// AiAnalyze.js — 메모/녹음 글에서 AI 제안을 만들어 "검증 필요" 목록에 넣기
// ============================================================

import { extractFromText } from './AiExtract';
import { addProposals, approveProposal } from '../../data/proposals/ProposalStore';
import { addNotice } from '../../data/notices/NoticeStore';
import { getSettings } from '../../data/settings/SettingsStore';
import { ROUTES } from '../../navigation/routes';

export async function analyzeText({ sourceType, sourceId, sourceTitle = '', text }) {
  const ai = getSettings().ai || {};
  if (ai.autoAnalyze === false) return { added: 0, saved: 0 };
  const found = extractFromText(text);
  if (!found.length) return { added: 0, saved: 0 };
  const added = addProposals(found.map((x) => ({ ...x, sourceType, sourceId, sourceTitle })));
  if (!added.length) return { added: 0, saved: 0 };
  if (ai.confirmMode === 'auto') {
    added.forEach((p) => approveProposal(p.id, {}));
    return { added: 0, saved: added.length };
  }
  addNotice({
    key: `ai:${added[0].id}`,
    kind: 'ai',
    title: `AI 제안 ${added.length}건을 확인해 주세요`,
    body: added.map((p) => p.title).slice(0, 2).join(', '),
    at: Date.now(),
    route: ROUTES.Proposals,
  });
  return { added: added.length, saved: 0 };
}
