// Sync RPCs, ported from supabase/migrations/202611090001_sync.sql. Each function runs inside one write transaction
// opened by rpc/index.js, so a throw anywhere rolls back every row it wrote (document, journal, audit, receipt,
// head and signals stay one unit). SQLite admits one writer at a time, which replaces the workspace row locks.
import {
  fail, isPlainObject, canonicalJson, sha256, byteLength, charLength, utcText, uuidCast,
  lockWorkspace, roleRank, folderRank, documentRank, requireOwner, audit, signal, checkLimit, isVersionText, nextId,
  MAX_BIGINT, PAGE_BUDGET, TRASH_RETENTION_US,
} from './core.js';

const AUTH = ['authenticated'];

/* ---------- private helpers ---------- */

// Syntax only; requireAclMembers checks the keys against the members. Keys become the canonical uuid text, so equal
// ACLs compare equal; two spellings of one uuid are rejected rather than resolved by key order (F15). Returns the
// canonical JSON text, or null (inherit).
function normalizeAcl(acl) {
  if (acl === null) return null;
  if (!isPlainObject(acl)) fail('invalid_acl');
  const out = {};
  for (const [key, value] of Object.entries(acl)) {
    if (value !== 'viewer' && value !== 'editor') fail('invalid_acl');
    const id = uuidCast(key) ?? fail('invalid_acl');
    if (Object.hasOwn(out, id)) fail('invalid_acl');
    out[id] = value;
  }
  // {} denies everyone; null would mean inherit.
  return canonicalJson(out);
}
// Keys must name current members, so removing a member can strip every grant it holds (F12).
function requireAclMembers(ctx, w, acl) {
  if (acl === null) return;
  for (const key of Object.keys(JSON.parse(acl))) {
    if (!ctx.q.get('select 1 from members where workspace_id=? and user_id=?', w, key)) fail('member_not_found');
  }
}
const parseJson = text => text === null ? null : JSON.parse(text);

function cipherOk(c, k, expected, w, d) {
  if (k === null || k !== expected) fail('invalid_key_epoch');
  // Bound the complete envelope and encoded field before regex/decode work.
  if (!isPlainObject(c) || byteLength(c) > 1049600 || (typeof c.ciphertext === 'string' && c.ciphertext.length > 1048576)) fail('invalid_ciphertext');
  if (c.algorithm !== 'A256GCM' || typeof c.nonce !== 'string' || typeof c.ciphertext !== 'string' || typeof c.aad !== 'string'
      || !/^[A-Za-z0-9+/]{16}$/.test(c.nonce) || !/^[A-Za-z0-9+/]+={0,2}$/.test(c.ciphertext)) fail('invalid_ciphertext');
  if (Object.keys(c).length !== 4 || c.aad !== `["local-first-v1","${w}","${d}","content",${k}]`) fail('invalid_ciphertext');
  // Canonical base64 only: decoding and re-encoding must give the same text.
  const nonce = Buffer.from(c.nonce, 'base64');
  const body = Buffer.from(c.ciphertext, 'base64');
  if (nonce.length !== 12 || body.length < 16 || nonce.toString('base64') !== c.nonce || body.toString('base64') !== c.ciphertext) fail('invalid_ciphertext');
}

function snapshot(d) {
  return { id: d.id, workspace_id: d.workspace_id, folder_id: d.folder_id, kind: d.kind,
    ciphertext: d.deleted ? null : parseJson(d.ciphertext), key_epoch: d.key_epoch, revision: String(d.revision), deleted: !!d.deleted };
}
const getDocument = (ctx, w, d) => ctx.q.get('select * from documents where workspace_id=? and id=?', w, d);
const getWorkspace = (ctx, w) => ctx.q.get('select * from workspaces where id=?', w);

function appendChange(ctx, w, d) {
  ctx.q.run('update workspaces set head=head+1 where id=?', w);
  const { head } = getWorkspace(ctx, w);
  ctx.q.run('insert into journal(workspace_id,seq,document_id,snapshot,actor_id) values(?,?,?,?,?)',
    w, head, d, JSON.stringify(snapshot(getDocument(ctx, w, d))), ctx.uid);
  audit(ctx, w, 'document_revision', d);
  signal(ctx, w);
  return head;
}

// Removes a non-owner member together with every ACL key naming it, so a later invitation starts from inherited
// access only (F12). Returns false and writes nothing when u is no such member.
function removeMember(ctx, w, u, action, anonymous) {
  if (!ctx.q.run("delete from members where workspace_id=? and user_id=? and role<>'owner'", w, u)) return false;
  const path = `$."${u}"`;
  // NULL (inherit) ACLs have no keys and stay as they are. The version bump makes a stale owner copy that still
  // names u fail with acl_version_mismatch.
  for (const table of ['folders', 'documents']) {
    ctx.q.run(`update ${table} set acl=json_remove(acl,?),acl_version=acl_version+1 where workspace_id=? and acl is not null and json_type(acl,?) is not null`, path, w, path);
  }
  ctx.q.run('update workspaces set access_epoch=access_epoch+1,pending_owner_id=nullif(pending_owner_id,?) where id=?', u, w);
  if (anonymous) {
    // Account deletion: no subject to record, and no signal for the user being deleted.
    audit(ctx, w, action, null, { anonymous: true });
    signal(ctx, w);
  } else {
    audit(ctx, w, action, u);
    signal(ctx, w, u);
  }
  return true;
}

