// 메모 즐겨찾기 (#29) — 사람마다 따로. React Native 의존 없음
//   서버: set_note_favorites · list_note_favorites (공유 공간 메모만)
//   개인 공간 메모는 기기에만 있으니 즐겨찾기도 기기 SQLite에 두세요 (서버로 안 보냄)
//
//   [메모 목록 선택 모드의 ★ 버튼] (MemoListScreen: 전부 별표면 "★ 해제", 하나라도 아니면 "★ 즐겨찾기")
//     const action = favoriteAction(selectedMemos);                 // 'add' | 'remove'
//     const r = await setNoteFavorites(supabase, workspaceId, ids, action === 'add');
//     setFavoriteIds(new Set(r.noteIds));                           // 이 공간의 내 즐겨찾기 전체 (서버 기준)
//   [앱을 열 때·공간을 받은 뒤] 내 다른 기기에서 바꾼 것도 받기
//     const fav = await listNoteFavorites(supabase, workspaceId);    // Set<note_id>
//     memos.map((m) => ({ ...m, favorite: fav.has(m.id) }))          // MemoCard의 ★, 즐겨찾기 화면 걸러보기
//   즐겨찾기는 동기화 원장에 안 남아서 팀원에게는 보이지 않아요. 휴지통에 간 메모도 별표가 남고, 공간을 나가면 정리돼요
import type { SupabaseClient } from '@supabase/supabase-js';
import { SyncError, toSyncError } from './errors';

export const FAVORITES_MAX_PER_CALL = 500;

/** 선택한 메모가 전부 즐겨찾기면 'remove'(해제), 하나라도 아니면 'add' — 화면 규칙 그대로 */
export function favoriteAction(selected: { favorite?: boolean | null }[]): 'add' | 'remove' {
  return selected.length > 0 && selected.every((m) => !!m.favorite) ? 'remove' : 'add';
}

/** 즐겨찾기 켜기·끄기. 500개 넘으면 나눠서 보냄. 반환: 바뀐 개수 + 이 공간의 내 즐겨찾기 전체 */
export async function setNoteFavorites(
  client: SupabaseClient,
  workspaceId: string,
  noteIds: string[],
  favorite: boolean,
): Promise<{ changed: number; noteIds: string[] }> {
  const ids = [...new Set(noteIds.filter(Boolean))];
  if (!workspaceId) throw new SyncError('INVALID_REQUEST', '공유 공간에서만 서버에 저장해요 (개인 공간은 기기에)');
  if (ids.length === 0) throw new SyncError('INVALID_REQUEST', '메모를 하나 이상 골라 주세요');
  let changed = 0;
  let all: string[] = [];
  for (let i = 0; i < ids.length; i += FAVORITES_MAX_PER_CALL) {
    const { data, error } = await client.rpc('set_note_favorites', {
      p_workspace_id: workspaceId, p_note_ids: ids.slice(i, i + FAVORITES_MAX_PER_CALL), p_favorite: favorite,
    });
    if (error) throw toSyncError(error);
    const r = data as { changed: number; note_ids: string[] };
    changed += r.changed;
    all = r.note_ids;
  }
  return { changed, noteIds: all };
}

/** 내 즐겨찾기 메모 id. workspaceId를 안 주면 내가 멤버인 모든 공유 공간 */
export async function listNoteFavorites(client: SupabaseClient, workspaceId?: string | null): Promise<Set<string>> {
  const { data, error } = await client.rpc('list_note_favorites', { p_workspace_id: workspaceId ?? null });
  if (error) throw toSyncError(error);
  return new Set(((data ?? []) as { note_id: string }[]).map((r) => r.note_id));
}

/** 공간별로 묶어서 (모든 공간을 한 번에 받을 때) */
export async function listNoteFavoritesByWorkspace(client: SupabaseClient): Promise<Map<string, Set<string>>> {
  const { data, error } = await client.rpc('list_note_favorites', { p_workspace_id: null });
  if (error) throw toSyncError(error);
  const out = new Map<string, Set<string>>();
  for (const r of (data ?? []) as { workspace_id: string; note_id: string }[]) {
    if (!out.has(r.workspace_id)) out.set(r.workspace_id, new Set());
    out.get(r.workspace_id)!.add(r.note_id);
  }
  return out;
}

/** 오류 → 화면 문구 */
export function favoriteErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  const text: Record<string, string> = {
    NOT_FOUND: '이 공간에 없는 메모가 섞여 있어요. 동기화한 뒤 다시 시도해 주세요',
    FORBIDDEN: '이 공간의 멤버가 아니에요',
    INVALID_REQUEST: '메모를 하나 이상 골라 주세요',
    NETWORK: '인터넷 연결을 확인해 주세요',
  };
  return text[code] ?? '즐겨찾기를 저장하지 못했어요. 잠시 후 다시 시도해 주세요';
}
