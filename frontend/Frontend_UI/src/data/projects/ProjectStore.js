// 프로젝트, 팀 구성원, 프로젝트 초대를 관리합니다.
//   공유 작업 공간에서는 서버가 기준 데이터입니다. 변경 사항은 동기화 엔진(local-sync의 saveLocal)에 전달한 뒤
//   메모 및 할 일과 동일하게 브리지를 통해 전송합니다. 읽기는 엔진 레코드(전송 대기 중인 변경 포함)를 사용합니다.
//   개인 작업 공간은 메모 및 할 일과 마찬가지로 동기화하지 않으므로 프로젝트는 이 기기에만 저장됩니다.
//   할 일 링크는 할 일 자체의 projectId(할 일과 함께 동기화)를 사용합니다. 공유 작업 공간의 메모 링크는 서버의
//   note_projects를 사용합니다. 기기 파일은 로컬에 두고, 공유 프로젝트 첨부 파일은 project_files를 통해 구성원 모두와 동기화합니다.
import { randomUUID } from 'expo-crypto';
import {
  list, saveList, scoped, useValue, runtime, maybeRuntime, runtimeSubscribe, readPreference, writePreference, emitRuntime, syncContext,
} from '../hooks';
import * as engine from '../../lib/stella/local-sync';
import { supabase } from '../../lib/stella/supabase';
import {
  LEADER_ROLE, canManageProject, createProjectInvite, getProjectInviteQuota, isLeaderConflict, newProjectChanges,
  pendingInvites, projectFileChanges, projectFilesOf, projectOfFile, projectInviteShareText, teamChanges, teamErrorMessage, wouldRemoveAllLeaders,
} from '../../lib/stella/project-team';
import { inviteMailErrorMessage, sendInviteMail } from '../../lib/stella/invite-mail';
import { alertUser } from '../alert';

export const PROJECT_STATUSES = ['진행 전', '진행 중', '완료', '보류'];
export const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const EMPTY = Object.freeze([]);
const EMPTY_LINKS = Object.freeze({ memos: Object.freeze({}), files: Object.freeze({}) });
const EMPTY_SHARED = Object.freeze({ projects: EMPTY, members: EMPTY, invites: EMPTY, noteLinks: EMPTY, projectFiles: EMPTY, mark: '' });
const FIELDS = ['title', 'due', 'priority', 'status', 'alarm', 'assignee', 'place', 'desc'];
const KIND = { memo: 'memos', memos: 'memos', task: 'tasks', tasks: 'tasks', file: 'files', files: 'files' };
const kindOf = kind => KIND[kind] ?? (() => { throw new Error(`알 수 없는 항목 종류: ${kind}`); })();
const pickFields = fields => Object.fromEntries(FIELDS.filter(k => k in (fields ?? {})).map(k => [k, fields[k] ?? '']));

// ---------------------------------------------------------------------
// 공유 작업 공간 캐시(엔진 레코드를 화면에서 동기식으로 읽을 수 있게 함)
// ---------------------------------------------------------------------
let shared = new Map();
let sharedSession = null;
const inflight = new Map();
const again = new Set();

function sharedEntry(rt, serverId) {
  if (sharedSession !== rt.session.id) { shared = new Map(); sharedSession = rt.session.id; quota = null; }
  const entry = shared.get(serverId);
  if (!entry) { void refreshShared(serverId); return EMPTY_SHARED; }
  return entry;
}

async function readShared(rt, serverId) {
  const out = {};
  for (const [key, entity] of [['projects', 'projects'], ['members', 'project_members'], ['invites', 'project_invites'], ['noteLinks', 'note_projects'], ['projectFiles', 'project_files']]) {
    out[key] = (await engine.listLocal(rt.syncDb, serverId, entity)).map(r => r.data);
  }
  return out;
}

function refreshShared(serverId) {
  if (inflight.has(serverId)) { again.add(serverId); return inflight.get(serverId); }
  const run = (async () => {
    do {
      again.delete(serverId);
      const rt = maybeRuntime();
      if (!rt) return;
      const next = await readShared(rt, serverId);
      if (maybeRuntime() !== rt || sharedSession !== rt.session.id) return;
      const mark = JSON.stringify(next);
      if (shared.get(serverId)?.mark !== mark) {
        shared.set(serverId, Object.freeze({ ...next, mark }));
        emitRuntime();
      }
    } while (again.has(serverId));
  })().catch(error => console.warn('[projects] 동기화 기록을 읽지 못했습니다', error)).finally(() => {
    inflight.delete(serverId);
    if (again.delete(serverId)) void refreshShared(serverId);
  });
  inflight.set(serverId, run);
  return run;
}

