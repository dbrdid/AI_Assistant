import { runtime, maybeRuntime } from '../../integration/runtime';
import { getSettings } from '../../data/settings/SettingsStore';
import { addNotice } from '../../data/notices/NoticeStore';
export async function analyzeText({ sourceType, sourceId }) {
  const own = runtime();
  if (!getSettings().ai.autoAnalyze) return { added: 0, saved: 0 };
  if (sourceType !== 'memo') return { added: 0, saved: 0, error: '확인한 메모로 저장한 후 분석해 주세요' };
  try { return await own.ai.analyzeMemo(sourceId); }
  catch (error) { if (maybeRuntime() === own) addNotice({ kind: 'ai', title: 'AI 분석을 완료하지 못했습니다', body: error.message, at: Date.now() }); return { added: 0, saved: 0, error: error.message }; }
}
