// 프로젝트 팀원 · 프로젝트 초대 (프론트 화면 기준, 2026-11-15) — React Native 의존 없음
//   서버: migration 25 project_team (project_members · project_invites · create_project_invite · join_with_invite)
//
//   [팀원 관리 화면 TeamScreen]
//     const rows = await listLocal(db, ws, 'project_members');  const members = membersOf(rows, projectId);
//     편집:  saveLocal(ctx, teamChanges.edit(id, { name, role }))
//     이동:  saveLocal(ctx, teamChanges.move(pickedIds, otherProjectId))
//     삭제:  saveLocal(ctx, teamChanges.remove(members, pickedIds))   // 팀장을 모두 지우면 LAST_LEADER (화면과 같은 규칙)
//     → syncNow(ctx)
//   [프로젝트 만들기] saveLocal(ctx, newProjectChanges(projectId, { name }, { accountId: me, name: 내 이름 }))  // 만든 사람 = 팀장
//   [팀원 초대 ProjectInviteScreen]
//     const q = await getProjectInviteQuota(supabase);   // "이번 달 남은 초대 횟수 q.remaining / q.limit"
//     const inv = await createProjectInvite(supabase, projectId, { method: '메일', email });   // 또는 '링크'
//     Share.share({ message: projectInviteShareText({ projectName, code: inv.code, expiresAt: inv.expires_at, url }) })
//     (메일 실제 발송은 아직 없음: 코드를 공유 문구로 보냄)
//   [초대 대기 목록] pendingInvites(listLocal(db, ws, 'project_invites') 결과, projectId)
//   [초대받은 사람] acceptInvite(code) (workspaces.ts) → 공간 참여 + 초대받은 프로젝트에 '팀원'으로 추가
//
//   [팀장 권한 #30, 11/15] 프로젝트 수정·삭제, 팀원 추가·수정·이동·삭제, 프로젝트 초대는 그 프로젝트 '팀장'(계정 연결) + 공간 관리자만
//     팀장(계정 연결된 멤버)이 없는 프로젝트는 지금처럼 공간 편집자 누구나. 메모·할 일·파일 연결은 지금처럼 공간 권한
//     버튼 숨기기: canManageProject({ me, myRole, members: membersOf(rows, projectId), activeAccountIds })  (기기에서 바로)
//                 또는 getProjectPermissions(supabase, ws) → { [projectId]: boolean }  (서버 기준)
//     권한 없이 보낸 수정은 서버가 충돌(reason NOT_PROJECT_LEADER)로 돌려줌 → resolveConflict(ctx, seq, 'use_server')
//   [프로젝트에 파일 직접 연결 #29] saveLocal(ctx, projectFileChanges.link(projectId, assetId))
//     해제: projectFileChanges.unlink(projectId, assetId) / 다른 프로젝트로: projectFileChanges.move(assetId, fromId, toId)
//     목록: projectFilesOf(listLocal(db, ws, 'project_files') 결과, projectId) → asset_id 순서대로
import type { SupabaseClient } from '@supabase/supabase-js';
import { SyncError, toSyncError } from './errors';
import type { LocalChange } from './local-sync';

export const LEADER_ROLE = '팀장';
export const MEMBER_ROLE = '팀원';
export const ROLE_PRESETS = [LEADER_ROLE, MEMBER_ROLE] as const;
export const MEMBER_NAME_MAX = 20;
export const MEMBER_ROLE_MAX = 12;

/** 서버 project_members 행 (sync_pull·snapshot data) */
export interface ProjectMember {
  id: string;
  workspace_id: string;
  project_id: string;
  account_id: string | null;   // 초대로 들어온 계정. null이면 이름만 있는 팀원
  name: string;
  role: string;                // 팀장·팀원·직접 입력 (권한 아님)
  position: number;
  revision: number;
  deleted_at: string | null;
}
export interface ProjectInviteRow {
  id: string;
  workspace_id: string;
  project_id: string;
  method: 'EMAIL' | 'LINK';
  email: string | null;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  expires_at: string;
  created_by: string;
  created_at: string;
  accepted_by: string | null;
  member_id: string | null;
}
export interface InviteQuota { plan: 'FREE' | 'PRO' | 'TEAM'; limit: number; used: number; remaining: number; period_start: string }
export interface CreatedProjectInvite {
  project_invite_id: string;
  project_id: string;
  workspace_id: string;
  code: string;                // 'XXXXX-XXXXX' — 이때만 받을 수 있음
  method: 'EMAIL' | 'LINK';
  email: string | null;
  expires_at: string;
  quota: InviteQuota;
}

