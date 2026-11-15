"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectFileChanges = exports.teamChanges = exports.MEMBER_ROLE_MAX = exports.MEMBER_NAME_MAX = exports.ROLE_PRESETS = exports.MEMBER_ROLE = exports.LEADER_ROLE = void 0;
exports.wouldRemoveAllLeaders = wouldRemoveAllLeaders;
exports.isProjectLeader = isProjectLeader;
exports.canManageProject = canManageProject;
exports.getProjectPermissions = getProjectPermissions;
exports.isLeaderConflict = isLeaderConflict;
exports.projectFilesOf = projectFilesOf;
exports.projectOfFile = projectOfFile;
exports.newProjectChanges = newProjectChanges;
exports.membersOf = membersOf;
exports.pendingInvites = pendingInvites;
exports.createProjectInvite = createProjectInvite;
exports.revokeProjectInvite = revokeProjectInvite;
exports.getProjectInviteQuota = getProjectInviteQuota;
exports.projectInviteShareText = projectInviteShareText;
exports.teamErrorMessage = teamErrorMessage;
const errors_1 = require("./errors");
exports.LEADER_ROLE = '팀장';
exports.MEMBER_ROLE = '팀원';
exports.ROLE_PRESETS = [exports.LEADER_ROLE, exports.MEMBER_ROLE];
exports.MEMBER_NAME_MAX = 20;
exports.MEMBER_ROLE_MAX = 12;
function cleanMember(m) {
    const out = { ...m };
    if (m.name !== undefined) {
        const n = String(m.name ?? '').trim();
        if (n.length < 1 || n.length > exports.MEMBER_NAME_MAX)
            throw new errors_1.SyncError('INVALID_NAME', `이름은 1~${exports.MEMBER_NAME_MAX}자로 입력해 주세요`);
        out.name = n;
    }
    if (m.role !== undefined) {
        const r = String(m.role ?? '').trim();
        if (r.length < 1 || r.length > exports.MEMBER_ROLE_MAX)
            throw new errors_1.SyncError('INVALID_ROLE', `역할은 1~${exports.MEMBER_ROLE_MAX}자로 입력해 주세요`);
        out.role = r;
    }
    return out;
}
/** 화면과 같은 규칙: 팀장이 있는데 그 팀장을 모두 지우려 하면 true */
function wouldRemoveAllLeaders(members, pickedIds) {
    const leaders = members.filter((m) => m.role === exports.LEADER_ROLE);
    return leaders.length > 0 && leaders.every((m) => pickedIds.includes(m.id));
}
/** saveLocal에 넣을 팀원 변경 */
exports.teamChanges = {
    /** 팀원 추가 (이름만 있는 팀원, 또는 공간 멤버 계정을 연결) */
    add(id, projectId, m) {
        const c = cleanMember({ name: m.name, role: m.role ?? exports.MEMBER_ROLE });
        return [{ kind: 'create', entity: 'project_members', id, data: {
                    project_id: projectId, name: c.name, role: c.role, account_id: m.accountId ?? null, position: m.position ?? 0
                } }];
    },
    /** 이름·역할 수정 (보낸 칸만 바뀜) */
    edit(id, m) {
        const c = cleanMember(m);
        const data = {};
        if (c.name !== undefined)
            data.name = c.name;
        if (c.role !== undefined)
            data.role = c.role;
        return [{ kind: 'update', entity: 'project_members', id, data }];
    },
    /** 다른 프로젝트로 이동 (같은 공간 안에서만) */
    move(ids, targetProjectId) {
        return ids.map((id) => ({ kind: 'update', entity: 'project_members', id, data: { project_id: targetProjectId } }));
    },
    /** 삭제. 팀장을 모두 지우면 LAST_LEADER ("팀장은 모두 삭제할 수 없어요") */
    remove(members, ids) {
        if (wouldRemoveAllLeaders(members, ids))
            throw new errors_1.SyncError('LAST_LEADER', '팀장은 모두 삭제할 수 없어요');
        return ids.map((id) => ({ kind: 'delete', entity: 'project_members', id }));
    },
};
// ---------------------------------------------------------------------
// 팀장 권한 (#30)
// ---------------------------------------------------------------------
/** 이 사람이 이 프로젝트의 팀장인지 (계정 연결 + 휴지통 아님) */
function isProjectLeader(members, accountId) {
    return members.some((m) => !m.deleted_at && m.account_id === accountId && String(m.role).trim() === exports.LEADER_ROLE);
}
/**
 * 프로젝트를 관리(수정·삭제·팀원·초대)할 수 있는지 — 서버 규칙과 같음
 *   myRole: 공간 역할 (OWNER 관리자 / EDITOR 멤버 / VIEWER)
 *   members: 그 프로젝트 팀원 (membersOf 결과)
 *   activeAccountIds: 지금 공간의 ACTIVE 멤버 계정들 (떠난 팀장은 팀장으로 안 침). 모르면 생략 → 계정 연결된 팀장은 모두 있는 것으로
 */