// 런타임 변경(브리지 결과 포함) 후 다시 읽습니다. 입력 중 DB를 과도하게 조회하지 않도록 요청을 합칩니다.
let refreshTimer = null;
runtimeSubscribe(() => {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const rt = maybeRuntime();
    const ws = rt?.store.getCurrentWorkspace();
    if (ws && !ws.personal && ws.serverId && sharedSession === rt.session.id && shared.has(ws.serverId)) void refreshShared(ws.serverId);
  }, 150);
});

// ---------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------
// readPreference는 키마다 처음 전달된 대체값을 캐시하므로, 값이 없을 때 대체값의 형태가 유효하다고 가정하지 않습니다.
const readLinks = () => readPreference(scoped('project-links'), EMPTY_LINKS) ?? EMPTY_LINKS;
const writeLinks = links => writePreference(scoped('project-links'), links);
const keysFor = (map, projectId) => Object.keys(map).filter(id => map[id] === projectId);

function taskIndex(tasks) {
  const out = {};
  for (const t of tasks) if (t.projectId) (out[t.projectId] ??= []).push(t.id);
  return out;
}

function buildPersonal(rows, tasks, links) {
  const byTask = taskIndex(tasks);
  return rows.map(p => ({
    ...p, members: p.members ?? EMPTY, invites: EMPTY,
    links: { memos: keysFor(links.memos, p.id), tasks: byTask[p.id] ?? EMPTY, files: keysFor(links.files, p.id) },
  }));
}

const METHOD_LABEL = { EMAIL: '메일', LINK: '링크' };
function buildShared(rt, entry, tasks, links) {
  const map = rt.store.serverMap;
  const byTask = taskIndex(tasks);
  return entry.projects
    .slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(row => ({
      ...map.projectFromServer(row),
      createdAt: Date.parse(row.created_at) || 0,
      updatedAt: Date.parse(row.updated_at) || 0,
      members: entry.members.filter(m => m.project_id === row.id)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name).localeCompare(String(b.name)))
        .map(m => ({ id: m.id, name: m.name, role: m.role, accountId: m.account_id })),
      invites: pendingInvites(entry.invites.map(data => ({ data })), row.id)
        .map(i => ({ id: i.id, email: i.email ?? '', method: METHOD_LABEL[i.method] ?? i.method, expiresAt: i.expires_at })),
      links: {
        memos: entry.noteLinks.filter(l => l.project_id === row.id).map(l => l.note_id),
        tasks: byTask[row.id] ?? EMPTY,
        files: [...new Set([
          ...projectFilesOf(entry.projectFiles.map(data => ({ data })), row.id).map(file => file.asset_id),
          ...keysFor(links.files, row.id),
        ])],
      },
    }));
}

let view = { deps: null, value: EMPTY };
export function getProjects() {
  const rt = maybeRuntime();
  if (!rt) return EMPTY;
  const ws = rt.store.getCurrentWorkspace();
  const tasks = rt.store.getTasks();
  const links = readLinks();
  const base = ws.personal ? list('projects') : ws.serverId ? sharedEntry(rt, ws.serverId) : EMPTY_SHARED;
  const deps = [rt, ws.id, tasks, links, base];
  if (view.deps && deps.every((d, i) => d === view.deps[i])) return view.value;
  const value = Object.freeze(ws.personal ? buildPersonal(base, tasks, links) : buildShared(rt, base, tasks, links));
  view = { deps, value };
  return value;
}
export const useProjects = () => useValue(getProjects);
export const subscribeProjects = runtimeSubscribe;
export const getProject = id => getProjects().find(p => p.id === id) ?? null;
export const projectOf = (kind, id) => getProjects().find(p => p.links[kindOf(kind)].includes(id)) ?? null;

