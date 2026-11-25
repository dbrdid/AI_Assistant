// AiTitle.js — 녹음 메모 제목을 내용으로 짓기
//   "녹음 11/25 14:30" → "녹음 주간 회의 일정 조율". 앞의 "녹음 "은 남겨 둔다: 회의 안건 판단(AgendaJudge)이 이것으로 녹음 메모를 알아본다.
//   AI가 실패하거나, 그사이 사용자가 제목이나 내용을 고쳤으면 아무것도 바꾸지 않는다.
import { maybeRuntime, runtime } from '../../integration/runtime';
import { recordingTitle } from './recordingTitle.mjs';

/** timeTitle: 저장할 때 붙인 시간 제목. 바꿨으면 새 제목, 아니면 null */
export async function titleRecording(memoId, timeTitle) {
  const own = runtime();
  try {
    const before = own.store.getMemo(memoId);
    if (!before || before.title !== timeTitle) return null;
    const title = recordingTitle(await own.ai.suggestTitle(memoId));
    const now = own.store.getMemo(memoId);
    if (maybeRuntime() !== own || !now || now.title !== timeTitle || now.revision !== before.revision) return null;
    own.store.updateMemo(memoId, { title }, { expectedRevision: now.revision });
    return title;
  } catch { return null; } // 시간 제목이 그대로 남음
}