function canManageProject(p) {
    if (p.myRole === 'OWNER')
        return true;
    if (p.myRole !== 'EDITOR')
        return false;
    if (isProjectLeader(p.members, p.me))
        return true;
    const active = p.activeAccountIds ? new Set(p.activeAccountIds) : null;
    const leaders = p.members.filter((m) => !m.deleted_at && m.account_id && String(m.role).trim() === exports.LEADER_ROLE
        && (!active || active.has(m.account_id)));
    return leaders.length === 0;
}
/** 서버 기준 권한 (공간의 모든 프로젝트): { [projectId]: true|false } */
async function getProjectPermissions(client, workspaceId) {
    const { data, error } = await client.rpc('get_project_permissions', { p_workspace_id: workspaceId });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return (data ?? {});
}
/** 보낸 묶음이 팀장 권한 때문에 막혔는지 (flushOutbox 결과의 conflicts) */
function isLeaderConflict(c) {
    return c?.reason === 'NOT_PROJECT_LEADER';
}
/** saveLocal에 넣을 파일 연결 변경 (업로드가 끝난 첨부만: uploadAttachment로 받은 asset.id) */
exports.projectFileChanges = {
    link(projectId, assetId, position = 0) {
        return [{ kind: 'link', entity: 'project_files', data: { project_id: projectId, asset_id: assetId, position } }];
    },
    unlink(projectId, assetId) {
        return [{ kind: 'unlink', entity: 'project_files', data: { project_id: projectId, asset_id: assetId } }];
    },
    /** 다른 프로젝트로 옮기기 (화면: 다른 프로젝트에 있던 파일을 연결하면 옮겨 옴). fromProjectId가 없으면 연결만 */
    move(assetId, fromProjectId, toProjectId, position = 0) {
        if (fromProjectId === toProjectId)
            return [];
        return [
            ...(fromProjectId ? exports.projectFileChanges.unlink(fromProjectId, assetId) : []),
            ...exports.projectFileChanges.link(toProjectId, assetId, position),
        ];
    },
};
/** listLocal(db, ws, 'project_files') 결과 → 이 프로젝트에 연결된 파일 (순서대로) */
function projectFilesOf(rows, projectId) {
    return rows.map((r) => r.data)
        .filter((f) => f && f.project_id === projectId)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.added_at ?? '').localeCompare(String(b.added_at ?? '')));
}
/** 파일 → 연결된 프로젝트 (화면: "다른 프로젝트에서 옮겨 와요" 표시) */
function projectOfFile(rows, assetId) {
    const f = rows.map((r) => r.data).find((x) => x && x.asset_id === assetId);
    return f?.project_id ?? null;
}
/** 프로젝트를 만들면서 만든 사람을 팀장으로 (한 번에 저장) */
function newProjectChanges(projectId, project, me) {
    return [
        { kind: 'create', entity: 'projects', id: projectId, data: { ...project } },
        ...exports.teamChanges.add(me.memberId, projectId, { name: me.name.slice(0, exports.MEMBER_NAME_MAX) || exports.MEMBER_ROLE, role: exports.LEADER_ROLE, accountId: me.accountId }),
    ];
}
/** listLocal(db, ws, 'project_members') 결과 → 이 프로젝트 팀원 (삭제 제외, 순서대로) */
function membersOf(rows, projectId) {
    return rows.map((r) => r.data)
        .filter((m) => m.project_id === projectId && !m.deleted_at)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name)));
}
/** listLocal(db, ws, 'project_invites') 결과 → 이 프로젝트의 "초대 대기" (기간이 지난 것 제외) */
function pendingInvites(rows, projectId, now = new Date()) {
    return rows.map((r) => r.data)
        .filter((i) => i.project_id === projectId && i.status === 'PENDING' && Date.parse(i.expires_at) > now.getTime())
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
// ---------------------------------------------------------------------
// 초대 (서버 RPC)
// ---------------------------------------------------------------------
const METHOD = { 메일: 'EMAIL', 링크: 'LINK', EMAIL: 'EMAIL', LINK: 'LINK' };
/** 프로젝트 초대 만들기 (공간 관리자·그 프로젝트 팀장, 팀장이 없으면 공간 멤버). code는 이때만 받을 수 있음 */
async function createProjectInvite(client, projectId, opts) {
    const method = METHOD[opts.method];
    if (!method)
        throw new errors_1.SyncError('INVALID_REQUEST', '초대 방법은 메일 또는 링크입니다');
    const { data, error } = await client.rpc('create_project_invite', {
        p_project_id: projectId, p_method: method, p_email: method === 'EMAIL' ? (opts.email ?? '') : null,
        p_expires_in_hours: opts.expiresInHours ?? 168,
    });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return data;
}
/** 초대 취소 (만든 사람·관리자·그 프로젝트 팀장). 여러 번 눌러도 같은 결과 */
async function revokeProjectInvite(client, projectInviteId) {
    const { data, error } = await client.rpc('revoke_project_invite', { p_project_invite_id: projectInviteId });
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return data;
}
/** 이번 달 프로젝트 초대 횟수 (FREE 10 / PRO 50 / TEAM 200) */
async function getProjectInviteQuota(client) {
    const { data, error } = await client.rpc('get_project_invite_quota');
    if (error)
        throw (0, errors_1.toSyncError)(error);
    return data;
}
/** 카톡·문자로 보낼 프로젝트 초대 문구 */
function projectInviteShareText(p) {
    const d = new Date(Date.parse(p.expiresAt) + 9 * 3600_000);
    const lines = [
        `[Stella] '${p.projectName}' 프로젝트에 초대합니다`,
        `앱에서 [공간 참여]를 누르고 코드를 입력하세요: ${p.code}`,
        `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일까지 · 1명`,
    ];
    if (p.url)
        lines.push(`앱이 설치돼 있으면 링크로 바로 열기: ${p.url}`);
    return lines.join('\n');
}
/** 팀원·초대 오류 → 화면 문구 */
function teamErrorMessage(err) {
    const code = err?.code ?? '';
    const msg = String(err?.message ?? '');
    if (code === 'FORBIDDEN' && msg.includes('팀장'))
        return '프로젝트 팀장만 할 수 있어요';
    const text = {
        NOT_PROJECT_LEADER: '프로젝트 팀장만 할 수 있어요. 바꾼 내용은 되돌려졌어요',
        LAST_LEADER: '팀장은 모두 삭제할 수 없어요',
        INVALID_NAME: `이름은 1~${exports.MEMBER_NAME_MAX}자로 입력해 주세요`,
        INVALID_ROLE: `역할은 1~${exports.MEMBER_ROLE_MAX}자로 입력해 주세요`,
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
