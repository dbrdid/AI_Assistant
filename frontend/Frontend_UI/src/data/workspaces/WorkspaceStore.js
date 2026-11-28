import { useMemo } from 'react';
import { runtime, useValue } from '../hooks';
import * as api from '../../lib/stella/workspaces';
import { colors } from '../../shared/theme/theme';
export const useWorkspaces = () => useValue(() => runtime().store.getWorkspaceState());
export const useWorkspaceAccessClosed = id => useValue(() => runtime().closedSpaces.has(id));
export const getWorkspaces = () => runtime().store.getWorkspaces();
// 공유 공간으로 바꾸면 기다리지 않고 바로 동기화를 요청 (다른 기기에서 바뀐 기록이 곧 보이게)
function syncAfterSwitch(own) {
  const ws = own.store.getCurrentWorkspace();
  if (ws && !ws.personal && ws.serverId) own.bridge.requestSync(0);
}
export const switchWorkspace = id => {
  const own = runtime();
  const result = own.store.switchWorkspace(id);
  syncAfterSwitch(own);
  return result;
};

// 공간 색: 개인 공간은 민트, 팀 공간은 목록 순서대로 아래 색 (같은 기기에서는 늘 같은 색)
const TEAM_COLORS = ['#7F77DD', '#E0A030', '#378ADD', '#D4537E', '#8a8f94', '#D85A30'];
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
  const own = runtime();
  if (!workspaceId || own.store.getCurrentWorkspace().id === workspaceId) return;
  own.store.switchWorkspace(workspaceId);
  syncAfterSwitch(own);
}
// 화면을 다시 열 때 깜빡이지 않도록 마지막 결과를 계정·공간별로 기억 (앱이 켜져 있는 동안만)
const recent = new Map();
const recentKey = (kind, serverId) => `${runtime().session?.id}:${serverId}:${kind}`;
export const recentValue = (kind, serverId) => recent.get(recentKey(kind, serverId)) ?? null;
export const rememberValue = (kind, serverId, value) => { recent.set(recentKey(kind, serverId), value); return value; };
export const listMembers = async (serverId) => rememberValue('members', serverId, await api.listMembers(serverId, { activeOnly: true }));

// 멤버 관리 (공유 공간): 바꾼 뒤 기기 기록도 곧 맞추도록 동기화를 요청
async function memberChange(call) {
  const own = runtime();
  const result = await call();
  if (runtime() === own) own.bridge?.requestSync?.(0);
  return result;
}
export const getWorkspaceBilling = serverId => api.getWorkspaceBilling(serverId);
export const listAuditLogs = serverId => api.listAuditLogs(serverId);
export const claimWorkspaceBilling = serverId => memberChange(() => api.claimWorkspaceBilling(serverId));
export const changeMemberRole = (serverId, accountId, role) => memberChange(() => api.changeMemberRole(serverId, accountId, role));
export const setMemberExpiry = (serverId, accountId, expiresAt) => memberChange(() => api.setMemberExpiry(serverId, accountId, expiresAt));
export const removeMember = (serverId, accountId) => memberChange(() => api.removeMember(serverId, accountId));
export const scopedKey = key => `${runtime().session.id}:${runtime().store.getCurrentWorkspace().id}:${key}`;
export async function createWorkspace(fields) {
  const own = runtime();
  const id = await api.createWorkspace(fields.name, fields.desc);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다. 공간 목록을 새로 확인해 주세요');
  own.store.upsertServerWorkspace({ id, name: fields.name, description: fields.desc, role: 'OWNER', members: 1 });
  return id;
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
  const status = await own.bridge.status(id);
  const workspaceSync = status.workspaces[id];
  if (status.unsent || workspaceSync?.conflicts || workspaceSync?.failed) {
    throw new Error('이 공간의 미전송 기록과 충돌을 해결한 뒤 다시 시도해 주세요');
  }
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  if (ws.roleCode === 'OWNER') await api.deleteWorkspace(ws.serverId);
  else await api.leaveWorkspace(ws.serverId);
  if (runtime() !== own) throw new Error('계정이 바뀌었습니다');
  return own.store.deleteWorkspace(id);
}
