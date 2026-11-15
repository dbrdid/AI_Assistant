// ============================================================
// invite-mail.ts — 초대 메일 보내기 (#35, 11/15)
//   공간 초대·프로젝트 메일 초대 모두. 코드는 만들 때 한 번만 오므로 만든 직후에 보내세요
//     프로젝트: const inv = await createProjectInvite(supabase, projectId, { method: '메일', email })
//               await sendInviteMail(supabase, { code: inv.code })          // 초대에 적힌 주소로 감
//     공간:     const inv = await createInvite(...)
//               await sendInviteMail(supabase, { code: inv.code, email })   // 받는 주소를 같이
//   서버에 메일 설정(SMTP_PASSWORD)이 아직 없거나 한도를 넘으면 shouldShareInstead(e) → 지금처럼 Share.share(공유 문구)
//   한도: 한 사람 하루 30통, 같은 초대·같은 주소는 10분에 한 번
// RN 의존 없음
// ============================================================

import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError, type SupabaseClient } from '@supabase/supabase-js';
import { StellaError, toSyncError } from './errors';

export class InviteMailError extends StellaError {
  constructor(code: string, message: string, status?: number, details?: unknown) {
    super(code, message, status, details);
    this.name = 'InviteMailError';
  }
}

export async function sendInviteMail(
  client: SupabaseClient,
  p: { code: string; email?: string | null },
): Promise<{ email: string; kind: 'WORKSPACE' | 'PROJECT' }> {
  const { data, error } = await client.functions.invoke('invite-mail/send', { body: { code: p.code, email: p.email ?? null } });
  if (!error) return data as { email: string; kind: 'WORKSPACE' | 'PROJECT' };
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    let payload: { code?: string; message?: string } | null = null;
    try { payload = await res.json(); } catch { /* 본문 없음 */ }
    throw new InviteMailError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? '메일을 보내지 못했어요', res.status, payload);
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    throw new InviteMailError('NETWORK', '서버에 연결하지 못했어요', undefined, error);
  }
  throw new InviteMailError('UNKNOWN', String((error as Error)?.message ?? error), undefined, error);
}

/** 오늘 남은 초대 메일 { limit, used, remaining } */
export async function getInviteMailQuota(client: SupabaseClient): Promise<{ limit: number; used: number; remaining: number }> {
  const { data, error } = await client.rpc('get_invite_mail_quota');
  if (error) throw toSyncError(error);
  return data as { limit: number; used: number; remaining: number };
}

/** 메일 대신 공유 문구로 보내야 하는 경우 (설정 없음·한도·SMTP 오류·연결 안 됨) */
export function shouldShareInstead(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? '';
  return ['MAIL_NOT_CONFIGURED', 'MAIL_LIMIT', 'MAIL_FAILED', 'NETWORK', 'SERVER_ERROR'].includes(code);
}

export function inviteMailErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  const text: Record<string, string> = {
    MAIL_NOT_CONFIGURED: '메일 발송이 아직 준비 중이에요. 공유하기로 보내 주세요',
    MAIL_LIMIT: '오늘 보낼 수 있는 초대 메일을 모두 보냈어요. 공유하기로 보내 주세요',
    MAIL_TOO_SOON: '방금 보낸 초대예요. 10분 뒤에 다시 보낼 수 있어요',
    MAIL_FAILED: '메일을 보내지 못했어요. 잠시 뒤 다시 시도하거나 공유하기로 보내 주세요',
    INVALID_EMAIL: '이메일 형식이 올바르지 않아요. 예) name@example.com',
    FORBIDDEN: '초대를 만든 사람만 메일을 보낼 수 있어요',
    INVITE_REVOKED: '취소된 초대예요',
    INVITE_EXPIRED: '기간이 지난 초대예요. 새로 만들어 주세요',
    INVITE_USED_UP: '이미 참여가 끝난 초대예요',
    INVITE_INVALID: '초대를 찾을 수 없어요',
    NETWORK: '인터넷 연결을 확인해 주세요',
  };
  return text[code] ?? '메일을 보내지 못했어요';
}

/** "초대 대기" 줄 문구: 메일 보냄 표시 (project_invites.mailed_at) */
export function inviteMailBadge(invite: { email?: string | null; mailed_at?: string | null }): string | null {
  if (!invite.email) return null;
  return invite.mailed_at ? '메일 보냄' : '메일 안 보냄';
}
