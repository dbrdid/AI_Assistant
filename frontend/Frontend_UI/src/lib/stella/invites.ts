// 초대 코드·공유 문구·역할 이름·오류 문구 (React Native 의존 없음)
//   코드 형식: XXXXX-XXXXX. 헷갈리는 글자(0 O 1 I L)는 쓰지 않음. 대소문자·공백·하이픈은 무시
import { SyncError } from './errors';
import type { InviteStatus, WorkspaceRole } from './types';

export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;

function asCode(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = raw;
  try { s = decodeURIComponent(raw); } catch { /* 그대로 */ }
  const n = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(n) ? `${n.slice(0, 5)}-${n.slice(5)}` : null;
}

/**
 * 입력에서 초대 코드를 꺼내 'XXXXX-XXXXX'로 돌려줌. 못 찾으면 null
 *   - 직접 입력: "abcde fghjk", "ABCDE-FGHJK"
 *   - 링크: "stella://invite?code=ABCDE-FGHJK", "exp://192.168.0.5:8081/--/invite?code=..."
 *   - 공유 메시지를 통째로 붙여넣은 경우
 */
export function parseInviteCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  return asCode(/[?&]code=([^&#\s]+)/i.exec(s)?.[1])
    ?? asCode(/\/invite\/([A-Za-z0-9%-]+)/i.exec(s)?.[1])
    ?? asCode(/(?:^|[^A-Za-z0-9])([A-Za-z0-9]{5}-[A-Za-z0-9]{5})(?![A-Za-z0-9])/.exec(s)?.[1])
    ?? asCode(s);
}

/** 앱 링크 뒤에 코드를 붙임 (base 예: Linking.createURL('invite')) */
export function appendInviteCode(baseUrl: string, code: string): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}`;
}

/**
 * 화면에 쓰는 역할 이름 (프론트 결정 2026-11-15): 관리자 = OWNER, 멤버 = EDITOR
 *   앱은 이 두 역할만 씁니다. 초대·역할 변경도 EDITOR(멤버)·OWNER(관리자)로만 하세요.
 *   VIEWER는 서버에만 남아 있고 앱에서는 만들지 않아요 (혹시 보이면 '보기 전용')
 */
export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: '관리자',
  EDITOR: '멤버',
  VIEWER: '보기 전용',
};
export type AppRoleName = '관리자' | '멤버';
/** 화면 이름 → 서버 역할 */
export const APP_ROLE: Record<AppRoleName, Exclude<WorkspaceRole, 'VIEWER'>> = { 관리자: 'OWNER', 멤버: 'EDITOR' };
export const roleLabel = (role: WorkspaceRole) => ROLE_LABEL[role];
/** 관리자면 공간 '삭제', 멤버면 '나가기' 메뉴 (WorkspaceScreen과 같은 기준) */
export const isAdmin = (role: WorkspaceRole) => role === 'OWNER';

/** "11월 17일 오후 3:00" (한국 시간 기준, Intl 없이 계산) */
export function koreanDateTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  const h = d.getUTCHours();
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${ampm} ${h12}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 카톡·문자로 보낼 초대 문구 (React Native의 Share.share({ message })에 그대로) */
export function inviteShareText(p: {
  workspaceName: string;
  code: string;
  role: WorkspaceRole;
  expiresAt: string;
  url?: string | null;
}): string {
  const lines = [
    `[Stella] '${p.workspaceName}' 공간에 초대합니다`,
    `앱에서 [공간 참여]를 누르고 코드를 입력하세요: ${p.code}`,
    `${ROLE_LABEL[p.role]} · ${koreanDateTime(p.expiresAt)}까지`,
  ];
  if (p.url) lines.push(`앱이 설치돼 있으면 링크로 바로 열기: ${p.url}`);
  return lines.join('\n');
}

/** 기간이 지났지만 아직 PENDING으로 남은 초대는 EXPIRED로 */
export function effectiveInviteStatus(status: InviteStatus, expiresAt: string, now: Date = new Date()): InviteStatus {
  return status === 'PENDING' && Date.parse(expiresAt) <= now.getTime() ? 'EXPIRED' : status;
}

/** 공간·멤버·초대 관련 오류 → 화면 문구 */
export function memberErrorMessage(err: unknown): string {
  if (!(err instanceof SyncError)) return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요';
  const text: Record<string, string> = {
    INVITE_INVALID: '초대 코드를 다시 확인해 주세요',
    INVITE_EXPIRED: '기간이 지난 초대예요. 새 초대를 요청해 주세요',
    INVITE_REVOKED: '취소된 초대예요. 새 초대를 요청해 주세요',
    INVITE_USED_UP: '정해진 인원이 모두 참여한 초대예요. 새 초대를 요청해 주세요',
    INVITE_BLOCKED: '이 공간에서 내보내져서 이 초대로는 들어갈 수 없어요. 관리자에게 새 초대를 요청해 주세요',
    LAST_OWNER: '마지막 관리자는 나가거나 역할을 바꿀 수 없어요. 다른 멤버를 관리자로 지정하거나 공간을 삭제해 주세요',
    TOO_MANY_INVITES: '사용 가능한 초대가 너무 많아요. 안 쓰는 초대를 취소한 뒤 다시 만들어 주세요',
    NOT_FOUND: '공간이나 멤버를 찾을 수 없어요. 목록을 새로고침해 주세요',
    AUTH_REQUIRED: '로그인이 필요해요',
  };
  // FORBIDDEN 등은 서버 문구가 상황별로 달라서 역할 이름만 바꿔 씀 (예: "OWNER만 초대할 수 있습니다" → "관리자만 …")
  return text[err.code] ?? err.message.replace(/OWNER/g, '관리자').replace(/EDITOR/g, '멤버').replace(/VIEWER/g, '보기 전용 멤버');
}