// ---------------------------------------------------------------------
// 쓰기 도우미
// ---------------------------------------------------------------------
const messageOf = error => {
  const team = teamErrorMessage(error);
  return team.startsWith('요청을 처리하지 못했어요') ? String(error?.message ?? error) : team;
};
// 화면에서는 동기식으로 호출합니다. 누르기 이벤트 핸들러에 예외를 던지는 대신 실패를 반환합니다.
function safely(fn, fallback = null) {
  try { return fn(); } catch (error) { alertUser('저장하지 못했어요', messageOf(error)); return fallback; }
}
function background(promise, onError = error => alertUser('서버에 저장하지 못했어요', messageOf(error))) {
  promise.catch(onError);
}
function current() {
  const rt = runtime();
  return { rt, ws: rt.store.getCurrentWorkspace() };
}
function guardShared(ws) {
  if (!ws.serverId) throw new Error('이 공간은 아직 서버에 연결되지 않았어요. 동기화된 뒤 다시 시도해 주세요');
  if (ws.roleCode === 'VIEWER') throw new Error('보기 전용 멤버는 할 수 없어요');
}
function guardManage(rt, ws, projectId) {
  guardShared(ws);
  const members = sharedEntry(rt, ws.serverId).members.filter(m => m.project_id === projectId);
  if (!canManageProject({ me: rt.session.id, myRole: ws.roleCode, members })) throw new Error('프로젝트 팀장만 할 수 있어요');
}
const myName = () => {
  const s = readPreference('settings', {});
  return (s.profile?.name || '나').slice(0, 20);
};

// 변경 사항을 동기화 엔진에 전달한 뒤 서버로 보냅니다. `before`는 먼저 전송 대기 중인 메모/할 일 저장을 넘겨
// 링크가 대상 레코드보다 먼저 서버에 도착하지 않도록 합니다.
async function pushShared(rt, ws, changes, { before = false, localSaved = false } = {}) {
  if (!changes.length) return;
  if (before) await rt.bridge.syncWorkspace(ws.id);
  if (!localSaved) {
    for (let i = 0; i < changes.length; i += 100) await engine.saveLocal(syncContext(ws.serverId), changes.slice(i, i + 100));
  }
  await refreshShared(ws.serverId);
  const result = await rt.bridge.syncWorkspace(ws.id);
  await refreshShared(ws.serverId);
  if (result?.status === 'ERROR') throw new Error(result.error || '동기화하지 못했어요');
  const flush = result?.flush;
  if (flush?.status === 'CONFLICT') {
    throw new Error(flush.conflicts?.some(isLeaderConflict) ? teamErrorMessage({ code: 'NOT_PROJECT_LEADER' }) : '다른 기기의 수정과 겹쳤어요. 동기화 상태를 확인해 주세요');
  }
  if (flush?.status === 'BLOCKED') throw new Error(flush.error || '서버가 저장을 거절했어요');
}

// ---------------------------------------------------------------------
// 프로젝트
// ---------------------------------------------------------------------
export async function addProject(fields) {
  const { rt, ws } = current();
  const id = randomUUID();
  const me = { accountId: rt.session.id, name: myName(), memberId: randomUUID() };
  const values = pickFields(fields);
  if (ws.personal) {
    const now = Date.now();
    const row = { id, ...values, members: [{ id: me.memberId, name: me.name, role: LEADER_ROLE, accountId: me.accountId }], createdAt: now, updatedAt: now };
    saveList('projects', [row, ...list('projects')]);
    return row;
  }
  guardShared(ws);
  const data = rt.store.serverMap.projectData(values);
  const changes = newProjectChanges(id, data, me);
  sharedEntry(rt, ws.serverId);
  await engine.saveLocal(syncContext(ws.serverId), changes);
  await refreshShared(ws.serverId);
  background(
    pushShared(rt, ws, changes, { localSaved: true }),
    error => alertUser('프로젝트는 기기에 저장됐어요', `서버 동기화에 실패했습니다. 연결이 복구되면 다시 시도해 주세요.\n${messageOf(error)}`),
  );
  return { id, ...values };
}

export const updateProject = (id, fields) => safely(() => {
  const { rt, ws } = current();
  const values = pickFields(fields);
  if (ws.personal) {
    saveList('projects', list('projects').map(p => (p.id === id ? { ...p, ...values, updatedAt: Date.now() } : p)));
    return true;
  }
  guardManage(rt, ws, id);
  const before = getProject(id) ?? {};
  const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => before[k] !== v));
  if (!Object.keys(changed).length) return true;
  background(pushShared(rt, ws, [{ kind: 'update', entity: 'projects', id, data: rt.store.serverMap.projectData(changed) }]));
  return true;
}, false);

