import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, uuid, cipher, rejects, rejectsUnchanged, join, setAcl } from './harness.mjs';
import { RPC_NAMES } from '../rpc/index.js';

const [A, B, C, E] = [uuid(1), uuid(2), uuid(3), uuid(5)];
const W = uuid(10), W2 = uuid(11), MISSING = uuid(404);
const D = uuid(20), D2 = uuid(21), F = uuid(30), F2 = uuid(31);
const op = n => uuid(900 + n);
const epoch = t => t.row('select access_epoch from workspaces where id=?', W).access_epoch;

test('R1: every workspace RPC refuses an outsider alike for an existing and a missing workspace, before any argument check, and writes nothing', () => {
  const t = setup({ users: [1, 3] });
  try {
    t.as(A, 'create_workspace', [W, 'R1']);
    t.as(A, 'create_document', [W, D, null, 'note', cipher(W, D)]);
    // Deliberately invalid arguments: the access answer must come first.
    const calls = {
      set_member: w => [w, null, 'nope'], invite_member: w => [w, null, 'nope'], respond_invitation: w => [w, null],
      leave_workspace: w => [w], offer_ownership: w => [w, C], accept_ownership: w => [w], list_members: w => [w, null, 0],
      list_invitations: w => [w, null, 0], create_folder: w => [w, null, null, 'bad'], list_folders: w => [w, null, 0],
      set_folder_acl: w => [w, F, 'bad', 'x'], get_acl: w => [w, 'nope', F], list_acls: w => [w, 'nope', null, 0],
      create_document: w => [w, null, null, 'nope', null], set_document_acl: w => [w, D, 'bad', 'x'],
      push_document: w => [w, D, null, 'x', null], restore_document: w => [w, D, null, 'x'], list_trash: w => [w, null, 0],
      set_ai_enabled: w => [w, null], pull_changes: w => [w, 'x', 0, null], list_accessible_documents: w => [w, null, 0, null],
      get_documents: w => [w, [null, null], null],
    };
    const workspaceRpcs = RPC_NAMES.authenticated.filter(n => !['create_workspace', 'list_my_workspaces', 'list_my_invitations'].includes(n) && !n.startsWith('ai_'));
    assert.deepEqual(Object.keys(calls).sort(), workspaceRpcs.sort());
    for (const [name, args] of Object.entries(calls)) {
      for (const w of [W, MISSING]) rejectsUnchanged(t, () => t.as(C, name, args(w)), 'forbidden');
      rejectsUnchanged(t, () => t.as('', name, args(W)), 'unauthenticated');
    }
  } finally { t.close(); }
});

