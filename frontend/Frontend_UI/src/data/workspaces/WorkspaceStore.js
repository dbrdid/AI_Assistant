import { useMemo } from 'react';
import { runtime, useValue } from '../hooks';
import * as api from '../../lib/stella/workspaces';
import { colors } from '../../shared/theme/theme';
export const useWorkspaces = () => useValue(() => runtime().store.getWorkspaceState());
export const getWorkspaces = () => runtime().store.getWorkspaces();
export const switchWorkspace = id => runtime().store.switchWorkspace(id);

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
  if (workspaceId && own.getCurrentWorkspace().id !== workspaceId) own.switchWorkspace(workspaceId);
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
