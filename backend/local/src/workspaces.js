import { fail } from './errors.js';
import { LIMITS, id, onlyKeys, text, uuid } from './validate.js';

/**
 * 워크스페이스. 개인 공간은 이 기기에만 있고, 그 밖의 공간은 서버(Supabase)의 공유 공간입니다.
 *   server_id: 서버 공간 id. 기기에서 먼저 만든 공간은 서버에 만든 뒤 linkWorkspace로 채움
 *   role: 서버의 내 역할 (OWNER 관리자 · EDITOR 멤버 · VIEWER 보기 전용), member_count: 멤버 수
 * 서버 호출(만들기·초대 수락·나가기·삭제)은 앱의 workspaces.ts·invites.ts가 하고, 결과를 여기에 적습니다.
 */
export const ROLE_LABELS = Object.freeze({ OWNER: '관리자', EDITOR: '멤버', VIEWER: '보기 전용' });
const COLUMNS = 'id,server_id,name,description,personal,role,member_count,created_at';

function toWorkspace(row) {
  return {
    id: row.id, name: row.name, desc: row.description, personal: row.personal === 1, createdAt: row.created_at,
    serverId: row.server_id,            // 서버 공간 id (개인 공간·아직 서버에 안 만든 공간은 null)
    roleCode: row.role,                 // 'OWNER' | 'EDITOR' | 'VIEWER'
    role: ROLE_LABELS[row.role],        // 화면 글자: WorkspaceScreen이 '관리자'인지 봄
    members: row.member_count,
  };
}

export function listWorkspaces(ctx) {
  return ctx.db.getAllSync(`select ${COLUMNS} from workspaces order by personal desc, created_at, id`).map(r => ctx.freeze(toWorkspace(r)));
}

export function workspaceRow(ctx, workspaceId) {
  return ctx.db.getFirstSync(`select ${COLUMNS} from workspaces where id=?`, [workspaceId]);
}

const personalId = ctx => ctx.db.getFirstSync('select id from workspaces where personal=1').id;

/** 기억해 둔 현재 워크스페이스, 없으면 개인 공간 */
export function loadCurrent(ctx) {
  const saved = ctx.db.getFirstSync("select value from settings where key='current_workspace'");
  if (saved && workspaceRow(ctx, saved.value)) return saved.value;
  return personalId(ctx);
}

/**
 * 공유 공간을 기기에 만들고 id를 돌려줌 (전환하지는 않음). 이름은 서버처럼 겹쳐도 됨.
 * 서버에 create_workspace로 만든 뒤 linkWorkspace(id, 서버 id)를 부르면 그동안 쌓인 변경이 올라감.
 */
export function createWorkspace(ctx, input) {
  onlyKeys(input, ['name', 'desc']);
  const name = text(input.name, 'name', LIMITS.workspaceName, { required: true }).trim();
  const desc = text(input.desc ?? '', 'desc', LIMITS.workspaceDesc);
  const workspaceId = ctx.newId();
  ctx.db.runSync("insert into workspaces(id,name,description,personal,role,member_count,created_at) values(?,?,?,0,'OWNER',1,?)", [workspaceId, name, desc, ctx.now()]);
  ctx.touch('workspaces');
  return workspaceId;
}

/** 기기에서 만든 공간에 서버 공간 id를 연결 */
export function linkWorkspace(ctx, workspaceId, serverId) {
  id(workspaceId);
  const server = uuid(serverId, 'serverId');
  const row = workspaceRow(ctx, workspaceId) ?? fail('not_found');
  if (row.personal === 1) fail('personal_workspace');
  if (row.server_id === server) return workspaceId;
  if (row.server_id !== null || ctx.db.getFirstSync('select 1 as ok from workspaces where server_id=?', [server])) fail('invalid_input', 'serverId');
  ctx.db.runSync('update workspaces set server_id=? where id=?', [server, workspaceId]);
  ctx.touch('workspaces');
  ctx.touch('outbox');
  return workspaceId;
}

/**
 * 서버 공간을 기기에 넣거나 고침 (초대 수락·전체 받기·멤버 변경 뒤). 기기 id를 돌려줌.
 * input: { id(서버 공간 id), name, description, role, members }. 처음 보는 공간은 서버 id를 기기 id로 씀.
 */