test('membership (F13): invitations are the only way in; each answer changes exactly what it should', () => {
  const t = setup({ users: [1, 2, 3] });
  try {
    t.as(A, 'create_workspace', [W, 'Team']);
    rejects(() => t.as(A, 'set_member', [W, B, 'editor']), 'member_not_found');
    rejects(() => t.as(A, 'invite_member', [W, B, 'owner']), 'invalid_role');
    rejects(() => t.as(A, 'invite_member', [W, A, 'editor']), 'already_member');
    const e0 = epoch(t);
    assert.deepEqual(t.as(A, 'invite_member', [W, B, 'viewer']), { changed: true });
    assert.deepEqual(t.as(A, 'invite_member', [W, B, 'viewer']), { changed: false });
    assert.deepEqual(t.as(A, 'invite_member', [W, B, 'editor']), { changed: true });
    assert.equal(epoch(t), e0, 'an invitation changes no access');
    // An invitation to an id without an account is accepted alike (no account oracle) and signals nobody.
    assert.deepEqual(t.as(A, 'invite_member', [W, E, 'viewer']), { changed: true });
    assert.equal(t.row('select count(*) n from user_signals where user_id=?', E).n, 0);
    const mine = t.as(B, 'list_my_invitations', {});
    assert.deepEqual(mine.invitations.map(i => [i.workspace_id, i.name, i.role]), [[W, 'Team', 'editor']]);
    assert.match(mine.invitations[0].invited_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    rejects(() => t.as(C, 'respond_invitation', [W, true]), 'forbidden');
    assert.deepEqual(t.as(B, 'respond_invitation', [W, true]), { changed: true, role: 'editor', access_epoch: String(e0 + 1) });
    assert.deepEqual(t.as(B, 'respond_invitation', [W, true]), { changed: false, role: 'editor', access_epoch: String(e0 + 1) });
    rejects(() => t.as(A, 'invite_member', [W, B, 'viewer']), 'already_member');
    // Decline, revoke.
    t.as(A, 'invite_member', [W, C, 'viewer']);
    assert.deepEqual(t.as(C, 'respond_invitation', [W, false]), { changed: true, role: null, access_epoch: String(e0 + 1) });
    rejects(() => t.as(C, 'respond_invitation', [W, false]), 'forbidden');
    t.as(A, 'invite_member', [W, C, 'viewer']);
    assert.deepEqual(t.as(A, 'invite_member', [W, C, null]), { changed: true });
    assert.deepEqual(t.as(A, 'invite_member', [W, C, null]), { changed: false });
    // Role change and removal, each one epoch bump; no-ops write nothing.
    assert.deepEqual(t.as(A, 'set_member', [W, B, 'viewer']), { access_epoch: String(e0 + 2), changed: true });
    const before = t.state();
    assert.deepEqual(t.as(A, 'set_member', [W, B, 'viewer']), { access_epoch: String(e0 + 2), changed: false });
    assert.deepEqual(t.as(A, 'set_member', [W, C, null]), { access_epoch: String(e0 + 2), changed: false });
    assert.deepEqual(t.state(), before);
    rejects(() => t.as(A, 'set_member', [W, A, 'editor']), 'owner_change_not_supported');
    rejects(() => t.as(A, 'set_member', [W, B, 'admin']), 'invalid_role');
    rejects(() => t.as(B, 'set_member', [W, B, 'editor']), 'forbidden');
    // Leaving.
    rejects(() => t.as(A, 'leave_workspace', [W]), 'owner_must_transfer');
    assert.deepEqual(t.as(B, 'leave_workspace', [W]), { changed: true, access_epoch: String(e0 + 3) });
    rejects(() => t.as(B, 'leave_workspace', [W]), 'forbidden');
    const actions = t.rows('select action from audit where workspace_id=? order by id', W).map(r => r.action);
    assert.deepEqual(actions, ['create_workspace', 'invite_member', 'invite_member', 'invite_member', 'accept_invitation', 'invite_member',
      'decline_invitation', 'invite_member', 'revoke_invitation', 'set_member', 'leave_workspace']);
  } finally { t.close(); }
});

test('ownership: an offer changes no access, only the offeree accepts, and a role change withdraws it', () => {
  const t = setup({ users: [1, 2, 3] });
  try {
    t.as(A, 'create_workspace', [W, 'Hand over']);
    join(t, A, W, B, 'editor');
    join(t, A, W, C, 'viewer');
    const e = epoch(t);
    rejects(() => t.as(A, 'offer_ownership', [W, A]), 'owner_change_not_supported');
    rejects(() => t.as(A, 'offer_ownership', [W, uuid(9)]), 'member_not_found');
    assert.deepEqual(t.as(A, 'offer_ownership', [W, B]), { changed: true, pending_owner_id: B });
    assert.deepEqual(t.as(A, 'offer_ownership', [W, B]), { changed: false, pending_owner_id: B });
    assert.equal(epoch(t), e);
    assert.equal(t.as(B, 'list_my_workspaces', {}).workspaces[0].ownership_offered, true);
    rejects(() => t.as(C, 'accept_ownership', [W]), 'forbidden');
    // A role change withdraws the offer.
    t.as(A, 'set_member', [W, B, 'viewer']);
    assert.equal(t.row('select pending_owner_id p from workspaces').p, null);
    rejects(() => t.as(B, 'accept_ownership', [W]), 'forbidden');
    t.as(A, 'offer_ownership', [W, C]);
    assert.deepEqual(t.as(A, 'offer_ownership', [W, null]), { changed: true, pending_owner_id: null });
    assert.deepEqual(t.as(A, 'offer_ownership', [W, null]), { changed: false, pending_owner_id: null });
    t.as(A, 'offer_ownership', [W, C]);
    const accepted = t.as(C, 'accept_ownership', [W]);
    assert.equal(accepted.changed, true);
    assert.deepEqual(t.as(C, 'accept_ownership', [W]), { changed: false, access_epoch: accepted.access_epoch });
    assert.deepEqual(t.rows('select user_id,role from members order by user_id'), [{ user_id: A, role: 'editor' }, { user_id: B, role: 'viewer' }, { user_id: C, role: 'owner' }]);
    assert.equal(t.as(A, 'leave_workspace', [W]).changed, true);
  } finally { t.close(); }
});

test('ACLs (F02, F12, F15): canonical member-only keys, compare-and-set, {} denies everyone, null inherits', () => {
  const t = setup({ users: [1, 2, 3] });
  try {
    t.as(A, 'create_workspace', [W, 'ACL']);
    join(t, A, W, B, 'editor');
    assert.deepEqual(t.as(A, 'create_folder', [W, F]), { id: F, acl_version: '1' });
    t.as(A, 'create_document', [W, D, F, 'note', cipher(W, D)]);
    rejects(() => t.as(A, 'create_folder', [W, F]), 'id_conflict');
    rejects(() => t.as(B, 'create_folder', [W, F2]), 'forbidden');
    for (const acl of ['x', [], { [B]: 'owner' }, { 'not-a-uuid': 'viewer' }, { [B]: 'viewer', [`{${B}}`]: 'editor' }]) {
      rejects(() => t.as(A, 'set_folder_acl', [W, F, acl, '1']), 'invalid_acl');
    }
    rejects(() => t.as(A, 'set_folder_acl', [W, F, { [C]: 'viewer' }, '1']), 'member_not_found');
    for (const v of [null, '0', '01', 'x']) rejects(() => t.as(A, 'set_folder_acl', [W, F, {}, v]), 'invalid_request');
    rejects(() => t.as(A, 'set_folder_acl', [W, uuid(99), {}, '1']), 'folder_not_found');
    const e = epoch(t);
    // Spellings of one uuid are stored canonically.
    const set = t.as(A, 'set_folder_acl', [W, F, { [`{${B.toUpperCase()}}`]: 'viewer' }, '1']);
    assert.deepEqual(set, { access_epoch: String(e + 1), changed: true, acl_version: '2' });
    assert.deepEqual(t.as(A, 'get_acl', [W, 'folder', F]), { id: F, acl: { [B]: 'viewer' }, acl_version: '2' });
    // Equal ACL: unchanged whatever the expected version; a different one with a stale version is refused.
    assert.deepEqual(t.as(A, 'set_folder_acl', [W, F, { [B]: 'viewer' }, '1']), { access_epoch: String(e + 1), changed: false, acl_version: '2' });
    rejects(() => t.as(A, 'set_folder_acl', [W, F, { [B]: 'editor' }, '1']), 'acl_version_mismatch');
    // The owner manages a folder that leaves the owner out, but cannot see inside it.
    setAcl(t, A, 'folder', W, F, { [B]: 'editor' });
    rejects(() => t.as(A, 'push_document', [W, D, op(1), '1', cipher(W, D, 1, 'z')]), 'forbidden');
    assert.equal(t.as(B, 'push_document', [W, D, op(2), '1', cipher(W, D, 1, 'z')]).status, 'applied');
    assert.deepEqual(t.as(A, 'list_acls', [W, 'folder', null, 100]).entries, [{ id: F, parent_id: null, acl: { [B]: 'editor' }, acl_version: '3' }]);
    assert.deepEqual(t.as(A, 'list_acls', [W, 'document', null, 100]).entries, [{ id: D, folder_id: F, deleted: false, deleted_at: null, purged: false, acl: null, acl_version: '1' }]);
    // {} denies everyone, owner included; null inherits again.
    setAcl(t, A, 'document', W, D, {});
    rejects(() => t.as(B, 'push_document', [W, D, op(3), '2', cipher(W, D, 1, 'y')]), 'forbidden');
    setAcl(t, A, 'document', W, D, null);
    assert.equal(t.as(B, 'push_document', [W, D, op(3), '2', cipher(W, D, 1, 'y')]).status, 'applied');
    rejects(() => t.as(A, 'get_acl', [W, 'document', uuid(99)]), 'document_not_found');
  } finally { t.close(); }
});

test('inheritance (F01) and removal (F12): the folder chain caps the workspace role; removing a member strips its keys', () => {
  const t = setup({ users: [1, 2, 3] });
  try {
    t.as(A, 'create_workspace', [W, 'Tree']);
    join(t, A, W, B, 'editor');
    join(t, A, W, C, 'viewer');
    t.as(A, 'create_folder', [W, F]);
    t.as(A, 'create_folder', [W, F2, F]);
    t.as(A, 'create_document', [W, D, F2, 'note', cipher(W, D)]);
    // Viewer role caps a folder editor grant.
    setAcl(t, A, 'folder', W, F, { [A]: 'editor', [B]: 'viewer', [C]: 'editor' });
    rejects(() => t.as(B, 'push_document', [W, D, op(1), '1', cipher(W, D, 1, 'b')]), 'forbidden');
    rejects(() => t.as(C, 'push_document', [W, D, op(1), '1', cipher(W, D, 1, 'b')]), 'forbidden');
    assert.deepEqual(t.as(C, 'list_folders', [W, null, 100]).folders, [{ id: F, parent_id: null, can_edit: false }, { id: F2, parent_id: F, can_edit: false }]);
    assert.deepEqual(t.as(A, 'list_folders', [W, null, 1]), { folders: [{ id: F, parent_id: null, can_edit: true }], next_id: F });
    // A restricted ancestor hides its whole subtree.
    setAcl(t, A, 'folder', W, F, { [A]: 'editor' });
    assert.deepEqual(t.as(B, 'list_folders', [W, null, 100]).folders, []);
    assert.deepEqual(t.as(B, 'list_accessible_documents', [W, null, 100, null]).documents, []);
    // Removal strips the member's keys everywhere, with version bumps; re-joining starts from inheritance.
    setAcl(t, A, 'folder', W, F, { [A]: 'editor', [B]: 'editor' });
    setAcl(t, A, 'document', W, D, { [B]: 'editor' });
    t.as(A, 'set_member', [W, B, null]);
    assert.deepEqual(t.rows('select acl,acl_version from folders where id=?', F), [{ acl: JSON.stringify({ [A]: 'editor' }), acl_version: 5 }]);
    assert.deepEqual(t.rows('select acl,acl_version from documents where id=?', D), [{ acl: '{}', acl_version: 3 }]);
    join(t, A, W, B, 'editor');
    assert.deepEqual(t.as(B, 'list_folders', [W, null, 100]).folders, []);
  } finally { t.close(); }
});

test('lists (R5, R6): exact shapes, keyset pages with next_id only while more exist, [] when empty', () => {
  const t = setup({ users: [1, 2, 3] });
  try {
    t.as(A, 'create_workspace', [W2, 'Second']);
    t.as(A, 'create_workspace', [W, 'First']);
    join(t, A, W, B, 'editor');
    for (const limit of [0, 501]) rejects(() => t.as(A, 'list_my_workspaces', [null, limit]), 'invalid_limit');
    assert.deepEqual(t.as(A, 'list_my_workspaces', [null, 1]), {
      workspaces: [{ id: W, name: 'First', role: 'owner', member_count: 2, ai_enabled: false, ownership_offered: false }], next_id: W });
    assert.deepEqual(t.as(A, 'list_my_workspaces', [W, 1]).next_id, null);
    assert.deepEqual(t.as(C, 'list_my_workspaces', {}), { workspaces: [], next_id: null });
    assert.deepEqual(t.as(B, 'list_members', [W, null, 1]), { members: [{ user_id: A, role: 'owner' }], next_id: A, access_epoch: '2' });
    assert.deepEqual(t.as(B, 'list_members', [W, A, 1]).members, [{ user_id: B, role: 'editor' }]);
    rejects(() => t.as(B, 'list_invitations', [W, null, 100]), 'forbidden');
    t.as(A, 'invite_member', [W, C, 'viewer']);
    const inv = t.as(A, 'list_invitations', [W, null, 100]);
    assert.deepEqual([inv.invitations.map(i => [i.user_id, i.role]), inv.next_id, inv.pending_owner_id], [[[C, 'viewer']], null, null]);
    assert.deepEqual(t.as(C, 'list_my_invitations', [null, 100]).invitations.map(i => i.workspace_id), [W]);
    assert.deepEqual(t.as(A, 'list_acls', [W, 'folder', null, 100]), { entries: [], next_id: null });
    rejects(() => t.as(A, 'list_acls', [W, 'workspace', null, 100]), 'invalid_request');
  } finally { t.close(); }
});

test('I1/I2: access_epoch moves exactly once per access change and never otherwise; head moves only with content', () => {
  const t = setup({ users: [1, 2] });
  try {
    t.as(A, 'create_workspace', [W, 'Epoch']);
    const ws = () => t.row('select head,access_epoch from workspaces where id=?', W);
    const steps = [
      [() => t.as(A, 'create_folder', [W, F]), 0, 0],
      [() => t.as(A, 'create_document', [W, D, F, 'note', cipher(W, D)]), 1, 0],
      [() => t.as(A, 'invite_member', [W, B, 'viewer']), 0, 0],
      [() => t.as(B, 'respond_invitation', [W, true]), 0, 1],
      [() => t.as(A, 'set_member', [W, B, 'editor']), 0, 1],
      [() => setAcl(t, A, 'folder', W, F, { [A]: 'editor' }), 0, 1],
      [() => t.as(A, 'push_document', [W, D, op(1), '1', cipher(W, D, 1, 'b')]), 1, 0],
      [() => t.as(A, 'set_ai_enabled', [W, true]), 0, 0],
      [() => t.as(A, 'offer_ownership', [W, B]), 0, 0],
      [() => t.as(B, 'accept_ownership', [W]), 0, 1],
      [() => t.as(A, 'leave_workspace', [W]), 0, 1],
    ];
    for (const [i, [step, dHead, dEpoch]] of steps.entries()) {
      const before = ws();
      step();
      const after = ws();
      assert.deepEqual([after.head - before.head, after.access_epoch - before.access_epoch], [dHead, dEpoch], `step ${i}`);
    }
    assert.equal(t.row('select count(*) n from journal').n, 2);
  } finally { t.close(); }
});

test('trash and restore (F27): editors keep the content for 720 hours; restore answers applied, conflict, deleted or restore_expired', () => {
  const t = setup({ users: [1, 2] });
  try {
    t.as(A, 'create_workspace', [W, 'Trash']);
    join(t, A, W, B, 'viewer');
    t.as(A, 'create_document', [W, D, null, 'note', cipher(W, D)]);
    t.as(A, 'create_document', [W, D2, null, 'note', cipher(W, D2)]);
    t.as(A, 'push_document', [W, D, op(1), '1', cipher(W, D), true]);
    const trash = t.as(A, 'list_trash', [W, null, 100]);
    assert.deepEqual(trash.documents.map(d => [d.id, d.revision]), [[D, '2']]);
    assert.deepEqual(trash.documents[0].ciphertext, cipher(W, D));
    assert.equal(Date.parse(trash.documents[0].purge_after) - Date.parse(trash.documents[0].deleted_at), 720 * 3600 * 1000);
    // Readers never see deleted content.
    assert.deepEqual(t.as(B, 'list_trash', [W, null, 100]).documents, []);
    rejects(() => t.as(B, 'restore_document', [W, D, op(2), '2']), 'forbidden');
    assert.deepEqual(t.as(A, 'restore_document', [W, D, op(3), '1']).status, 'deleted');
    assert.deepEqual(t.as(A, 'restore_document', [W, D2, op(4), '1']).status, 'conflict');
    rejects(() => t.as(A, 'restore_document', [W, D, op(3), '2']), 'op_id_reused');
    const restored = t.as(A, 'restore_document', [W, D, op(5), '2']);
    assert.deepEqual(restored, { op_id: op(5), document_id: D, status: 'applied', revision: '3', head: '4' });
    assert.deepEqual(t.as(A, 'restore_document', [W, D, op(5), '2']), restored);
    assert.equal(t.as(B, 'get_documents', [W, [D], '2']).documents[0].ciphertext.ciphertext, cipher(W, D).ciphertext);
    // Past the window: restore_expired, stored nowhere.
    t.as(A, 'push_document', [W, D, op(6), '3', cipher(W, D), true]);
    t.advance(720);
    rejectsUnchanged(t, () => t.as(A, 'restore_document', [W, D, op(7), '4']), 'restore_expired');
    assert.deepEqual(t.as(A, 'list_trash', [W, null, 100]).documents, []);
  } finally { t.close(); }
});

test('purge_expired_trash (F27): sync_maintainer only; one workspace per call, lowest id first; clients see nothing change', () => {
  const t = setup({ users: [1] });
  try {
    for (const w of [W2, W]) {
      t.as(A, 'create_workspace', [w, 'Purge']);
      t.as(A, 'create_document', [w, D, null, 'note', cipher(w, D)]);
      t.as(A, 'create_document', [w, D2, null, 'note', cipher(w, D2)]);
      t.as(A, 'push_document', [w, D, op(1), '1', cipher(w, D), true]);
    }
    t.db.prepare("insert into attachments values(?,?,?,'blob/one','d',1)").run(W, D, uuid(70));
    t.db.prepare("insert into key_envelopes values(?,?,?,1,'{}')").run(W, D, A);
    assert.throws(() => t.as(A, 'purge_expired_trash', [100]), e => e.code === '42501');
    assert.deepEqual(t.maint('purge_expired_trash', [100]), { purged: 0, more: false });
    rejects(() => t.maint('purge_expired_trash', [0]), 'invalid_limit');
    t.advance(720);
    const seen = () => t.as(A, 'pull_changes', [W, '0', 100, '1']);
    const before = seen();
    const signals = t.rows('select * from user_signals');
    assert.deepEqual(t.maint('purge_expired_trash', [100]), { purged: 1, more: true });
    assert.equal(t.row('select ciphertext from documents where workspace_id=? and id=?', W, D).ciphertext, null);
    assert.notEqual(t.row('select ciphertext from documents where workspace_id=? and id=?', W2, D).ciphertext, null);
    assert.equal(t.rows("select snapshot from journal where workspace_id=? and document_id=?", W, D).every(r => JSON.parse(r.snapshot).ciphertext === null), true);
    assert.deepEqual([t.row('select count(*) n from attachments').n, t.row('select count(*) n from key_envelopes').n], [0, 0]);
    assert.deepEqual(t.rows('select path,workspace_id from storage_deletions'), [{ path: 'blob/one', workspace_id: W }]);
    assert.deepEqual(seen(), before, 'nothing a client reads changed');
    assert.deepEqual(t.rows('select * from user_signals'), signals);
    assert.equal(t.row("select actor_id from audit where action='purge_document'").actor_id, null);
    assert.deepEqual(t.maint('purge_expired_trash', [100]), { purged: 1, more: false });
    assert.deepEqual(t.maint('purge_expired_trash', [100]), { purged: 0, more: false });
    rejects(() => t.as(A, 'restore_document', [W, D, op(9), '2']), 'restore_expired');
    assert.deepEqual(t.as(A, 'list_acls', [W, 'document', null, 1]).entries[0].purged, true);
  } finally { t.close(); }
});

test('account deletion (F24): sole-member workspaces go, shared ones keep history unlinked; an owner with members must hand over first', () => {
  const t = setup({ users: [1, 2, 3] });
  try {
    t.as(A, 'create_workspace', [W, 'Shared']);
    t.as(B, 'create_workspace', [W2, 'Solo']);
    t.as(B, 'create_document', [W2, D, null, 'note', cipher(W2, D)]);
    join(t, A, W, B, 'editor');
    t.as(A, 'create_folder', [W, F]);
    t.as(B, 'create_document', [W, D, F, 'note', cipher(W, D)]);
    setAcl(t, A, 'folder', W, F, { [A]: 'editor', [B]: 'editor' });
    t.as(A, 'offer_ownership', [W, B]);
    t.as(A, 'invite_member', [W, C, 'viewer']);
    rejectsUnchanged(t, () => t.b.deleteUser(A), 'owner_must_transfer');
    assert.equal(t.b.deleteUser(B), 1);
    assert.equal(t.b.deleteUser(B), 0);
    assert.equal(t.row('select count(*) n from workspaces where id=?', W2).n, 0, 'the solo workspace went');
    for (const table of ['documents', 'journal', 'audit', 'receipts', 'user_signals', 'members']) {
      assert.equal(t.row(`select count(*) n from ${table} where workspace_id=?`, W2).n, 0, table);
    }
    assert.deepEqual(t.rows('select user_id from members where workspace_id=?', W), [{ user_id: A }]);
    assert.equal(t.row('select pending_owner_id p from workspaces where id=?', W).p, null);
    assert.equal(t.row('select acl from folders where id=?', F).acl, JSON.stringify({ [A]: 'editor' }));
    // Shared history stays, unlinked from the person.
    assert.equal(t.row('select count(*) n from journal where workspace_id=? and actor_id is null', W).n, 1);
    assert.equal(t.row('select count(*) n from audit where actor_id=? or target_id=?', B, B).n, 0);
    assert.equal(t.row("select actor_id from audit where action='account_deleted'").actor_id, null);
    for (const table of ['receipts', 'user_signals', 'members']) assert.equal(t.row(`select count(*) n from ${table} where ${table === 'receipts' ? 'actor_id' : 'user_id'}=?`, B).n, 0);
    assert.deepEqual(t.rows('pragma foreign_key_check'), []);
    // The invitee's deletion looks like a decline to the inviting workspace (SEC-2): invitation gone, members signalled.
    const g = t.row('select generation from user_signals where user_id=? and workspace_id=?', A, W).generation;
    assert.equal(t.b.deleteUser(C), 1);
    assert.deepEqual(t.as(A, 'list_invitations', [W, null, 100]).invitations, []);
    assert.equal(t.row('select generation from user_signals where user_id=? and workspace_id=?', A, W).generation, g + 1);
    // A deleted account's still-valid token creates nothing.
    rejects(() => t.as(B, 'create_workspace', [uuid(12), 'Ghost']), 'unauthenticated');
    assert.equal(t.b.deleteUser(A), 1);
    assert.equal(t.row('select count(*) n from workspaces').n, 0);
  } finally { t.close(); }
});

test('an invitation to an id without an account stays; the AI switch is the owner\'s, with no epoch bump', () => {
  const t = setup({ users: [1, 2] });
  try {
    t.as(A, 'create_workspace', [W, 'Switch']);
    t.as(A, 'invite_member', [W, E, 'viewer']);
    assert.equal(t.b.deleteUser(E), 0);
    assert.equal(t.as(A, 'list_invitations', [W, null, 100]).invitations.length, 1);
    join(t, A, W, B, 'editor');
    const e = epoch(t);
    rejects(() => t.as(B, 'set_ai_enabled', [W, true]), 'forbidden');
    rejects(() => t.as(A, 'set_ai_enabled', [W, null]), 'invalid_request');
    assert.deepEqual(t.as(A, 'set_ai_enabled', [W, true]), { ai_enabled: true, changed: true });
    const before = t.state();
    assert.deepEqual(t.as(A, 'set_ai_enabled', [W, true]), { ai_enabled: true, changed: false });
    assert.deepEqual(t.state(), before);
    assert.equal(epoch(t), e);
    assert.equal(t.as(B, 'list_my_workspaces', {}).workspaces[0].ai_enabled, true);
  } finally { t.close(); }
});
