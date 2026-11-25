import { runtime, maybeRuntime } from '../../integration/runtime';
import { getSettings } from '../../data/settings/SettingsStore';
import { addNotice } from '../../data/notices/NoticeStore';
// explicit: the user pressed a button for this analysis (e.g. 녹음 [텍스트로 정리하기]), so it runs even when
// "AI 자동 분석" is off. That setting only covers analysis that starts on its own after saving.
export async function analyzeText({ sourceType, sourceId, explicit = false }) {
  const own = runtime();
  if (!explicit && !getSettings().ai.autoAnalyze) return { added: 0, saved: 0, skipped: true };
  if (sourceType !== 'memo') return { added: 0, saved: 0, error: '확인한 메모로 저장한 후 분석해 주세요' };
  try {
    const result = await own.ai.analyzeMemo(sourceId);
    if (result.blocked && maybeRuntime() === own) addNotice({ kind: 'ai', title: '시각을 확인할 수 없는 제안을 제외했습니다', body: `원문의 시각을 보존할 수 없는 제안 ${result.blocked}건을 저장하지 않았습니다. 원문은 그대로입니다.`, at: Date.now() });
    return result;
  }
  catch (error) { if (maybeRuntime() === own) addNotice({ kind: 'ai', title: 'AI 분석을 완료하지 못했습니다', body: error.message, at: Date.now() }); return { added: 0, saved: 0, error: error.message }; }
}