// Deletes a workspace whose only member is being deleted. AI rows go with their documents (cascade), budgets with
// the workspace.
function deleteWorkspace(ctx, w) {
  ctx.q.run('insert or ignore into storage_deletions(path,workspace_id,queued_at) select storage_path,workspace_id,? from attachments where workspace_id=?', ctx.now(), w);
  for (const table of ['journal', 'key_envelopes', 'attachments', 'documents', 'folders', 'members', 'invitations', 'receipts', 'user_signals', 'audit']) {
    ctx.q.run(`delete from ${table} where workspace_id=?`, w);
  }
  ctx.q.run('delete from workspaces where id=?', w);
}

/**
 * Account deletion (F24), formerly the auth.users BEFORE DELETE trigger. Runs without a subject: the owner of a
 * workspace with other members must hand it over first; a sole-member workspace goes entirely; elsewhere the person
 * is removed and every trace is unlinked. aiHook cleans the AI rows (rpc/ai.js). Returns 1, or 0 when no such account.
 */
export function forgetUser(ctx, u, aiHook) {
  if (!ctx.q.get('select 1 from users where id=?', u)) return 0;
  const ws = ctx.q.all('select workspace_id,role from members where user_id=? order by workspace_id', u);
  for (const { workspace_id: w } of ws.filter(m => m.role === 'owner')) {
    if (ctx.q.get('select 1 from members where workspace_id=? and user_id<>?', w, u)) fail('owner_must_transfer');
    deleteWorkspace(ctx, w);
  }
  for (const { workspace_id: w } of ws.filter(m => m.role !== 'owner')) removeMember(ctx, w, u, 'account_deleted', true);
  // A pending invitation of u ends as after a decline: it goes and the members of its workspace see a signal
  // (existing signal rows only, and no audit row).
  for (const { workspace_id: w } of ctx.q.all('select workspace_id from invitations where user_id=? order by workspace_id', u)) {
    ctx.q.run('delete from invitations where workspace_id=? and user_id=?', w, u);
    ctx.q.run('update user_signals set generation=generation+1 where workspace_id=? and user_id in (select user_id from members where workspace_id=?)', w, w);
  }
  ctx.q.run('delete from user_signals where user_id=?', u);
  ctx.q.run('delete from receipts where actor_id=?', u);
  ctx.q.run('update workspaces set pending_owner_id=null where pending_owner_id=?', u);
  ctx.q.run('update journal set actor_id=null where actor_id=?', u);
  ctx.q.run('update audit set actor_id=nullif(actor_id,?),target_id=nullif(target_id,?) where actor_id=? or target_id=?', u, u, u, u);
  aiHook(ctx, u);
  return ctx.q.run('delete from users where id=?', u);
}

/* ---------- workspaces and membership ---------- */

function createWorkspace(ctx, { p_workspace_id: w, p_name: name }) {
  if (!ctx.uid) fail('unauthenticated');
  if (w === null || name === null || charLength(name) < 1 || charLength(name) > 200) fail('invalid_request');
  // SQLite's single writer decides between concurrent creators.
  if (getWorkspace(ctx, w)) fail('id_conflict');
  // A token can outlive its account.
  if (!ctx.q.get('select 1 from users where id=?', ctx.uid)) fail('unauthenticated');
  ctx.q.run('insert into workspaces(id,name) values(?,?)', w, name);
  ctx.q.run("insert into members(workspace_id,user_id,role) values(?,?,'owner')", w, ctx.uid);
  audit(ctx, w, 'create_workspace', w);
  signal(ctx, w);
  return { workspace_id: w, head: '0', access_epoch: '1' };
}

function setMember(ctx, { p_workspace_id: w, p_user_id: u, p_role: role }) {
  let x = lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  if (u === null) fail('invalid_request');
  if (u === ctx.uid || role === 'owner') fail('owner_change_not_supported');
  // A null role removes the member.
  if (role !== null && role !== 'viewer' && role !== 'editor') fail('invalid_role');
  // A call that changes nothing writes nothing: no epoch bump, audit row or signal.
  if (role === null) {
    if (!removeMember(ctx, w, u, 'set_member', false)) return { access_epoch: String(x.access_epoch), changed: false };
  } else {
    const member = ctx.q.get('select role from members where workspace_id=? and user_id=?', w, u);
    // Members join only through invitations (invite_member, respond_invitation).
    if (!member) fail('member_not_found');
    if (member.role === role) return { access_epoch: String(x.access_epoch), changed: false };
    ctx.q.run('update members set role=? where workspace_id=? and user_id=?', role, w, u);
    ctx.q.run('update workspaces set access_epoch=access_epoch+1,pending_owner_id=nullif(pending_owner_id,?) where id=?', u, w);
    // A role change withdraws a pending ownership offer to that member: the owner's latest decision wins.
    if (x.pending_owner_id === u) audit(ctx, w, 'offer_ownership', null);
    audit(ctx, w, 'set_member', u);
    signal(ctx, w, u);
  }
  x = getWorkspace(ctx, w);
  return { access_epoch: String(x.access_epoch), changed: true };
}

