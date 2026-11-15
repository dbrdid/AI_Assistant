// ============================================================
// withdraw.ts — 회원 탈퇴 (#33, 11/15) · 설정 > 회원탈퇴 (ROUTES.Withdraw)
//   정책: 공유 기록은 남기고 작성자는 '탈퇴한 사용자', 나머지(계정·설정·구독·기기·백업·녹음 등)는 바로 삭제
//         혼자 OWNER인 공간은 먼저 들어온 편집자에게 넘김(없으면 보기 전용), ACTIVE 멤버가 나뿐이면 공간째 삭제
//   화면 흐름: getWithdrawPreview → 안내(공간별로 어떻게 되는지) → 확인 창 → withdrawAccount (11/15 결정: 비밀번호 재입력·재로그인 없음)
//   개인 공간 기록은 기기에만 있으니 앱이 기기 데이터도 지우세요 (탈퇴 성공 뒤): 기기 저장소 store.clearAll() + local-sync의 clearLocalSync(db)
// RN 의존 없음
// ============================================================

import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError, type SupabaseClient } from '@supabase/supabase-js';
import { StellaError, toSyncError } from './errors';

export const WITHDRAWN_USER_LABEL = '탈퇴한 사용자';

export interface WithdrawPreviewItem {
  workspace_id: string;
  name: string;
  action: 'DELETE' | 'TRANSFER' | 'LEAVE';
  next_owner_id: string | null;
  next_owner_name: string | null;
}

export class WithdrawError extends StellaError {
  constructor(code: string, message: string, status?: number, details?: unknown) {
    super(code, message, status, details);
    this.name = 'WithdrawError';
  }
}

/** 탈퇴하면 내 공간이 어떻게 되는지 (바꾸는 것 없음) */
export async function getWithdrawPreview(client: SupabaseClient): Promise<WithdrawPreviewItem[]> {
  const { data, error } = await client.rpc('account_withdraw_preview');
  if (error) throw toSyncError(error);
  return (data ?? []) as WithdrawPreviewItem[];
}

/** 미리 보기 한 줄 문구 */
export function withdrawPreviewText(item: WithdrawPreviewItem): string {
  switch (item.action) {
    case 'DELETE': return `'${item.name}' 공간은 다른 멤버가 없어서 기록과 함께 삭제돼요`;
    case 'TRANSFER': return `'${item.name}' 공간의 관리자는 ${item.next_owner_name || '다른 멤버'}님에게 넘어가요`;
    default: return `'${item.name}' 공간에서 나가요. 남긴 기록은 '${WITHDRAWN_USER_LABEL}'로 남아요`;
  }
}

/**
 * 탈퇴 실행. 성공하면 로그인도 끝냄 (signOut)
 *   실패(STORAGE_FAILED·AUTH_DELETE_FAILED·NETWORK)는 같은 함수를 다시 부르면 이어서 처리됨
 */
export async function withdrawAccount(client: SupabaseClient): Promise<{
  deleted_workspaces: string[]; owner_moved: { workspace_id: string; owner: string }[]; left: string[];
}> {
  const { data, error } = await client.functions.invoke('account/delete', { body: { confirm: 'DELETE' } });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      let payload: { code?: string; message?: string } | null = null;
      try { payload = await res.json(); } catch { /* 본문 없음 */ }
      throw new WithdrawError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? '탈퇴를 처리하지 못했어요', res.status, payload);
    }
    if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
      throw new WithdrawError('NETWORK', '서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요', undefined, error);
    }
    throw new WithdrawError('UNKNOWN', String((error as Error)?.message ?? error), undefined, error);
  }
  await client.auth.signOut().catch(() => {});   // 서버에서는 이미 지워짐
  return data as Awaited<ReturnType<typeof withdrawAccount>>;
}

export function withdrawErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'AUTH_REQUIRED': return '다시 로그인한 뒤 시도해 주세요';
    case 'STORAGE_FAILED':
    case 'AUTH_DELETE_FAILED': return '탈퇴를 마무리하지 못했어요. [다시 시도]를 눌러 주세요 (이어서 처리돼요)';
    case 'NETWORK': return '인터넷 연결을 확인하고 다시 시도해 주세요';
    default: return '탈퇴를 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요';
  }
}

/** 작성자 이름: 멤버 이름표(account_id → 이름)에 없거나 작성자 칸이 비었으면 '탈퇴한 사용자' */
export function authorName(accountId: string | null | undefined, names: Map<string, string> | Record<string, string>): string {
  if (!accountId) return WITHDRAWN_USER_LABEL;
  const n = names instanceof Map ? names.get(accountId) : names[accountId];
  return n && n.trim() ? n : WITHDRAWN_USER_LABEL;
}
