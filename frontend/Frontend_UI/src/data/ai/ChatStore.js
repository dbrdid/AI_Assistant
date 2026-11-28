// AI 채팅 기록입니다. 계정과 워크스페이스별로 이 기기에만 저장합니다. 답변에는 메모와 할 일의 일부가 인용될 수 있으며,
// 질문에 포함해 전송하는 경우를 제외하면 개인 기록은 기기 밖으로 전송되지 않습니다.
// 고정한 대화는 목록 맨 앞에 표시하며, 대화 수가 MAX_CHATS를 넘어도 삭제하지 않습니다.
import { readPreference, scoped, useValue, writePreference, maybeRuntime } from '../hooks';

export const MAX_CHATS = 50;
const MAX_MESSAGES = 100;
const EMPTY = Object.freeze([]);
const key = () => scoped('ai-chats');
// readPreference는 키별 첫 번째 기본값을 기억하므로 항상 같은 기본값으로 읽습니다.
export const getChats = () => (maybeRuntime() ? readPreference(key(), EMPTY) ?? EMPTY : EMPTY);
export const useChats = () => useValue(getChats);
export const getChat = id => getChats().find(c => c.id === id) ?? null;
// 표시 순서: 고정한 대화를 먼저(최근 고정 순), 그다음 최근 수정 순으로 표시합니다.
export const sortChats = chats => chats.slice().sort((a, b) =>
  (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

const titleOf = messages => {
  const first = messages.find(m => m.role === 'user')?.text ?? '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 40) || '새 대화';
};
// 대화를 다시 표시하는 데 필요한 값만 저장합니다(진행 중인 응답이나 첨부 파일 데이터는 제외).
const clean = m => ({
  id: m.id, role: m.role, text: m.text, error: !!m.error,
  ...(m.documentLookup && { documentLookup: true }),
  attachments: (m.attachments ?? []).map(a => ({ id: a.id, name: a.name, kind: a.kind })),
  sources: (m.sources ?? []).map(s => ({ id: s.id, type: s.type, title: s.title, route: s.route ?? null })),
});

function write(chats) {
  const pinned = chats.filter(c => c.pinnedAt);
  const rest = chats.filter(c => !c.pinnedAt).slice(0, Math.max(0, MAX_CHATS - pinned.length));
  writePreference(key(), [...pinned, ...rest].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
}

// 제목 출처: 'question'(AI 제목이 생성되기 전까지 첫 질문 사용) | 'ai'(대화 내용으로 생성) | 'user'(사용자가 변경)
export function saveChat(id, messages) {
  const done = messages.filter(m => m.role === 'user' || m.done || m.error).map(clean).slice(-MAX_MESSAGES);
  if (!done.length) return;
  const before = getChat(id);
  const keep = before && before.titleSource && before.titleSource !== 'question';
  const chat = {
    id, title: keep ? before.title : titleOf(done), titleSource: keep ? before.titleSource : 'question',
    updatedAt: Date.now(), messages: done, pinnedAt: before?.pinnedAt ?? null,
  };
  write([chat, ...getChats().filter(c => c.id !== id)]);
}

export const TITLE_MAX = 40;
/** 제목을 변경합니다. AI 제목은 사용자가 입력한 제목을 덮어쓰지 않습니다. 변경 사항이 없으면 false를 반환합니다. */
export function setChatTitle(id, title, source = 'user') {
  const chat = getChat(id);
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  if (!chat || !clean || (source === 'ai' && chat.titleSource === 'user')) return false;
  write(getChats().map(c => (c.id === id ? { ...c, title: clean, titleSource: source } : c)));
  return true;
}

/** 대화를 고정하거나 고정을 해제합니다. 저장되지 않은 대화는 먼저 화면의 메시지로 저장합니다. */
export function setPinned(id, pinned, messages = []) {
  if (!getChat(id)) saveChat(id, messages);
  if (!getChat(id)) return false;
  write(getChats().map(c => (c.id === id ? { ...c, pinnedAt: pinned ? Date.now() : null } : c)));
  return true;
}
export const deleteChat = id => writePreference(key(), getChats().filter(c => c.id !== id));
export const deleteAllChats = () => writePreference(key(), EMPTY);
