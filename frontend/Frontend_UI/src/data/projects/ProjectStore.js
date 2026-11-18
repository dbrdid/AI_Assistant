// Projects, team members and project invites.
//   Shared workspace: the server is the source of truth. Edits go to the sync engine (local-sync saveLocal) and are
//   pushed with the bridge, exactly like memos and tasks. Reads come from the engine's records (pending edits included).
//   Personal workspace: never synced (same rule as memos and tasks), so projects stay on this device only.
//   Task links use the task's own projectId (synced with the task). Memo links use the server's note_projects in a
//   shared workspace. File links stay on this device: files in the vault are device files, not uploaded attachments.
import { randomUUID } from 'expo-crypto';
import {
  list, saveList, scoped, useValue, runtime, maybeRuntime, runtimeSubscribe, readPreference, writePreference, emitRuntime, syncContext,
} from '../hooks';
import * as engine from '../../lib/stella/local-sync';
import { supabase } from '../../lib/stella/supabase';
import {
  LEADER_ROLE, canManageProject, createProjectInvite, getProjectInviteQuota, isLeaderConflict, newProjectChanges,
  pendingInvites, projectInviteShareText, teamChanges, teamErrorMessage, wouldRemoveAllLeaders,
} from '../../lib/stella/project-team';
import { inviteMailErrorMessage, sendInviteMail } from '../../lib/stella/invite-mail';
import { alertUser } from '../alert';

export const PROJECT_STATUSES = ['진행 전', '진행 중', '완료', '보류'];
export const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const EMPTY = Object.freeze([]);
const EMPTY_LINKS = Object.freeze({ memos: Object.freeze({}), files: Object.freeze({}) });
const EMPTY_SHARED = Object.freeze({ projects: EMPTY, members: EMPTY, invites: EMPTY, noteLinks: EMPTY, mark: '' });
const FIELDS = ['title', 'due', 'priority', 'status', 'alarm', 'assignee', 'place', 'desc'];
const KIND = { memo: 'memos', memos: 'memos', task: 'tasks', tasks: 'tasks', file: 'files', files: 'files' };
const kindOf = kind => KIND[kind] ?? (() => { throw new Error(`알 수 없는 항목 종류: ${kind}`); })();
const pickFields = fields => Object.fromEntries(FIELDS.filter(k => k in (fields ?? {})).map(k => [k, fields[k] ?? '']));

// ---------------------------------------------------------------------
// Shared workspace cache (engine records → synchronous reads for the screens)
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
  for (const [key, entity] of [['projects', 'projects'], ['members', 'project_members'], ['invites', 'project_invites'], ['noteLinks', 'note_projects']]) {
    out[key] = (await engine.listLocal(rt.syncDb, serverId, entity)).map(r => r.data);
  }
  return out;
}

function refreshShared(serverId) {
  if (inflight.has(serverId)) { again.add(serverId); return inflight.get(serverId); }
  const run = (async () => {
    const rt = maybeRuntime();
    if (!rt) return;
    const next = await readShared(rt, serverId);
    if (maybeRuntime() !== rt || sharedSession !== rt.session.id) return;
    const mark = JSON.stringify(next);
    if (shared.get(serverId)?.mark === mark) return;
    shared.set(serverId, Object.freeze({ ...next, mark }));
    emitRuntime();
  })().catch(error => console.warn('[projects] 동기화 기록을 읽지 못했습니다', error)).finally(() => {
    inflight.delete(serverId);
    if (again.delete(serverId)) void refreshShared(serverId);
  });
  inflight.set(serverId, run);
  return run;
}

// Re-read after any runtime change (bridge results arrive this way). Coalesced so typing does not hammer the DB.
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
// Reads
// ---------------------------------------------------------------------
// readPreference caches the first fallback it is given for a key, so never trust the shape of a missing value.
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
        files: keysFor(links.files, row.id),
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
// Write helpers
// ---------------------------------------------------------------------
const messageOf = error => {
  const team = teamErrorMessage(error);
  return team.startsWith('요청을 처리하지 못했어요') ? String(error?.message ?? error) : team;
};
// Screens call these synchronously. Report failures instead of throwing into a press handler.
function safely(fn, fallback = null) {
  try { return fn(); } catch (error) { alertUser('저장하지 못했어요', messageOf(error)); return fallback; }
}
function background(promise) {
  promise.catch(error => alertUser('서버에 저장하지 못했어요', messageOf(error)));
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

// Hand changes to the sync engine, then push. `before` first hands pending memo/task saves over so links never
// reach the server before the record they point at.
async function pushShared(rt, ws, changes, { before = false } = {}) {
  if (!changes.length) return;
  if (before) await rt.bridge.syncWorkspace(ws.id);
  for (let i = 0; i < changes.length; i += 100) await engine.saveLocal(syncContext(ws.serverId), changes.slice(i, i + 100));
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
// Projects
// ---------------------------------------------------------------------
export const addProject = fields => safely(() => {
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
  background(pushShared(rt, ws, newProjectChanges(id, data, me)));
  return { id, ...values };
});

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
// Links (one project per item, like the screens show)
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

// ---------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------
function editPersonalMembers(edit) {
  saveList('projects', edit(list('projects')));
  return true;
}

export const updateMember = (projectId, memberId, fields) => safely(() => {
  const { rt, ws } = current();
  const changes = teamChanges.edit(memberId, { name: fields.name, role: fields.role }); // validates both spaces
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
// Invites (server only: a personal project has no server record to invite into)
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
// Re-renders when the server quota arrives: { limit, used, remaining } or null while loading
export const useInviteQuota = () => useValue(() => { if (!quota) loadQuota(); return quota; });

export async function addInvite(projectId, { email, method }) {
  const { rt, ws } = current();
  if (ws.personal) throw new Error('개인 공간의 프로젝트는 이 기기에만 있어서 초대할 수 없어요. 공유 공간에서 프로젝트를 만들어 주세요');
  guardManage(rt, ws, projectId);
  // The invite RPC needs the project on the server: push pending saves first.
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
  await rt.bridge.syncWorkspace(ws.id);   // pull the new pending invite row
  await refreshShared(ws.serverId);
  emitRuntime();
  const projectName = getProject(projectId)?.title ?? '';
  return {
    code: invite.code, expiresAt: invite.expires_at, mailed, mailError,
    shareText: projectInviteShareText({ projectName, code: invite.code, expiresAt: invite.expires_at }),
  };
}
