// 공유 공간 · 초대 · 멤버 관리 (서버에는 SHARED 공간만 저장. 개인 기록은 기기 SQLite에만)
//
//  [초대]  OWNER: createInvite → code를 inviteShareText로 공유 (code는 이때만 받을 수 있음)
//          받는 사람: parseInviteCode(입력·링크) → previewInvite로 확인 화면 → acceptInvite
//          참여 후에는 getSnapshot(workspace_id)부터 받기
//  [멤버]  나가기 leaveWorkspace (본인) / 역할 변경 changeMemberRole · 내보내기 removeMember (OWNER)
//          다른 멤버의 변화는 sync_pull에 entity='workspace_members'로 옴 (data = MemberChangeData)
//  [오류]  화면 문구는 memberErrorMessage(err)
import * as Linking from 'expo-linking';
import { SyncError, toSyncError } from './errors';
import { appendInviteCode, effectiveInviteStatus, parseInviteCode } from './invites';
import { requireUserId, supabase } from './supabase';
import type {
  AcceptInviteResult, CreatedInvite, InvitePreview, InviteRole, InviteStatus, InviteSummary,
  MemberStatus, Row, WorkspaceRole,
} from './types';

/** 공유 공간 만들기. 만든 사람이 OWNER가 됨. 설명은 120자까지(선택). 반환값 = workspace_id */
export async function createWorkspace(name: string, description?: string | null): Promise<string> {
  const { data, error } = description
    ? await supabase.rpc('create_workspace', { p_name: name, p_description: description })
    : await supabase.rpc('create_workspace', { p_name: name });
  if (error) throw toSyncError(error);
  return data;
}

export interface MyWorkspace {
  workspace: Row<'workspaces'>;
  role: WorkspaceRole;
  joined_at: string;
}

/** 내가 ACTIVE 멤버인 공간 목록 */
export async function listMyWorkspaces(): Promise<MyWorkspace[]> {
  const uid = await requireUserId();
  const { data, error } = await supabase
    .from('workspace_members')
    .select('role, joined_at, workspace:workspaces(*)')
    .eq('account_id', uid).eq('status', 'ACTIVE');
  if (error) throw toSyncError(error);
  return data
    .filter((m) => m.workspace && !m.workspace.deleted_at)
    .map((m) => ({ workspace: m.workspace!, role: m.role as WorkspaceRole, joined_at: m.joined_at }));
}

export interface Member {
  account_id: string;
  role: WorkspaceRole;
  status: MemberStatus;
  display_name: string | null;
  avatar_path: string | null;
}

/**
 * 공간 멤버 + 프로필 이름 (할 일 담당자 선택, AI 담당자 이름 매칭에 사용)
 *   기본은 나간(LEFT)·내보낸(REMOVED) 사람도 포함 (지난 기록의 담당자 이름 표시용)
 *   멤버 화면·담당자 선택에는 { activeOnly: true }
 */
export async function listMembers(workspaceId: string, opts: { activeOnly?: boolean } = {}): Promise<Member[]> {
  let q = supabase.from('workspace_members').select('account_id, role, status').eq('workspace_id', workspaceId);
  if (opts.activeOnly) q = q.eq('status', 'ACTIVE');
  const { data: members, error } = await q;
  if (error) throw toSyncError(error);

  const ids = members.map((m) => m.account_id);
  const { data: profiles, error: pErr } = ids.length
    ? await supabase.from('profiles').select('account_id, display_name, avatar_path').in('account_id', ids)
    : { data: [], error: null };
  if (pErr) throw toSyncError(pErr);

  return members.map((m) => {
    const p = profiles?.find((x) => x.account_id === m.account_id);
    return {
      account_id: m.account_id,
      role: m.role as WorkspaceRole,
      status: m.status as MemberStatus,
      display_name: p?.display_name ?? null,
      avatar_path: p?.avatar_path ?? null,
    };
  });
}

/** 수정 가능한 역할인지 (VIEWER는 sync_push가 FORBIDDEN) */
export const canEdit = (role: WorkspaceRole) => role === 'OWNER' || role === 'EDITOR';
/** 초대·역할 변경·내보내기·공간 삭제 가능 여부 */
export const canManage = (role: WorkspaceRole) => role === 'OWNER';

// ---------------------------------------------------------------------
// 초대 (OWNER)
// ---------------------------------------------------------------------

/**
 * 초대 코드 만들기
 *   role: EDITOR(멤버, 기본). 앱은 멤버 초대만 씀 (VIEWER는 서버에만 있음) · expiresInHours: 1~720 (기본 168 = 7일) · maxUses: 1~50 (기본 1명)
 *   반환된 code는 다시 조회할 수 없음 → 잃어버리면 새로 만들고 이전 것은 revokeInvite
 */
export async function createInvite(
  workspaceId: string,
  opts: { role?: InviteRole; expiresInHours?: number; maxUses?: number } = {},
): Promise<CreatedInvite> {
  const { data, error } = await supabase.rpc('create_invite', {
    p_workspace_id: workspaceId,
    p_role: opts.role ?? 'EDITOR',
    p_expires_in_hours: opts.expiresInHours ?? 168,
    p_max_uses: opts.maxUses ?? 1,
  });
  if (error) throw toSyncError(error);
  return data as unknown as CreatedInvite;
}

