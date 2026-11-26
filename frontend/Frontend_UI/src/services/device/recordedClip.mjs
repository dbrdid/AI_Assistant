const unreadable = '녹음 파일의 소리를 확인하지 못했어요. 다시 녹음해 주세요.';

// Only completed, playable takes enter the library and the transcription flow.
export async function finishRecordedClip(clip, inspect, store) {
  if (!clip?.uri) return { state: 'error', message: unreadable };
  let seconds = clip.seconds;
  if (inspect) {
    let audio;
    try { audio = await inspect(clip.uri); }
    catch { return { state: 'error', message: unreadable }; }
    if (!Number.isFinite(audio?.durationSeconds) || audio.durationSeconds < 0 || typeof audio.hasSignal !== 'boolean') {
      return { state: 'error', message: unreadable };
    }
    seconds = audio.durationSeconds;
    if (seconds < 0.1) return { state: 'error', message: '녹음이 너무 짧아요. 한마디 말한 뒤 다시 녹음을 끝내 주세요.' };
    if (!audio.hasSignal) return { state: 'error', message: '마이크에서 받은 소리가 처음부터 끝까지 무음이에요. 휴대폰의 마이크 액세스와 연결된 마이크의 음소거를 확인한 뒤 다시 녹음해 주세요.' };
  }
  return storeVerifiedClip(clip.uri, seconds, store);
}

export async function storeVerifiedClip(uri, seconds, store) {
  try {
    const saved = await store(uri, seconds);
    return { state: 'saved', uri: saved.uri || uri, seconds, fileId: saved.id };
  } catch (error) {
    return { state: 'save_error', uri, seconds, fileId: null, saveError: error?.message || '녹음 파일을 저장하지 못했어요.' };
  }
}

// Keep a result (including a retryable cache file) when its Today screen unmounts
// during decoding. Reopening another account or workspace must never display it.
const sheetsBySession = new WeakMap();
const listeners = new Set();

export function readRecordingSheet(owner) {
  return (owner && sheetsBySession.get(owner.session)?.get(owner.workspaceId)?.[0]) || null;
}

export function writeRecordingSheet(owner, sheet, previous = null) {
  if (!owner) return;
  let sheets = sheetsBySession.get(owner.session);
  if (!sheets) {
    sheets = new Map();
    sheetsBySession.set(owner.session, sheets);
  }
  const queue = sheets.get(owner.workspaceId) || [];
  if (previous) {
    const index = queue.indexOf(previous);
    if (index < 0) return; // A closed result must not reopen when its save finishes.
    if (sheet) queue.splice(index, 1, sheet);
    else queue.splice(index, 1);
  } else if (sheet) queue.push(sheet);
  if (queue.length) sheets.set(owner.workspaceId, queue);
  else sheets.delete(owner.workspaceId);
  listeners.forEach(listener => listener());
}

export function subscribeRecordingSheets(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