// Members join only through an invitation they accept (F13). Any uuid can be invited, so the answer does not tell
// whether an account exists. Invitations do not change access, so the epoch stays.
function inviteMember(ctx, { p_workspace_id: w, p_user_id: u, p_role: role }) {
  lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  if (u === null) fail('invalid_request');
  if (ctx.q.get('select 1 from members where workspace_id=? and user_id=?', w, u)) fail('already_member');
  const pending = ctx.q.get('select role from invitations where workspace_id=? and user_id=?', w, u)?.role ?? null;
  // A null role revokes the pending invitation.
  if (role === null) {
    if (pending === null) return { changed: false };
    ctx.q.run('delete from invitations where workspace_id=? and user_id=?', w, u);
    audit(ctx, w, 'revoke_invitation', u);
    signal(ctx, w, u);
    return { changed: true };
  }
  // Ownership moves only through offer_ownership.
  if (role !== 'editor' && role !== 'viewer') fail('invalid_role');
  if (pending === role) return { changed: false };
  ctx.q.run(`insert into invitations(workspace_id,user_id,role,invited_at) values(?,?,?,?)
    on conflict(workspace_id,user_id) do update set role=excluded.role,invited_at=excluded.invited_at`, w, u, role, ctx.now());
  audit(ctx, w, 'invite_member', u);
  signal(ctx, w, u);
  return { changed: true };
}

// The invitee's answer. Anyone else gets forbidden whether or not the workspace exists; so does a retried decline,
// because the invitation is gone and the caller is no member.
function respondInvitation(ctx, { p_workspace_id: w, p_accept: accept }) {
  let x = lockWorkspace(ctx, w);
  const invited = ctx.q.get('select role from invitations where workspace_id=? and user_id=?', w, ctx.uid)?.role ?? null;
  const memberRole = ctx.q.get('select role from members where workspace_id=? and user_id=?', w, ctx.uid)?.role ?? null;
  if (invited === null && memberRole === null) fail('forbidden');
  if (accept === null) fail('invalid_request');
  // Already a member, for example after a lost accept response: nothing changes.
  if (invited === null) return { changed: false, role: memberRole, access_epoch: String(x.access_epoch) };
  // The invitation can name a deleted account whose token is still valid.
  if (!ctx.q.get('select 1 from users where id=?', ctx.uid)) fail('unauthenticated');
  ctx.q.run('delete from invitations where workspace_id=? and user_id=?', w, ctx.uid);
  if (accept) {
    ctx.q.run('insert into members(workspace_id,user_id,role) values(?,?,?)', w, ctx.uid, invited);
    ctx.q.run('update workspaces set access_epoch=access_epoch+1 where id=?', w);
    x = getWorkspace(ctx, w);
    audit(ctx, w, 'accept_invitation', ctx.uid);
    signal(ctx, w);
    return { changed: true, role: invited, access_epoch: String(x.access_epoch) };
  }
  audit(ctx, w, 'decline_invitation', ctx.uid);
  signal(ctx, w, ctx.uid);
  return { changed: true, role: null, access_epoch: String(x.access_epoch) };
}

// The owner hands the workspace over first (offer_ownership, accept_ownership). A retry gets forbidden.
function leaveWorkspace(ctx, { p_workspace_id: w }) {
  lockWorkspace(ctx, w);
  const r = roleRank(ctx, w);
  if (r < 1) fail('forbidden');
  if (r === 3) fail('owner_must_transfer');
  removeMember(ctx, w, ctx.uid, 'leave_workspace', false);
  return { changed: true, access_epoch: String(getWorkspace(ctx, w).access_epoch) };
}

// A null user cancels the pending offer. No epoch bump: access changes only when the offer is accepted.
function offerOwnership(ctx, { p_workspace_id: w, p_user_id: u }) {
  const x = lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  if (u === null) {
    if (x.pending_owner_id === null) return { changed: false, pending_owner_id: null };
    ctx.q.run('update workspaces set pending_owner_id=null where id=?', w);
    audit(ctx, w, 'offer_ownership', null);
    signal(ctx, w, x.pending_owner_id);
    return { changed: true, pending_owner_id: null };
  }
  if (u === ctx.uid) fail('owner_change_not_supported');
  if (!ctx.q.get('select 1 from members where workspace_id=? and user_id=?', w, u)) fail('member_not_found');
  if (x.pending_owner_id === u) return { changed: false, pending_owner_id: u };
  ctx.q.run('update workspaces set pending_owner_id=? where id=?', u, w);
  audit(ctx, w, 'offer_ownership', u);
  signal(ctx, w, u);
  return { changed: true, pending_owner_id: u };
}

function acceptOwnership(ctx, { p_workspace_id: w }) {
  const x = lockWorkspace(ctx, w);
  const r = roleRank(ctx, w);
  // Already the owner, for example after a lost response: nothing changes.
  if (r === 3) return { changed: false, access_epoch: String(x.access_epoch) };
  if (r < 1 || x.pending_owner_id !== ctx.uid) fail('forbidden');
  // The old owner first, because single_owner allows one owner row; it stays as an editor.
  ctx.q.run("update members set role='editor' where workspace_id=? and role='owner'", w);
  ctx.q.run("update members set role='owner' where workspace_id=? and user_id=?", w, ctx.uid);
  ctx.q.run('update workspaces set pending_owner_id=null,access_epoch=access_epoch+1 where id=?', w);
  audit(ctx, w, 'transfer_ownership', ctx.uid);
  signal(ctx, w);
  return { changed: true, access_epoch: String(getWorkspace(ctx, w).access_epoch) };
}

