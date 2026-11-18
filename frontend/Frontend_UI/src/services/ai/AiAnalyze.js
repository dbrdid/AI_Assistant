import { runtime, maybeRuntime } from '../../integration/runtime';
import { getSettings } from '../../data/settings/SettingsStore';
import { addNotice } from '../../data/notices/NoticeStore';
// explicit: the user pressed a button for this analysis (e.g. 녹음 [텍스트로 정리하기]), so it runs even when
// "AI 자동 분석" is off. That setting only covers analysis that starts on its own after saving.
export async function analyzeText({ sourceType, sourceId, explicit = false }) {
  const own = runtime();
  if (!explicit && !getSettings().ai.autoAnalyze) return { added: 0, saved: 0, skipped: true };
  if (sourceType !== 'memo') return { added: 0, saved: 0, error: '확인한 메모로 저장한 후 분석해 주세요' };
  try { return await own.ai.analyzeMemo(sourceId); }
  catch (error) { if (maybeRuntime() === own) addNotice({ kind: 'ai', title: 'AI 분석을 완료하지 못했습니다', body: error.message, at: Date.now() }); return { added: 0, saved: 0, error: error.message }; }
}