// ---------------------------------------------------------------------
// 화면 규칙
// ---------------------------------------------------------------------
type Named = { name?: string | null; role?: string | null };
function cleanMember<T extends Named>(m: T): T {
  const out = { ...m };
  if (m.name !== undefined) {
    const n = String(m.name ?? '').trim();
    if (n.length < 1 || n.length > MEMBER_NAME_MAX) throw new SyncError('INVALID_NAME', `이름은 1~${MEMBER_NAME_MAX}자로 입력해 주세요`);
    out.name = n;
  }
  if (m.role !== undefined) {
    const r = String(m.role ?? '').trim();
    if (r.length < 1 || r.length > MEMBER_ROLE_MAX) throw new SyncError('INVALID_ROLE', `역할은 1~${MEMBER_ROLE_MAX}자로 입력해 주세요`);
    out.role = r;
  }
  return out;
}

/** 화면과 같은 규칙: 팀장이 있는데 그 팀장을 모두 지우려 하면 true */
export function wouldRemoveAllLeaders(members: Pick<ProjectMember, 'id' | 'role'>[], pickedIds: string[]): boolean {
  const leaders = members.filter((m) => m.role === LEADER_ROLE);
  return leaders.length > 0 && leaders.every((m) => pickedIds.includes(m.id));
}

/** saveLocal에 넣을 팀원 변경 */
export const teamChanges = {
  /** 팀원 추가 (이름만 있는 팀원, 또는 공간 멤버 계정을 연결) */
  add(id: string, projectId: string, m: { name: string; role?: string; accountId?: string | null; position?: number }): LocalChange[] {
    const c = cleanMember({ name: m.name, role: m.role ?? MEMBER_ROLE });
    return [{ kind: 'create', entity: 'project_members', id, data: {
      project_id: projectId, name: c.name, role: c.role, account_id: m.accountId ?? null, position: m.position ?? 0 } }];
  },
  /** 이름·역할 수정 (보낸 칸만 바뀜) */
  edit(id: string, m: { name?: string; role?: string }): LocalChange[] {
    const c = cleanMember(m);
    const data: Record<string, unknown> = {};
    if (c.name !== undefined) data.name = c.name;
    if (c.role !== undefined) data.role = c.role;
    return [{ kind: 'update', entity: 'project_members', id, data }];
  },
  /** 다른 프로젝트로 이동 (같은 공간 안에서만) */
  move(ids: string[], targetProjectId: string): LocalChange[] {
    return ids.map((id) => ({ kind: 'update', entity: 'project_members', id, data: { project_id: targetProjectId } }));
  },
  /** 삭제. 팀장을 모두 지우면 LAST_LEADER ("팀장은 모두 삭제할 수 없어요") */
  remove(members: Pick<ProjectMember, 'id' | 'role'>[], ids: string[]): LocalChange[] {
    if (wouldRemoveAllLeaders(members, ids)) throw new SyncError('LAST_LEADER', '팀장은 모두 삭제할 수 없어요');
    return ids.map((id) => ({ kind: 'delete', entity: 'project_members', id }));
  },
};

// ---------------------------------------------------------------------
// 팀장 권한 (#30)
// ---------------------------------------------------------------------
/** 이 사람이 이 프로젝트의 팀장인지 (계정 연결 + 휴지통 아님) */
export function isProjectLeader(members: Pick<ProjectMember, 'account_id' | 'role' | 'deleted_at'>[], accountId: string): boolean {
  return members.some((m) => !m.deleted_at && m.account_id === accountId && String(m.role).trim() === LEADER_ROLE);
}

/**
 * 프로젝트를 관리(수정·삭제·팀원·초대)할 수 있는지 — 서버 규칙과 같음
 *   myRole: 공간 역할 (OWNER 관리자 / EDITOR 멤버 / VIEWER)
 *   members: 그 프로젝트 팀원 (membersOf 결과)
 *   activeAccountIds: 지금 공간의 ACTIVE 멤버 계정들 (떠난 팀장은 팀장으로 안 침). 모르면 생략 → 계정 연결된 팀장은 모두 있는 것으로
 */