/* ---------- lists ---------- */

function listMyWorkspaces(ctx, { p_after_id: after, p_limit: limit }) {
  if (!ctx.uid) fail('unauthenticated');
  checkLimit(limit);
  const rows = ctx.q.all(`select x.id,x.name,m.role,x.ai_enabled,x.pending_owner_id,
      (select count(*) from members c where c.workspace_id=x.id) as member_count
    from members m join workspaces x on x.id=m.workspace_id
    where m.user_id=? and (? is null or x.id>?) order by x.id limit ?`, ctx.uid, after, after, limit + 1);
  return {
    workspaces: rows.slice(0, limit).map(p => ({ id: p.id, name: p.name, role: p.role, member_count: p.member_count,
      ai_enabled: !!p.ai_enabled, ownership_offered: p.pending_owner_id === ctx.uid })),
    next_id: nextId(rows, limit),
  };
}

function listMembers(ctx, { p_workspace_id: w, p_after_id: after, p_limit: limit }) {
  const x = lockWorkspace(ctx, w);
  if (roleRank(ctx, w) < 1) fail('forbidden');
  checkLimit(limit);
  const rows = ctx.q.all('select user_id,role from members where workspace_id=? and (? is null or user_id>?) order by user_id limit ?', w, after, after, limit + 1);
  return { members: rows.slice(0, limit), next_id: nextId(rows, limit, 'user_id'), access_epoch: String(x.access_epoch) };
}

function listInvitations(ctx, { p_workspace_id: w, p_after_id: after, p_limit: limit }) {
  const x = lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  checkLimit(limit);
  const rows = ctx.q.all('select user_id,role,invited_at from invitations where workspace_id=? and (? is null or user_id>?) order by user_id limit ?', w, after, after, limit + 1);
  return {
    invitations: rows.slice(0, limit).map(i => ({ user_id: i.user_id, role: i.role, invited_at: utcText(i.invited_at) })),
    next_id: nextId(rows, limit, 'user_id'), pending_owner_id: x.pending_owner_id,
  };
}

function listMyInvitations(ctx, { p_after_id: after, p_limit: limit }) {
  if (!ctx.uid) fail('unauthenticated');
  checkLimit(limit);
  const rows = ctx.q.all(`select i.workspace_id,x.name,i.role,i.invited_at from invitations i join workspaces x on x.id=i.workspace_id
    where i.user_id=? and (? is null or i.workspace_id>?) order by i.workspace_id limit ?`, ctx.uid, after, after, limit + 1);
  return {
    invitations: rows.slice(0, limit).map(p => ({ workspace_id: p.workspace_id, name: p.name, role: p.role, invited_at: utcText(p.invited_at) })),
    next_id: nextId(rows, limit, 'workspace_id'),
  };
}

/* ---------- folders and ACLs ---------- */

function createFolder(ctx, { p_workspace_id: w, p_folder_id: f, p_parent_id: parent, p_acl: acl }) {
  lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  if (folderRank(ctx, w, parent) < 2) fail('forbidden');
  if (f === null) fail('invalid_request');
  const normalized = normalizeAcl(acl);
  requireAclMembers(ctx, w, normalized);
  if (ctx.q.get('select 1 from folders where workspace_id=? and id=?', w, f)) fail('id_conflict');
  // NULL inherits the parent chain and role (F01); an ACL makes the folder restricted from the start.
  ctx.q.run('insert into folders(workspace_id,id,parent_id,acl) values(?,?,?,?)', w, f, parent, normalized);
  audit(ctx, w, 'create_folder', f);
  // A new folder holds nothing yet, so the epoch stays; the signal tells members to refetch their folder list.
  signal(ctx, w);
  return { id: f, acl_version: '1' };
}

// Folders the caller can see (every ancestor visible), by id.
function listFolders(ctx, { p_workspace_id: w, p_after_id: after, p_limit: limit }) {
  lockWorkspace(ctx, w);
  if (roleRank(ctx, w) < 1) fail('forbidden');
  checkLimit(limit);
  const rows = [];
  const folderSql = `select id,parent_id from folders where workspace_id=?${after === null ? '' : ' and id>?'} order by id`;
  for (const f of ctx.q.iterate(folderSql, w, ...(after === null ? [] : [after]))) {
    const rank = folderRank(ctx, w, f.id);
    if (rank > 0) rows.push({ id: f.id, parent_id: f.parent_id, can_edit: rank >= 2 });
    if (rows.length > limit) break;
  }
  return { folders: rows.slice(0, limit), next_id: nextId(rows, limit) };
}

function checkExpectedVersion(version) { if (!isVersionText(version)) fail('invalid_request'); }