export const deleteProject = id => safely(() => {
  const { rt, ws } = current();
  if (ws.personal) {
    saveList('projects', list('projects').filter(p => p.id !== id));
    const links = readLinks();
    const drop = map => Object.fromEntries(Object.entries(map).filter(([, p]) => p !== id));
    writeLinks({ memos: drop(links.memos), files: drop(links.files) });
    for (const t of rt.store.getTasks()) if (t.projectId === id) rt.store.updateTask(t.id, { projectId: null });
    return true;
  }
  guardManage(rt, ws, id);
  background(pushShared(rt, ws, [{ kind: 'delete', entity: 'projects', id }]));
  return true;
}, false);

// ---------------------------------------------------------------------
// 링크(화면 표시와 같이 항목 하나당 프로젝트 하나)
// ---------------------------------------------------------------------
function setLinks(projectId, kind, ids) {
  const { rt, ws } = current();
  const k = kindOf(kind);
  if (k === 'tasks') {
    for (const id of ids) if ((rt.store.getTask(id)?.projectId ?? null) !== projectId) rt.store.updateTask(id, { projectId });
    return true;
  }
  if (k === 'files' || ws.personal) {
    const links = readLinks();
    const map = { ...links[k] };
    for (const id of ids) { if (projectId) map[id] = projectId; else delete map[id]; }
    writeLinks({ ...links, [k]: map });
    return true;
  }
  guardShared(ws);
  const noteLinks = sharedEntry(rt, ws.serverId).noteLinks;
  const changes = [];
  for (const id of ids) {
    for (const l of noteLinks) {
      if (l.note_id === id && l.project_id !== projectId) changes.push({ kind: 'unlink', entity: 'note_projects', data: { note_id: id, project_id: l.project_id } });
    }
    if (projectId && !noteLinks.some(l => l.note_id === id && l.project_id === projectId)) {
      changes.push({ kind: 'link', entity: 'note_projects', data: { note_id: id, project_id: projectId } });
    }
  }
  background(pushShared(rt, ws, changes, { before: true }));
  return true;
}
export const linkItems = (projectId, kind, ids) => safely(() => setLinks(projectId, kind, ids), false);
export const unlinkItems = (kind, ids) => safely(() => setLinks(null, kind, ids), false);
export const setItemProject = (kind, id, projectId) => safely(() => setLinks(projectId || null, kind, [id]), false);

export async function linkProjectFiles(projectId, assetIds) {
  const { rt, ws } = current();
  if (ws.personal) throw new Error('공유 프로젝트에서만 클라우드 파일을 연결할 수 있어요');
  guardShared(ws);
  const rows = await engine.listLocal(rt.syncDb, ws.serverId, 'project_files');
  const changes = [...new Set(assetIds)].flatMap(id => projectFileChanges.move(id, projectOfFile(rows, id), projectId));
  await pushShared(rt, ws, changes, { before: true });
}

export async function unlinkProjectFiles(projectId, assetIds) {
  const { rt, ws } = current();
  if (ws.personal) throw new Error('공유 프로젝트에서만 클라우드 파일 연결을 해제할 수 있어요');
  guardShared(ws);
  const rows = await engine.listLocal(rt.syncDb, ws.serverId, 'project_files');
  const linked = new Set(projectFilesOf(rows, projectId).map(file => file.asset_id));
  const changes = [...new Set(assetIds)].filter(id => linked.has(id)).flatMap(id => projectFileChanges.unlink(projectId, id));
  await pushShared(rt, ws, changes, { before: true });
}

// ---------------------------------------------------------------------
// 팀 구성원
// ---------------------------------------------------------------------
function editPersonalMembers(edit) {
  saveList('projects', edit(list('projects')));
  return true;
}

export const updateMember = (projectId, memberId, fields) => safely(() => {
  const { rt, ws } = current();
  const changes = teamChanges.edit(memberId, { name: fields.name, role: fields.role }); // 두 공간의 유효성을 검사합니다.
  if (ws.personal) {
    const data = changes[0].data;
    return editPersonalMembers(rows => rows.map(p => (p.id !== projectId ? p
      : { ...p, members: p.members.map(m => (m.id === memberId ? { ...m, ...data } : m)), updatedAt: Date.now() })));
  }
  guardManage(rt, ws, projectId);
  background(pushShared(rt, ws, changes));
  return true;
}, false);