export function canManageProject(p: {
  me: string;
  myRole: 'OWNER' | 'EDITOR' | 'VIEWER' | string;
  members: Pick<ProjectMember, 'account_id' | 'role' | 'deleted_at'>[];
  activeAccountIds?: Iterable<string> | null;
}): boolean {
  if (p.myRole === 'OWNER') return true;
  if (p.myRole !== 'EDITOR') return false;
  if (isProjectLeader(p.members, p.me)) return true;
  const active = p.activeAccountIds ? new Set(p.activeAccountIds) : null;
  const leaders = p.members.filter((m) => !m.deleted_at && m.account_id && String(m.role).trim() === LEADER_ROLE
    && (!active || active.has(m.account_id)));
  return leaders.length === 0;
}

/** 서버 기준 권한 (공간의 모든 프로젝트): { [projectId]: true|false } */
export async function getProjectPermissions(client: SupabaseClient, workspaceId: string): Promise<Record<string, boolean>> {
  const { data, error } = await client.rpc('get_project_permissions', { p_workspace_id: workspaceId });
  if (error) throw toSyncError(error);
  return (data ?? {}) as Record<string, boolean>;
}

/** 보낸 묶음이 팀장 권한 때문에 막혔는지 (flushOutbox 결과의 conflicts) */
export function isLeaderConflict(c: { reason?: string } | null | undefined): boolean {
  return c?.reason === 'NOT_PROJECT_LEADER';
}

// ---------------------------------------------------------------------
// 프로젝트 ↔ 파일 직접 연결 (#29)
// ---------------------------------------------------------------------
export interface ProjectFileRow { workspace_id: string; project_id: string; asset_id: string; position: number; added_by: string; added_at: string }

/** saveLocal에 넣을 파일 연결 변경 (업로드가 끝난 첨부만: uploadAttachment로 받은 asset.id) */
export const projectFileChanges = {
  link(projectId: string, assetId: string, position = 0): LocalChange[] {
    return [{ kind: 'link', entity: 'project_files', data: { project_id: projectId, asset_id: assetId, position } }];
  },
  unlink(projectId: string, assetId: string): LocalChange[] {
    return [{ kind: 'unlink', entity: 'project_files', data: { project_id: projectId, asset_id: assetId } }];
  },
  /** 다른 프로젝트로 옮기기 (화면: 다른 프로젝트에 있던 파일을 연결하면 옮겨 옴). fromProjectId가 없으면 연결만 */
  move(assetId: string, fromProjectId: string | null | undefined, toProjectId: string, position = 0): LocalChange[] {
    if (fromProjectId === toProjectId) return [];
    return [
      ...(fromProjectId ? projectFileChanges.unlink(fromProjectId, assetId) : []),
      ...projectFileChanges.link(toProjectId, assetId, position),
    ];
  },
};

/** listLocal(db, ws, 'project_files') 결과 → 이 프로젝트에 연결된 파일 (순서대로) */
export function projectFilesOf(rows: { data: unknown }[], projectId: string): ProjectFileRow[] {
  return rows.map((r) => r.data as ProjectFileRow)
    .filter((f) => f && f.project_id === projectId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.added_at ?? '').localeCompare(String(b.added_at ?? '')));
}

/** 파일 → 연결된 프로젝트 (화면: "다른 프로젝트에서 옮겨 와요" 표시) */
export function projectOfFile(rows: { data: unknown }[], assetId: string): string | null {
  const f = rows.map((r) => r.data as ProjectFileRow).find((x) => x && x.asset_id === assetId);
  return f?.project_id ?? null;
}

/** 프로젝트를 만들면서 만든 사람을 팀장으로 (한 번에 저장) */
export function newProjectChanges(
  projectId: string,
  project: { name: string; description?: string | null; [k: string]: unknown },
  me: { accountId: string; name: string; memberId: string },
): LocalChange[] {
  return [
    { kind: 'create', entity: 'projects', id: projectId, data: { ...project } },
    ...teamChanges.add(me.memberId, projectId, { name: me.name.slice(0, MEMBER_NAME_MAX) || MEMBER_ROLE, role: LEADER_ROLE, accountId: me.accountId }),
  ];
}

/** listLocal(db, ws, 'project_members') 결과 → 이 프로젝트 팀원 (삭제 제외, 순서대로) */
export function membersOf(rows: { data: unknown }[], projectId: string): ProjectMember[] {
  return rows.map((r) => r.data as ProjectMember)
    .filter((m) => m.project_id === projectId && !m.deleted_at)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name)));
}