// Owner edits are compare-and-set on acl_version (F02). An ACL equal to the stored one writes nothing whatever the
// expected version, so a retry after a lost response is answered unchanged.
function setAcl(ctx, table, notFound, action, { p_workspace_id: w, id, p_acl: acl, p_expected_version: expected }) {
  let x = lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  checkExpectedVersion(expected);
  const normalized = normalizeAcl(acl);
  const row = ctx.q.get(`select acl,acl_version from ${table} where workspace_id=? and id=?`, w, id) ?? fail(notFound);
  if (row.acl === normalized) return { access_epoch: String(x.access_epoch), changed: false, acl_version: String(row.acl_version) };
  if (String(row.acl_version) !== expected) fail('acl_version_mismatch');
  requireAclMembers(ctx, w, normalized);
  ctx.q.run(`update ${table} set acl=?,acl_version=acl_version+1 where workspace_id=? and id=?`, normalized, w, id);
  ctx.q.run('update workspaces set access_epoch=access_epoch+1 where id=?', w);
  x = getWorkspace(ctx, w);
  audit(ctx, w, action, id);
  signal(ctx, w);
  return { access_epoch: String(x.access_epoch), changed: true, acl_version: String(row.acl_version + 1) };
}
const setFolderAcl = (ctx, a) => setAcl(ctx, 'folders', 'folder_not_found', 'set_folder_acl', { ...a, id: a.p_folder_id });
const setDocumentAcl = (ctx, a) => setAcl(ctx, 'documents', 'document_not_found', 'set_document_acl', { ...a, id: a.p_document_id });

// The stored ACL and version for an owner's edit.
function getAcl(ctx, { p_workspace_id: w, p_kind: kind, p_id: id }) {
  lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  if (kind !== 'folder' && kind !== 'document') fail('invalid_request');
  const row = ctx.q.get(`select id,acl,acl_version from ${kind === 'folder' ? 'folders' : 'documents'} where workspace_id=? and id=?`, w, id)
    ?? fail(kind === 'folder' ? 'folder_not_found' : 'document_not_found');
  return { id: row.id, acl: parseJson(row.acl), acl_version: String(row.acl_version) };
}

// Every folder or document with its ACL, including rows whose ACL leaves the owner out. Metadata only, never content.
function listAcls(ctx, { p_workspace_id: w, p_kind: kind, p_after_id: after, p_limit: limit }) {
  lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  if (kind !== 'folder' && kind !== 'document') fail('invalid_request');
  checkLimit(limit);
  let entries;
  if (kind === 'folder') {
    entries = ctx.q.all('select id,parent_id,acl,acl_version from folders where workspace_id=? and (? is null or id>?) order by id limit ?', w, after, after, limit + 1)
      .map(f => ({ id: f.id, parent_id: f.parent_id, acl: parseJson(f.acl), acl_version: String(f.acl_version) }));
  } else {
    entries = ctx.q.all(`select id,folder_id,deleted,deleted_at,ciphertext is null as gone,acl,acl_version from documents
      where workspace_id=? and (? is null or id>?) order by id limit ?`, w, after, after, limit + 1)
      .map(d => ({ id: d.id, folder_id: d.folder_id, deleted: !!d.deleted, deleted_at: utcText(d.deleted_at),
        purged: !!d.deleted && !!d.gone, acl: parseJson(d.acl), acl_version: String(d.acl_version) }));
  }
  return { entries: entries.slice(0, limit), next_id: nextId(entries, limit) };
}

/* ---------- documents ---------- */

function receiptFor(ctx, w, op, hash) {
  const old = ctx.q.get('select request_hash,receipt from receipts where workspace_id=? and actor_id=? and op_id=?', w, ctx.uid, op);
  if (!old) return null;
  if (!Buffer.from(old.request_hash).equals(hash)) fail('op_id_reused');
  return JSON.parse(old.receipt);
}
function storeReceipt(ctx, w, op, hash, result) {
  ctx.q.run('insert into receipts(workspace_id,actor_id,op_id,request_hash,receipt) values(?,?,?,?,?)', w, ctx.uid, op, hash, JSON.stringify(result));
  return result;
}

function createDocument(ctx, { p_workspace_id: w, p_document_id: d, p_folder_id: folder, p_kind: kind, p_ciphertext: cipher, p_key_epoch: keyEpoch, p_op_id: opId }) {
  lockWorkspace(ctx, w);
  if (folderRank(ctx, w, folder) < 2) fail('forbidden');
  // Without p_op_id the document id is the op id; either way it shares the push op_id namespace.
  const op = opId ?? d;
  const hash = sha256(canonicalJson(['create', d, folder, kind, cipher, keyEpoch]));
  const old = op === null ? null : receiptFor(ctx, w, op, hash);
  if (old) {
    if (documentRank(ctx, w, d) < 2) fail('forbidden');
    return old;
  }
  // Validated after the receipt lookup, like the ciphertext, so a replay always gets its receipt.
  if (d === null || !['meeting', 'agenda', 'note'].includes(kind)) fail('invalid_request');
  cipherOk(cipher, keyEpoch, 1, w, d);
  if (getDocument(ctx, w, d)) fail('id_conflict');
  // The ACL stays NULL: a new document inherits its folder chain and the workspace role (F01).
  ctx.q.run('insert into documents(workspace_id,id,folder_id,kind,ciphertext,key_epoch) values(?,?,?,?,?,?)', w, d, folder, kind, JSON.stringify(cipher), keyEpoch);
  const head = appendChange(ctx, w, d);
  return storeReceipt(ctx, w, op, hash, { op_id: op, document_id: d, status: 'applied', revision: '1', head: String(head) });
}