export function upsertServerWorkspace(ctx, input) {
  onlyKeys(input, ['id', 'name', 'description', 'role', 'members']);
  const server = uuid(input.id, 'id');
  const existing = ctx.db.getFirstSync(`select ${COLUMNS} from workspaces where server_id=? or (id=? and personal=0)`, [server, server]);
  const name = 'name' in input ? text(input.name, 'name', LIMITS.workspaceName, { required: true }) : existing?.name ?? fail('invalid_input', 'name');
  const description = 'description' in input ? text(input.description ?? '', 'description', LIMITS.workspaceDesc) : existing?.description ?? '';
  const role = 'role' in input ? input.role : existing?.role ?? 'EDITOR';
  if (!(role in ROLE_LABELS)) fail('invalid_input', 'role');
  const members = 'members' in input ? input.members : existing?.member_count ?? 1;
  if (!Number.isSafeInteger(members) || members < 1) fail('invalid_input', 'members');
  if (existing) {
    if (existing.name !== name || existing.description !== description || existing.role !== role || existing.member_count !== members || existing.server_id !== server) {
      ctx.db.runSync('update workspaces set server_id=?,name=?,description=?,role=?,member_count=? where id=?', [server, name, description, role, members, existing.id]);
      ctx.touch('workspaces');
    }
    return existing.id;
  }
  ctx.db.runSync('insert into workspaces(id,server_id,name,description,personal,role,member_count,created_at) values(?,?,?,?,0,?,?,?)', [server, server, name, description, role, members, ctx.now()]);
  ctx.touch('workspaces');
  return server;
}

/**
 * 화면이 넘기는 초대 수락 결과를 기기에 넣음 (WorkspaceInviteScreen의 joinWorkspace). 기기 id를 돌려줌.
 * 서버의 accept_invite가 돌려준 공간 id가 꼭 있어야 함: { id, name, desc, role('멤버'·'관리자' 또는 서버 값), members }
 */
export function joinWorkspace(ctx, input) {
  onlyKeys(input, ['id', 'name', 'desc', 'description', 'role', 'members']);
  const label = input.role ?? 'EDITOR';
  const role = label in ROLE_LABELS ? label : Object.keys(ROLE_LABELS).find(code => ROLE_LABELS[code] === label) ?? fail('invalid_input', 'role');
  return upsertServerWorkspace(ctx, {
    id: input.id, role,
    ...('name' in input ? { name: input.name } : {}),
    ...('desc' in input || 'description' in input ? { description: input.desc ?? input.description } : {}),
    ...('members' in input ? { members: input.members } : {}),
  });
}

/** 현재 워크스페이스를 바꿈. 다시 켜도 기억함. 화면이 쓰는 'personal'은 개인 공간으로 읽음 */
export function switchWorkspace(ctx, workspaceId) {
  id(workspaceId);
  if (workspaceId === 'personal') workspaceId = personalId(ctx);
  if (!workspaceRow(ctx, workspaceId)) fail('not_found');
  if (workspaceId === ctx.ws()) return workspaceId;
  ctx.db.runSync("insert into settings(key,value) values('current_workspace',?) on conflict(key) do update set value=excluded.value", [workspaceId]);
  ctx.setWs(workspaceId);
  ctx.touch('all');
  return workspaceId;
}

/**
 * 워크스페이스를 기기에서 지움 (메모·일정·제안·안 보낸 변경 포함). 개인 공간은 지울 수 없음.
 * 공유 공간은 서버에서 삭제(관리자)·나가기(멤버)를 마친 뒤에 부르세요. 현재 공간이면 개인 공간으로 전환함.
 */
export function deleteWorkspace(ctx, workspaceId) {
  id(workspaceId);
  const row = workspaceRow(ctx, workspaceId) ?? fail('not_found');
  if (row.personal === 1) fail('personal_workspace');
  if (workspaceId === ctx.ws()) switchWorkspace(ctx, personalId(ctx));
  ctx.db.runSync('delete from workspaces where id=?', [workspaceId]);
  ctx.touch('workspaces');
  return true;
}