export const moveMembers = (fromId, toId, ids) => safely(() => {
  const { rt, ws } = current();
  if (ws.personal) {
    return editPersonalMembers(rows => {
      const moving = rows.find(p => p.id === fromId)?.members.filter(m => ids.includes(m.id)) ?? [];
      return rows.map(p => (p.id === fromId ? { ...p, members: p.members.filter(m => !ids.includes(m.id)) }
        : p.id === toId ? { ...p, members: [...p.members, ...moving] } : p));
    });
  }
  guardManage(rt, ws, fromId);
  guardManage(rt, ws, toId);
  background(pushShared(rt, ws, teamChanges.move(ids, toId)));
  return true;
}, false);

export const removeMembers = (projectId, ids) => safely(() => {
  const { rt, ws } = current();
  const members = getProject(projectId)?.members ?? [];
  if (ws.personal) {
    if (wouldRemoveAllLeaders(members, ids)) throw new Error('팀장은 모두 삭제할 수 없어요');
    return editPersonalMembers(rows => rows.map(p => (p.id === projectId ? { ...p, members: p.members.filter(m => !ids.includes(m.id)) } : p)));
  }
  guardManage(rt, ws, projectId);
  background(pushShared(rt, ws, teamChanges.remove(members, ids)));
  return true;
}, false);

// ---------------------------------------------------------------------
// 초대(서버에서만 처리: 개인 프로젝트에는 초대 대상이 될 서버 레코드가 없음)
// ---------------------------------------------------------------------
let quota = null;
let quotaLoading = false;
function loadQuota() {
  if (quotaLoading || !maybeRuntime()) return;
  quotaLoading = true;
  const session = maybeRuntime().session.id;
  getProjectInviteQuota(supabase)
    .then(q => { if (maybeRuntime()?.session.id === session) { quota = q; emitRuntime(); } })
    .catch(error => console.warn('[projects] 초대 횟수를 불러오지 못했습니다', error))
    .finally(() => { quotaLoading = false; });
}
export function invitesLeft() { if (!quota) loadQuota(); return quota?.remaining ?? 0; }
export function monthlyInvites() { if (!quota) loadQuota(); return quota?.limit ?? 0; }
export const inviteQuotaLoaded = () => quota !== null;
// 서버의 할당량 정보가 도착하면 다시 렌더링합니다: { limit, used, remaining }, 로딩 중에는 null
export const useInviteQuota = () => useValue(() => { if (!quota) loadQuota(); return quota; });

export async function addInvite(projectId, { email, method }) {
  const { rt, ws } = current();
  if (ws.personal) throw new Error('개인 공간의 프로젝트는 이 기기에만 있어서 초대할 수 없어요. 공유 공간에서 프로젝트를 만들어 주세요');
  guardManage(rt, ws, projectId);
  // 초대 RPC를 호출하려면 프로젝트가 서버에 있어야 하므로 대기 중인 저장부터 전송합니다.
  await rt.bridge.syncWorkspace(ws.id);
  const record = await engine.getLocal(rt.syncDb, ws.serverId, 'projects', projectId);
  if (!record || record.pending) throw new Error('프로젝트가 아직 서버에 저장되지 않았어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요');
  let invite;
  try { invite = await createProjectInvite(supabase, projectId, { method, email }); }
  catch (error) { throw new Error(messageOf(error)); }
  quota = invite.quota ?? quota;
  let mailed = false;
  let mailError = '';
  if (invite.method === 'EMAIL') {
    try { await sendInviteMail(supabase, { code: invite.code }); mailed = true; }
    catch (error) { mailError = inviteMailErrorMessage(error); }
  }
  await rt.bridge.syncWorkspace(ws.id);     // 새로 생성된 대기 중 초대 행을 가져옵니다.
  await refreshShared(ws.serverId);
  emitRuntime();
  const projectName = getProject(projectId)?.title ?? '';
  return {
    code: invite.code, expiresAt: invite.expires_at, mailed, mailError,
    shareText: projectInviteShareText({ projectName, code: invite.code, expiresAt: invite.expires_at }),
  };
}