function pushDocument(ctx, { p_workspace_id: w, p_document_id: d, p_op_id: op, p_base_revision: base, p_ciphertext: cipher, p_deleted: deleted, p_key_epoch: keyEpoch }) {
  const x = lockWorkspace(ctx, w);
  if (documentRank(ctx, w, d) < 2) fail('forbidden');
  if (op === null || deleted === null || !isVersionText(base)) fail('invalid_push');
  const hash = sha256(canonicalJson([d, base, cipher, deleted, keyEpoch]));
  const old = receiptFor(ctx, w, op, hash);
  if (old) return old;
  let doc = getDocument(ctx, w, d);
  cipherOk(cipher, keyEpoch, doc.key_epoch, w, d);
  const answer = status => ({ op_id: op, document_id: d, status, revision: String(doc.revision), head: String(x.head) });
  let result;
  // A deleted document is reported before any revision comparison, so no push revives it; restore_document does.
  if (doc.deleted) result = answer('deleted');
  else if (String(doc.revision) !== base) result = answer('conflict');
  else {
    if (deleted) {
      // To the trash (F27): the stored content stays for a restore; the request's ciphertext is validated and hashed only.
      ctx.q.run('update documents set deleted=1,deleted_at=?,revision=revision+1 where workspace_id=? and id=?', ctx.now(), w, d);
    } else {
      ctx.q.run('update documents set ciphertext=?,revision=revision+1,key_epoch=? where workspace_id=? and id=?', JSON.stringify(cipher), keyEpoch, w, d);
    }
    const head = appendChange(ctx, w, d);
    doc = getDocument(ctx, w, d);
    result = { op_id: op, document_id: d, status: 'applied', revision: String(doc.revision), head: String(head) };
  }
  return storeReceipt(ctx, w, op, hash, result);
}

// Brings a document back from the trash for anyone who may edit it (F27).
function restoreDocument(ctx, { p_workspace_id: w, p_document_id: d, p_op_id: op, p_base_revision: base }) {
  const x = lockWorkspace(ctx, w);
  if (documentRank(ctx, w, d) < 2) fail('forbidden');
  if (op === null || !isVersionText(base)) fail('invalid_request');
  const hash = sha256(canonicalJson(['restore', d, base]));
  const old = receiptFor(ctx, w, op, hash);
  if (old) return old;
  let doc = getDocument(ctx, w, d);
  const answer = status => ({ op_id: op, document_id: d, status, revision: String(doc.revision), head: String(x.head) });
  let result;
  // Live: someone restored it already.
  if (!doc.deleted) result = answer('conflict');
  // Still deleted, at another revision: retry with that base.
  else if (String(doc.revision) !== base) result = answer('deleted');
  // Past the window, purged or not. Nothing is stored, and later calls get the same answer.
  else if (doc.ciphertext === null || doc.deleted_at <= ctx.now() - TRASH_RETENTION_US) fail('restore_expired');
  else {
    ctx.q.run('update documents set deleted=0,deleted_at=null,revision=revision+1 where workspace_id=? and id=?', w, d);
    const head = appendChange(ctx, w, d);
    audit(ctx, w, 'restore_document', d);
    doc = getDocument(ctx, w, d);
    result = { op_id: op, document_id: d, status: 'applied', revision: String(doc.revision), head: String(head) };
  }
  return storeReceipt(ctx, w, op, hash, result);
}

// Walks items in order and keeps them while their JSON sizes fit the byte budget; the first one always fits.
// Returns how many were taken.
function budgeted(items, out) {
  let total = 0;
  for (const [i, item] of items.entries()) {
    const size = byteLength(item);
    if (out.length > 0 && total + size > PAGE_BUDGET) return i;
    total += size;
    out.push(item);
  }
  return items.length;
}

// Trash entries the caller may restore (document_rank >= 2, so readers never see deleted content), by id.
function listTrash(ctx, { p_workspace_id: w, p_after_id: after, p_limit: limit }) {
  const x = lockWorkspace(ctx, w);
  if (roleRank(ctx, w) < 1) fail('forbidden');
  checkLimit(limit);
  const ids = [];
  const trashSql = `select id from documents where workspace_id=?${after === null ? '' : ' and id>?'} and deleted=1 and ciphertext is not null
      and deleted_at>? order by id`;
  for (const { id } of ctx.q.iterate(trashSql, w, ...(after === null ? [] : [after]), ctx.now() - TRASH_RETENTION_US)) {
    if (documentRank(ctx, w, id) >= 2) ids.push(id);
    if (ids.length > limit) break;
  }
  const items = ids.slice(0, limit).map(id => {
    const d = getDocument(ctx, w, id);
    return { id: d.id, folder_id: d.folder_id, kind: d.kind, key_epoch: d.key_epoch, revision: String(d.revision),
      deleted_at: utcText(d.deleted_at), purge_after: utcText(d.deleted_at + TRASH_RETENTION_US), ciphertext: JSON.parse(d.ciphertext) };
  });
  const documents = [];
  const taken = budgeted(items, documents);
  // The page ends after p_limit entries or before the first entry that does not fit; next_id is the last included id.
  const more = taken < items.length || ids.length > limit;
  return { documents, next_id: more ? documents.at(-1).id : null, head: String(x.head), access_epoch: String(x.access_epoch) };
}

