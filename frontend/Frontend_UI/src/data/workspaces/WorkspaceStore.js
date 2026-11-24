import { useMemo } from 'react';
import { runtime, useValue } from '../hooks';
import * as api from '../../lib/stella/workspaces';
import { supabase } from '../../lib/stella/supabase';
import { colors } from '../../shared/theme/theme';
export const useWorkspaces = () => useValue(() => runtime().store.getWorkspaceState());
export const getWorkspaces = () => runtime().store.getWorkspaces();
export const switchWorkspace = async id => {
  const own = runtime();
  const result = own.store.switchWorkspace(id);
  const ws = own.store.getCurrentWorkspace();
  if (ws && !ws.personal && ws.serverId) {
    await own.bridge.syncWorkspace(ws.id);
  }
  return result;
};

// 공간 색: 개인 공간은 민트, 팀 공간은 목록 순서대로 아래 색 (같은 기기에서는 늘 같은 색)
const TEAM_COLORS = ['#7F77DD', '#E0A030', '#378ADD', '#D4537E', '#639922', '#D85A30'];
export function spaceInfoOf(list) {
  const out = {};
  let n = 0;
  for (const w of list) {
    out[w.id] = { id: w.id, name: w.personal ? '개인' : w.name, fullName: w.name, personal: w.personal, color: w.personal ? colors.mint : TEAM_COLORS[n++ % TEAM_COLORS.length], readOnly: w.roleCode === 'VIEWER' && !w.personal };
  }
  return out;
}
/** { 공간 id: { id, name('개인' 또는 공간 이름), color, personal, readOnly } } */
export function useSpaceInfo() {
  const { list } = useWorkspaces();
  return useMemo(() => spaceInfoOf(list), [list]);
}
/** 그 공간의 화면(편집·프로젝트 등)을 열기 전에: 현재 공간이 아니면 바꿈 */
export function enterSpace(workspaceId) {
  const own = runtime().store;
  if (!workspaceId) return;
  if (own.getCurrentWorkspace().id !== workspaceId) {
    own.switchWorkspace(workspaceId);
  }
  const ws = own.getCurrentWorkspace();
  if (ws && !ws.personal && ws.serverId) {
    void runtime().bridge.syncWorkspace(ws.id);
  }
}
export const listMembers = (serverId) => api.listMembers(serverId, { activeOnly: true });
export const scopedKey = key => `${runtime().session.id}:${runtime().store.getCurrentWorkspace().id}:${key}`;
export async function createWorkspace(fields) {
  const own = runtime();
  const id = await api.createWorkspace(fields.name, fields.desc);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다. 공간 목록을 새로 확인해 주세요');
  own.store.upsertServerWorkspace({ id, name: fields.name, description: fields.desc, role: 'OWNER', members: 1 });
  return id;
}
export async function syncServerWorkspaceConnections() {
  const own = runtime();
  const memberships = await api.listMyWorkspaces();
  let linked = 0;
  for (const membership of memberships) {
    const serverId = membership.workspace.id;
    const name = membership.workspace.name;
    const existing = own.store.getWorkspaces().find(ws =>
      ws.serverId === serverId ||
      (!ws.personal && !ws.serverId && ws.name === name)
    );
    if (existing?.serverId === serverId) {
      own.store.upsertServerWorkspace({
        id: serverId,
        name,
        description: membership.workspace.description ?? '',
        role: membership.role,
        members: 1,
      });
    } else if (existing && !existing.serverId) {
      own.store.linkWorkspace(existing.id, serverId);
      linked += 1;
    } else if (!existing) {
      own.store.upsertServerWorkspace({
        id: serverId,
        name,
        description: membership.workspace.description ?? '',
        role: membership.role,
        members: 1,
      });
      linked += 1;
    }
  }
  await own.bridge.syncAll();
  return { linked, total: memberships.length };
}
export async function testSharedWorkspaceSync() {
  const own = runtime();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const session = sessionData.session;
  if (!session) throw new Error('AUTH_REQUIRED: 로그인이 필요합니다');
  const memberships = await api.listMyWorkspaces();
  const syncs = [];
  for (const ws of own.store.getWorkspaces().filter(w => !w.personal && w.serverId)) {
    const result = await own.bridge.syncWorkspace(ws.id);
    syncs.push({ id: ws.id, serverId: ws.serverId, status: result.status, flush: result.flush?.status, lastError: result.flush?.error ?? result.error ?? null });
  }
  return {
    accountId: session.user.id,
    email: session.user.email ?? '',
    memberships: memberships.map(m => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })),
    syncs,
  };
}
export async function joinWorkspace(value) {
  const own = runtime();
  const r = await api.acceptInvite(typeof value === 'string' ? value : value.code);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  await own.bridge.syncAll(); return r.workspace_id;
}
export async function deleteWorkspace(id) {
  const own = runtime();
  const ws = getWorkspaces().find(w => w.id === id);
  if (!ws || ws.personal) throw new Error('개인 공간은 삭제할 수 없습니다');
  const status = await own.bridge.status();
  if (status.unsent || status.state === 'attention') throw new Error('미전송 기록과 충돌을 해결한 뒤 나가 주세요');
  if (ws.roleCode === 'OWNER') await api.deleteWorkspace(ws.serverId);
  else await api.leaveWorkspace(ws.serverId);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  return own.store.deleteWorkspace(id);
}
