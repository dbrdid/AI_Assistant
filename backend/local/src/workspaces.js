import { fail } from './errors.js';
import { LIMITS, id, onlyKeys, text } from './validate.js';

/**
 * Workspaces are separate shelves on this device: memos, tasks and proposals belong to exactly one, and the store
 * shows the current one. Sharing a workspace with other people needs a server and is not part of this module.
 */
function toWorkspace(row) {
  return { id: row.id, name: row.name, desc: row.description, personal: row.personal === 1, createdAt: row.created_at };
}

export function listWorkspaces(ctx) {
  return ctx.db.getAllSync('select id,name,description,personal,created_at from workspaces order by personal desc, created_at, id')
    .map(r => ctx.freeze(toWorkspace(r)));
}

function workspaceRow(ctx, workspaceId) {
  return ctx.db.getFirstSync('select id,name,description,personal,created_at from workspaces where id=?', [workspaceId]);
}

/** The workspace recorded as current, falling back to the personal one. */
export function loadCurrent(ctx) {
  const saved = ctx.db.getFirstSync("select value from settings where key='current_workspace'");
  if (saved && workspaceRow(ctx, saved.value)) return saved.value;
  return ctx.db.getFirstSync('select id from workspaces where personal=1').id;
}

/** Creates a workspace and returns its id (it does not switch to it). Names are unique. */
export function createWorkspace(ctx, input) {
  onlyKeys(input, ['name', 'desc']);
  const name = text(input.name, 'name', LIMITS.workspaceName, { required: true }).trim();
  const desc = text(input.desc ?? '', 'desc', LIMITS.workspaceDesc);
  if (ctx.db.getFirstSync('select 1 as ok from workspaces where name=?', [name])) fail('name_taken');
  const workspaceId = ctx.newId();
  ctx.db.runSync('insert into workspaces(id,name,description,personal,created_at) values(?,?,?,0,?)', [workspaceId, name, desc, ctx.now()]);
  ctx.touch('workspaces');
  return workspaceId;
}

/** Makes a workspace current; remembered across restarts. */
export function switchWorkspace(ctx, workspaceId) {
  id(workspaceId);
  if (!workspaceRow(ctx, workspaceId)) fail('not_found');
  if (workspaceId === ctx.ws()) return workspaceId;
  ctx.db.runSync("insert into settings(key,value) values('current_workspace',?) on conflict(key) do update set value=excluded.value", [workspaceId]);
  ctx.setWs(workspaceId);
  ctx.touch('all');
  return workspaceId;
}

/**
 * Deletes a workspace with all its memos, tasks and proposals. The personal workspace cannot be deleted; deleting
 * the current one switches to the personal workspace first.
 */
export function deleteWorkspace(ctx, workspaceId) {
  id(workspaceId);
  const row = workspaceRow(ctx, workspaceId) ?? fail('not_found');
  if (row.personal === 1) fail('personal_workspace');
  if (workspaceId === ctx.ws()) switchWorkspace(ctx, ctx.db.getFirstSync('select id from workspaces where personal=1').id);
  ctx.db.runSync('delete from workspaces where id=?', [workspaceId]);
  ctx.touch('workspaces');
  return true;
}