// Clears expired trash content (F27); sync_maintainer only. One workspace per call, lowest id first; the caller loops
// while more is true. Clients read deleted documents as ciphertext null already, so nothing they read changes.
function purgeExpiredTrash(ctx, { p_limit: limit }) {
  checkLimit(limit);
  const cutoff = ctx.now() - TRASH_RETENTION_US;
  const pick = ctx.q.get('select min(workspace_id) as w from documents where deleted=1 and ciphertext is not null and deleted_at<=?', cutoff);
  if (!pick?.w) return { purged: 0, more: false };
  const w = pick.w;
  let purged = 0;
  for (const { id: d } of ctx.q.all('select id from documents where workspace_id=? and deleted=1 and ciphertext is not null and deleted_at<=? order by id limit ?', w, cutoff, limit)) {
    ctx.q.run('update documents set ciphertext=null where workspace_id=? and id=?', w, d);
    ctx.q.run("update journal set snapshot=json_set(snapshot,'$.ciphertext',null) where workspace_id=? and document_id=? and json_type(snapshot,'$.ciphertext')<>'null'", w, d);
    ctx.q.run('delete from key_envelopes where workspace_id=? and document_id=?', w, d);
    ctx.q.run('insert or ignore into storage_deletions(path,workspace_id,queued_at) select storage_path,workspace_id,? from attachments where workspace_id=? and document_id=?', ctx.now(), w, d);
    ctx.q.run('delete from attachments where workspace_id=? and document_id=?', w, d);
    audit(ctx, w, 'purge_document', d, { anonymous: true });
    purged++;
  }
  const more = !!ctx.q.get('select 1 from documents where deleted=1 and ciphertext is not null and deleted_at<=? limit 1', cutoff);
  return { purged, more };
}

// The AI switch (F29 minimum). AI use is not visibility, so the epoch stays.
function setAiEnabled(ctx, { p_workspace_id: w, p_enabled: enabled }) {
  const x = lockWorkspace(ctx, w);
  requireOwner(ctx, w);
  if (enabled === null) fail('invalid_request');
  if (!!x.ai_enabled === enabled) return { ai_enabled: enabled, changed: false };
  ctx.q.run('update workspaces set ai_enabled=? where id=?', enabled ? 1 : 0, w);
  audit(ctx, w, 'set_ai_enabled', null);
  signal(ctx, w);
  return { ai_enabled: enabled, changed: true };
}

/* ---------- reads ---------- */

function pullChanges(ctx, { p_workspace_id: w, p_after: after, p_limit: limit, p_expected_epoch: expected }) {
  const x = lockWorkspace(ctx, w);
  if (roleRank(ctx, w) < 1) fail('forbidden');
  if (after === null || !/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > MAX_BIGINT) fail('invalid_cursor');
  checkLimit(limit);
  if (BigInt(after) > BigInt(x.head)) fail('cursor_ahead');
  const afterSeq = Number(after);
  const base = { head: String(x.head), access_epoch: String(x.access_epoch) };
  if (expected !== String(x.access_epoch)) return { reset_required: true, changes: [], scanned_through: String(afterSeq), ...base };
  // The window is at most p_limit journal rows. Each document in it is sent once: its current snapshot with seq = its
  // greatest seq in the window, in that seq order. Hidden documents are skipped. When the byte budget cuts the page,
  // scanned_through stops just below the cut document's seq, so it and every later one come in a later page.
  const window = ctx.q.all(`select document_id,max(seq) as last_seq from
    (select document_id,seq from journal where workspace_id=? and seq>? order by seq limit ?) group by document_id order by last_seq`, w, afterSeq, limit);
  const changes = [];
  let scanned = afterSeq, total = 0;
  for (const item of window) {
    if (documentRank(ctx, w, item.document_id) > 0) {
      const change = { ...snapshot(getDocument(ctx, w, item.document_id)), seq: String(item.last_seq) };
      const size = byteLength(change);
      if (changes.length > 0 && total + size > PAGE_BUDGET) { scanned = item.last_seq - 1; break; }
      total += size;
      changes.push(change);
    }
    scanned = item.last_seq;
  }
  return { reset_required: false, changes, scanned_through: String(scanned), ...base };
}

function listAccessibleDocuments(ctx, { p_workspace_id: w, p_after_id: after, p_limit: limit, p_expected_epoch: expected }) {
  const x = lockWorkspace(ctx, w);
  if (roleRank(ctx, w) < 1) fail('forbidden');
  checkLimit(limit);
  const base = { head: String(x.head), access_epoch: String(x.access_epoch) };
  // Only an access change restarts a listing; writes made meanwhile are pulled from the first page's head.
  if ((after !== null && expected === null) || (expected !== null && expected !== String(x.access_epoch))) {
    return { restart_required: true, documents: [], next_id: null, ...base };
  }
  // Metadata only; content comes from get_documents. Access is evaluated row by row (F22).
  const rows = [];
  const documentSql = `select id,revision from documents where workspace_id=?${after === null ? '' : ' and id>?'} and deleted=0 order by id`;
  for (const d of ctx.q.iterate(documentSql, w, ...(after === null ? [] : [after]))) {
    if (documentRank(ctx, w, d.id) > 0) rows.push({ id: d.id, revision: String(d.revision) });
    if (rows.length > limit) break;
  }
  return { restart_required: false, documents: rows.slice(0, limit), next_id: nextId(rows, limit), ...base };
}

