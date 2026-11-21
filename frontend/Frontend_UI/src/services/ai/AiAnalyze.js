import { runtime, maybeRuntime } from '../../integration/runtime';
import { getSettings } from '../../data/settings/SettingsStore';
import { addNotice } from '../../data/notices/NoticeStore';
// explicit: 사용자가 이 분석을 위해 버튼을 눌렀음을 나타냅니다(예: 녹음 [텍스트로 정리하기]).
// 따라서 "AI 자동 분석"이 꺼져 있어도 실행됩니다. 해당 설정은 저장 후 자동으로 시작되는 분석에만 적용됩니다.
export async function analyzeText({ sourceType, sourceId, explicit = false }) {
  const own = runtime();
  if (!explicit && !getSettings().ai.autoAnalyze) return { added: 0, saved: 0, skipped: true };
  if (sourceType !== 'memo') return { added: 0, saved: 0, error: '확인한 메모로 저장한 후 분석해 주세요' };
  try { return await own.ai.analyzeMemo(sourceId); }
  catch (error) { if (maybeRuntime() === own) addNotice({ kind: 'ai', title: 'AI 분석을 완료하지 못했습니다', body: error.message, at: Date.now() }); return { added: 0, saved: 0, error: error.message }; }
}