/** 초대 취소. 이미 취소·만료·사용 완료여도 오류 없이 현재 상태를 돌려줌 */
export async function revokeInvite(inviteId: string): Promise<{ invite_id: string; status: InviteStatus }> {
  const { data, error } = await supabase.rpc('revoke_invite', { p_invite_id: inviteId });
  if (error) throw toSyncError(error);
  return data as unknown as { invite_id: string; status: InviteStatus };
}

/** 초대 목록 (OWNER만 보임, 다른 역할은 빈 배열). 기본은 사용 가능한 것만 */
export async function listInvites(workspaceId: string, opts: { includeInactive?: boolean } = {}): Promise<InviteSummary[]> {
  const { data, error } = await supabase
    .from('workspace_invites')
    .select('id, workspace_id, role, status, expires_at, max_uses, use_count, invited_by, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) throw toSyncError(error);
  const now = new Date();
  return data
    .map((r) => ({
      ...r,
      role: r.role as InviteRole,
      status: effectiveInviteStatus(r.status as InviteStatus, r.expires_at, now),
    }))
    .filter((r) => opts.includeInactive || r.status === 'PENDING');
}

/**
 * 초대 링크 (Expo Go: exp://.../--/invite?code=..., 빌드: <scheme>://invite?code=...)
 *   카카오톡 등에서는 앱 전용 링크가 눌리지 않을 수 있으니 코드 입력 화면을 꼭 함께 두세요
 */
export function inviteUrl(code: string): string {
  return appendInviteCode(Linking.createURL('invite'), code);
}

// ---------------------------------------------------------------------
// 초대 받기 (코드를 가진 로그인 사용자)
// ---------------------------------------------------------------------
function requireCode(codeOrUrl: string): string {
  const code = parseInviteCode(codeOrUrl);
  if (!code) throw new SyncError('INVITE_INVALID', '초대 코드 형식이 올바르지 않습니다');
  return code;
}

/** 수락 전 확인: 공간 이름·역할·초대한 사람·인원. 이미 멤버면 already_member */
export async function previewInvite(codeOrUrl: string): Promise<InvitePreview> {
  const { data, error } = await supabase.rpc('preview_invite', { p_code: requireCode(codeOrUrl) });
  if (error) throw toSyncError(error);
  return data as unknown as InvitePreview;
}

/**
 * 참여. 공간 초대 코드와 프로젝트 초대 코드 둘 다 받음 (서버 join_with_invite)
 *   프로젝트 초대면 그 프로젝트에 '팀원'으로 추가됨 (이미 공간 멤버여도) → result.projects
 *   성공하면 getSnapshot(result.workspace_id) 또는 local-sync의 syncNow로 공간 데이터를 받으세요
 */
export async function acceptInvite(codeOrUrl: string): Promise<AcceptInviteResult> {
  const { data, error } = await supabase.rpc('join_with_invite', { p_code: requireCode(codeOrUrl) });
  if (error) throw toSyncError(error);
  return data as unknown as AcceptInviteResult;
}

// ---------------------------------------------------------------------
// 멤버 관리
// ---------------------------------------------------------------------

/** 나가기 (본인). 마지막 소유자면 LAST_OWNER → 다른 멤버를 OWNER로 바꾸거나 deleteWorkspace */
export async function leaveWorkspace(workspaceId: string): Promise<{ workspace_id: string; status: 'LEFT'; seq?: number }> {
  const { data, error } = await supabase.rpc('leave_workspace', { p_workspace_id: workspaceId });
  if (error) throw toSyncError(error);
  return data as unknown as { workspace_id: string; status: 'LEFT'; seq?: number };
}

/**
 * 역할 변경 (관리자만). 앱에서는 OWNER(관리자) ↔ EDITOR(멤버)만 씀 → APP_ROLE['관리자'] / APP_ROLE['멤버']
 *   관리자 넘기기: 상대를 OWNER로 → 본인이 나가거나 EDITOR로 내리기
 */
export async function changeMemberRole(
  workspaceId: string, accountId: string, role: WorkspaceRole,
): Promise<{ workspace_id: string; account_id: string; role: WorkspaceRole; seq?: number; unchanged?: true }> {
  const { data, error } = await supabase.rpc('change_member_role', {
    p_workspace_id: workspaceId, p_account_id: accountId, p_role: role,
  });
  if (error) throw toSyncError(error);
  return data as unknown as { workspace_id: string; account_id: string; role: WorkspaceRole; seq?: number; unchanged?: true };
}

/** 내보내기 (OWNER). 내보낸 사람은 그 뒤에 새로 만든 초대로만 다시 들어올 수 있음 */
export async function removeMember(workspaceId: string, accountId: string): Promise<{ workspace_id: string; account_id: string; status: 'REMOVED'; seq: number }> {
  const { data, error } = await supabase.rpc('remove_member', { p_workspace_id: workspaceId, p_account_id: accountId });
  if (error) throw toSyncError(error);
  return data as unknown as { workspace_id: string; account_id: string; status: 'REMOVED'; seq: number };
}

/** 공간 삭제 (OWNER, 휴지통 처리). 모든 멤버에게서 사라지고 남은 초대는 취소됨 */
export async function deleteWorkspace(workspaceId: string): Promise<{ workspace_id: string; deleted: true }> {
  const { data, error } = await supabase.rpc('delete_workspace', { p_workspace_id: workspaceId });
  if (error) throw toSyncError(error);
  return data as unknown as { workspace_id: string; deleted: true };
}