/** listLocal(db, ws, 'project_invites') 결과 → 이 프로젝트의 "초대 대기" (기간이 지난 것 제외) */
export function pendingInvites(rows: { data: unknown }[], projectId: string, now: Date = new Date()): ProjectInviteRow[] {
  return rows.map((r) => r.data as ProjectInviteRow)
    .filter((i) => i.project_id === projectId && i.status === 'PENDING' && Date.parse(i.expires_at) > now.getTime())
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

// ---------------------------------------------------------------------
// 초대 (서버 RPC)
// ---------------------------------------------------------------------
const METHOD: Record<string, 'EMAIL' | 'LINK'> = { 메일: 'EMAIL', 링크: 'LINK', EMAIL: 'EMAIL', LINK: 'LINK' };

/** 프로젝트 초대 만들기 (공간 관리자·그 프로젝트 팀장, 팀장이 없으면 공간 멤버). code는 이때만 받을 수 있음 */
export async function createProjectInvite(
  client: SupabaseClient,
  projectId: string,
  opts: { method: '메일' | '링크' | 'EMAIL' | 'LINK'; email?: string | null; expiresInHours?: number },
): Promise<CreatedProjectInvite> {
  const method = METHOD[opts.method];
  if (!method) throw new SyncError('INVALID_REQUEST', '초대 방법은 메일 또는 링크입니다');
  const { data, error } = await client.rpc('create_project_invite', {
    p_project_id: projectId, p_method: method, p_email: method === 'EMAIL' ? (opts.email ?? '') : null,
    p_expires_in_hours: opts.expiresInHours ?? 168,
  });
  if (error) throw toSyncError(error);
  return data as CreatedProjectInvite;
}

/** 초대 취소 (만든 사람·관리자·그 프로젝트 팀장). 여러 번 눌러도 같은 결과 */
export async function revokeProjectInvite(client: SupabaseClient, projectInviteId: string): Promise<{ status: string }> {
  const { data, error } = await client.rpc('revoke_project_invite', { p_project_invite_id: projectInviteId });
  if (error) throw toSyncError(error);
  return data as { status: string };
}

/** 이번 달 프로젝트 초대 횟수 (FREE 10 / PRO 50 / TEAM 200) */
export async function getProjectInviteQuota(client: SupabaseClient): Promise<InviteQuota> {
  const { data, error } = await client.rpc('get_project_invite_quota');
  if (error) throw toSyncError(error);
  return data as InviteQuota;
}

/** 카톡·문자로 보낼 프로젝트 초대 문구 */
export function projectInviteShareText(p: { projectName: string; code: string; expiresAt: string; url?: string | null }): string {
  const d = new Date(Date.parse(p.expiresAt) + 9 * 3600_000);
  const lines = [
    `[Stella] '${p.projectName}' 프로젝트에 초대합니다`,
    `앱에서 [공간 참여]를 누르고 코드를 입력하세요: ${p.code}`,
    `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일까지 · 1명`,
  ];
  if (p.url) lines.push(`앱이 설치돼 있으면 링크로 바로 열기: ${p.url}`);
  return lines.join('\n');
}

/** 팀원·초대 오류 → 화면 문구 */
export function teamErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  const msg = String((err as { message?: string } | null)?.message ?? '');
  if (code === 'FORBIDDEN' && msg.includes('팀장')) return '프로젝트 팀장만 할 수 있어요';
  const text: Record<string, string> = {
    NOT_PROJECT_LEADER: '프로젝트 팀장만 할 수 있어요. 바꾼 내용은 되돌려졌어요',
    LAST_LEADER: '팀장은 모두 삭제할 수 없어요',
    INVALID_NAME: `이름은 1~${MEMBER_NAME_MAX}자로 입력해 주세요`,
    INVALID_ROLE: `역할은 1~${MEMBER_ROLE_MAX}자로 입력해 주세요`,
    INVALID_EMAIL: '이메일 형식이 올바르지 않아요. 예) name@example.com',
    INVITE_LIMIT: '이번 달 초대 횟수를 모두 사용했어요.',
    ALREADY_INVITED: '이미 초대한 이메일이에요',
    TOO_MANY_INVITES: '사용 가능한 초대가 너무 많아요. 안 쓰는 초대를 취소한 뒤 다시 만들어 주세요',
    FORBIDDEN: '보기 전용 멤버는 할 수 없어요',
    NOT_FOUND: '프로젝트를 찾을 수 없어요',
    DUPLICATE: '이미 이 프로젝트의 팀원이에요',
  };
  return text[code] ?? '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요';
}