function getDocuments(ctx, { p_workspace_id: w, p_ids: ids, p_expected_epoch: expected }) {
  const x = lockWorkspace(ctx, w);
  if (roleRank(ctx, w) < 1) fail('forbidden');
  if (ids === null || ids.length < 1 || ids.length > 500) fail('invalid_request');
  // Every element a uuid (no null, no nested array), and no duplicates.
  const canonical = ids.map(id => uuidCast(id) ?? fail('invalid_request'));
  if (new Set(canonical).size !== canonical.length) fail('invalid_request');
  const base = { head: String(x.head), access_epoch: String(x.access_epoch) };
  if (expected !== String(x.access_epoch)) return { restart_required: true, documents: [], processed: 0, ...base };
  // A hidden or missing id is skipped and counted as processed, so the answer reveals nothing about it. The walk stops
  // before the first visible document that does not fit the byte budget; the first visible document always fits.
  const documents = [];
  let processed = 0, total = 0;
  for (const id of canonical) {
    if (documentRank(ctx, w, id) > 0) {
      const snap = snapshot(getDocument(ctx, w, id));
      const size = byteLength(snap);
      if (documents.length > 0 && total + size > PAGE_BUDGET) break;
      total += size;
      documents.push(snap);
    }
    processed++;
  }
  return { restart_required: false, documents, processed, ...base };
}

/* ---------- registry ---------- */
const W = ['p_workspace_id', 'uuid'];
const AFTER = ['p_after_id', 'uuid', null];
const LIMIT = ['p_limit', 'integer', 100];

export const SYNC_RPCS = [
  { name: 'create_workspace', roles: AUTH, params: [W, ['p_name', 'text']], fn: createWorkspace },
  { name: 'set_member', roles: AUTH, params: [W, ['p_user_id', 'uuid'], ['p_role', 'text']], fn: setMember },
  { name: 'invite_member', roles: AUTH, params: [W, ['p_user_id', 'uuid'], ['p_role', 'text']], fn: inviteMember },
  { name: 'respond_invitation', roles: AUTH, params: [W, ['p_accept', 'boolean']], fn: respondInvitation },
  { name: 'leave_workspace', roles: AUTH, params: [W], fn: leaveWorkspace },
  { name: 'offer_ownership', roles: AUTH, params: [W, ['p_user_id', 'uuid']], fn: offerOwnership },
  { name: 'accept_ownership', roles: AUTH, params: [W], fn: acceptOwnership },
  { name: 'list_my_workspaces', roles: AUTH, params: [AFTER, LIMIT], fn: listMyWorkspaces },
  { name: 'list_members', roles: AUTH, params: [W, AFTER, LIMIT], fn: listMembers },
  { name: 'list_invitations', roles: AUTH, params: [W, AFTER, LIMIT], fn: listInvitations },
  { name: 'list_my_invitations', roles: AUTH, params: [AFTER, LIMIT], fn: listMyInvitations },
  { name: 'create_folder', roles: AUTH, params: [W, ['p_folder_id', 'uuid'], ['p_parent_id', 'uuid', null], ['p_acl', 'json', null]], fn: createFolder },
  { name: 'list_folders', roles: AUTH, params: [W, AFTER, LIMIT], fn: listFolders },
  { name: 'set_folder_acl', roles: AUTH, params: [W, ['p_folder_id', 'uuid'], ['p_acl', 'json'], ['p_expected_version', 'text']], fn: setFolderAcl },
  { name: 'get_acl', roles: AUTH, params: [W, ['p_kind', 'text'], ['p_id', 'uuid']], fn: getAcl },
  { name: 'list_acls', roles: AUTH, params: [W, ['p_kind', 'text'], AFTER, LIMIT], fn: listAcls },
  { name: 'create_document', roles: AUTH, params: [W, ['p_document_id', 'uuid'], ['p_folder_id', 'uuid'], ['p_kind', 'text'], ['p_ciphertext', 'json'], ['p_key_epoch', 'integer', 1], ['p_op_id', 'uuid', null]], fn: createDocument },
  { name: 'set_document_acl', roles: AUTH, params: [W, ['p_document_id', 'uuid'], ['p_acl', 'json'], ['p_expected_version', 'text']], fn: setDocumentAcl },
  { name: 'push_document', roles: AUTH, params: [W, ['p_document_id', 'uuid'], ['p_op_id', 'uuid'], ['p_base_revision', 'text'], ['p_ciphertext', 'json'], ['p_deleted', 'boolean', false], ['p_key_epoch', 'integer', 1]], fn: pushDocument },
  { name: 'restore_document', roles: AUTH, params: [W, ['p_document_id', 'uuid'], ['p_op_id', 'uuid'], ['p_base_revision', 'text']], fn: restoreDocument },
  { name: 'list_trash', roles: AUTH, params: [W, AFTER, LIMIT], fn: listTrash },
  { name: 'set_ai_enabled', roles: AUTH, params: [W, ['p_enabled', 'boolean']], fn: setAiEnabled },
  { name: 'pull_changes', roles: AUTH, params: [W, ['p_after', 'text'], LIMIT, ['p_expected_epoch', 'text', null]], fn: pullChanges },
  { name: 'list_accessible_documents', roles: AUTH, params: [W, AFTER, LIMIT, ['p_expected_epoch', 'text', null]], fn: listAccessibleDocuments },
  { name: 'get_documents', roles: AUTH, params: [W, ['p_ids', 'uuid[]'], ['p_expected_epoch', 'text']], fn: getDocuments },
  { name: 'purge_expired_trash', roles: ['sync_maintainer'], params: [LIMIT], fn: purgeExpiredTrash },
];
