import { runtime } from '../../integration/runtime';

export async function summarizeText(text, { memoId, signal } = {}) {
  const own = runtime();
  const memo = memoId && own.store.getMemo(memoId);
  if (!memo || memo.body.trim() !== text.trim()) throw new Error('메모를 저장한 뒤 다시 요약해 주세요');
  return own.ai.analyzeMemo(memoId, { preview: true, signal });
}
