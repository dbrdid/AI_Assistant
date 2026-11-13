import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, uuid, cipher, rejects, rejectsUnchanged, join, setAcl } from './harness.mjs';
import { RPC_NAMES } from '../rpc/index.js';
import { serverError } from '../contracts/errors.js';

const [A, B, C] = [uuid(1), uuid(2), uuid(3)];
const W = uuid(10), D = uuid(20), D2 = uuid(21), F = uuid(30);
const op = n => uuid(900 + n);

function workspace(t) {
  t.as(A, 'create_workspace', [W, 'Synthetic']);
  t.as(A, 'create_document', [W, D, null, 'note', cipher(W, D)]);
}

test('roles replace GRANTs: each role reaches only its allowlist; unknown names and arguments are faults, not contract errors', () => {
  const t = setup({ users: [1] });
  try {
    assert.equal(RPC_NAMES.authenticated.length, 29);
    assert.equal(RPC_NAMES.ai_executor.length, 9);
    assert.deepEqual(RPC_NAMES.sync_maintainer, ['purge_expired_trash']);
    for (const [role, name] of [['authenticated', 'purge_expired_trash'], ['authenticated', 'ai_claim_job'], ['ai_executor', 'create_workspace'],
      ['sync_maintainer', 'list_my_workspaces'], ['anon', 'list_my_workspaces'], ['authenticated', 'no_such_rpc']]) {
      assert.throws(() => t.b.call({ role, uid: A }, name, {}), e => e.code === '42501' && serverError(e.code, e.message) === null, `${role} ${name}`);
    }
    assert.throws(() => t.as(A, 'create_workspace', { p_workspace_id: W, p_name: 'x', p_extra: 1 }), e => e.code === '42883');
    assert.throws(() => t.as(A, 'create_workspace', { p_workspace_id: W }), e => e.code === '42883');
    assert.throws(() => t.as(A, 'create_workspace', [W, 'x', 'too many']), e => e.code === '42883');
    // Named and positional calls are the same call.
    assert.deepEqual(t.as(A, 'create_workspace', { p_workspace_id: W, p_name: 'named' }), { workspace_id: W, head: '0', access_epoch: '1' });
    // Wrong JSON types are invalid_request; uuid spellings PostgreSQL accepted are canonicalised.
    rejects(() => t.as(A, 'create_workspace', [123, 'x']), 'invalid_request');
    rejects(() => t.as(A, 'create_workspace', [uuid(11), 5]), 'invalid_request');
    assert.equal(t.as(A, 'create_workspace', [`{${uuid(12).toUpperCase()}}`, 'braces']).workspace_id, uuid(12));
    // No subject: unauthenticated, before anything else.
    rejects(() => t.as('', 'list_my_workspaces', {}), 'unauthenticated');
    rejects(() => t.as(null, 'create_workspace', [uuid(13), 'x']), 'unauthenticated');
    // A valid token for an account that does not exist creates nothing.
    rejectsUnchanged(t, () => t.as(uuid(99), 'create_workspace', [uuid(14), 'ghost']), 'unauthenticated');
    rejects(() => t.as(A, 'create_workspace', [W, 'again']), 'id_conflict');
    rejects(() => t.as(A, 'create_workspace', [uuid(15), '']), 'invalid_request');
    rejects(() => t.as(A, 'create_workspace', [uuid(15), 'x'.repeat(201)]), 'invalid_request');
    assert.equal(t.as(A, 'create_workspace', [uuid(15), '가'.repeat(200)]).workspace_id, uuid(15));
  } finally { t.close(); }
});

test('documents: create, push, conflict, delete; receipts make retries idempotent and op_id reuse is refused', () => {
  const t = setup({ users: [1, 2] });
  try {
    workspace(t);
    // Replaying create returns the same receipt; the same id with other content is op_id_reused.
    const created = t.as(A, 'create_document', [W, D, null, 'note', cipher(W, D)]);
    assert.deepEqual(created, { op_id: D, document_id: D, status: 'applied', revision: '1', head: '1' });
    rejectsUnchanged(t, () => t.as(A, 'create_document', [W, D, null, 'note', cipher(W, D, 1, 'b')]), 'op_id_reused');
    rejects(() => t.as(A, 'create_document', [W, D2, null, 'note', cipher(W, D2), 1, D]), 'op_id_reused');
    rejects(() => t.as(A, 'create_document', [W, D, null, 'note', cipher(W, D), 1, op(50)]), 'id_conflict');
    rejects(() => t.as(A, 'create_document', [W, D2, null, 'memo', cipher(W, D2)]), 'invalid_request');
    rejects(() => t.as(A, 'create_document', [W, D2, null, 'note', cipher(W, D2, 2), 2]), 'invalid_key_epoch');

    const push = (n, base, value = 'b', deleted = false) => t.as(A, 'push_document', [W, D, op(n), base, cipher(W, D, 1, value), deleted]);
    assert.deepEqual(push(1, '1'), { op_id: op(1), document_id: D, status: 'applied', revision: '2', head: '2' });
    assert.deepEqual(push(1, '1'), { op_id: op(1), document_id: D, status: 'applied', revision: '2', head: '2' });
    rejectsUnchanged(t, () => push(1, '1', 'c'), 'op_id_reused');
    // A stale base is a conflict (stored as a receipt too), never an overwrite.
    assert.deepEqual(push(2, '1', 'c'), { op_id: op(2), document_id: D, status: 'conflict', revision: '2', head: '2' });
    assert.equal(t.row('select count(*) n from receipts').n, 3);
    for (const base of [null, '0', '01', '9223372036854775808', '1.0']) rejects(() => push(3, base), 'invalid_push');
    // To the trash: content kept, then no push revives it.
    assert.equal(push(4, '2', 'x', true).status, 'applied');
    const stored = t.row('select deleted,deleted_at,ciphertext from documents where id=?', D);
    assert.equal(stored.deleted, 1); assert.ok(stored.deleted_at > 0); assert.deepEqual(JSON.parse(stored.ciphertext), cipher(W, D, 1, 'b'));
    assert.deepEqual(push(5, '3', 'y'), { op_id: op(5), document_id: D, status: 'deleted', revision: '3', head: '3' });
    // Journal: one snapshot per revision, deleted ones without content.
    const journal = t.rows('select seq,snapshot from journal order by seq').map(r => JSON.parse(r.snapshot));
    assert.deepEqual(journal.map(s => [s.revision, s.deleted, s.ciphertext === null]), [['1', false, false], ['2', false, false], ['3', true, true]]);
    // A viewer may read but not write.
    join(t, A, W, B, 'viewer');
    t.as(A, 'create_document', [W, D2, null, 'agenda', cipher(W, D2)]);
    rejectsUnchanged(t, () => t.as(B, 'push_document', [W, D2, op(6), '1', cipher(W, D2, 1, 'z')]), 'forbidden');
    rejects(() => t.as(B, 'create_document', [W, uuid(22), null, 'note', cipher(W, uuid(22))]), 'forbidden');
  } finally { t.close(); }
});

test('ciphertext envelopes are checked exactly: algorithm, base64, sizes, key set and the bound aad', () => {
  const t = setup({ users: [1] });
  try {
    workspace(t);
    const good = cipher(W, D);
    const bad = [
      null, 'text', [], { ...good, algorithm: 'A128GCM' }, { ...good, nonce: 'short' }, { ...good, nonce: Buffer.alloc(12, 1).toString('base64').replace('A', '*') },
      { ...good, ciphertext: Buffer.alloc(8).toString('base64') }, { ...good, ciphertext: 'QUFB=' }, { ...good, extra: 1 },
      { ...good, aad: JSON.stringify(['local-first-v1', W, D2, 'content', 1]) }, { ...good, aad: JSON.stringify(['local-first-v1', W, D, 'content', 2]) },
      { algorithm: good.algorithm, nonce: good.nonce, ciphertext: good.ciphertext }, { ...good, ciphertext: 'A'.repeat(1048580) },
    ];
    for (const [i, value] of bad.entries()) rejectsUnchanged(t, () => t.as(A, 'push_document', [W, D, op(i), '1', value]), 'invalid_ciphertext');
    rejects(() => t.as(A, 'push_document', [W, D, op(30), '1', cipher(W, D, 2), false, 2]), 'invalid_key_epoch');
    rejects(() => t.as(A, 'push_document', [W, D, op(31), '1', good, false, null]), 'invalid_key_epoch');
    assert.equal(t.as(A, 'push_document', [W, D, op(32), '1', good]).status, 'applied');
  } finally { t.close(); }
});

test('reads: pull_changes windows and cursors, list_accessible_documents restarts, get_documents hides what the caller may not see', () => {
  const t = setup({ users: [1, 2] });
  try {
    workspace(t);
    join(t, A, W, B, 'editor');
    t.as(A, 'create_document', [W, D2, null, 'meeting', cipher(W, D2)]);
    for (let i = 0; i < 3; i++) t.as(A, 'push_document', [W, D, op(i), String(i + 1), cipher(W, D, 1, 'bcd'[i])]);
    // head 5: D at 1,3,4,5 and D2 at 2. epoch 2 after B joined.
    rejects(() => t.as(B, 'pull_changes', [W, '6', 100, '2']), 'cursor_ahead');
    for (const bad of [null, '-1', '01', 'x', '9223372036854775808']) rejects(() => t.as(B, 'pull_changes', [W, bad, 100, '2']), 'invalid_cursor');
    for (const limit of [0, 501, null]) rejects(() => t.as(B, 'pull_changes', [W, '0', limit, '2']), 'invalid_limit');
    assert.deepEqual(t.as(B, 'pull_changes', [W, '0', 100, '1']), { reset_required: true, changes: [], scanned_through: '0', head: '5', access_epoch: '2' });
    assert.equal(t.as(B, 'pull_changes', [W, '0', 100]).reset_required, true);
    // Each document once per window, at its greatest seq in the window, in that order.
    const all = t.as(B, 'pull_changes', [W, '0', 100, '2']);
    assert.deepEqual(all.changes.map(c => [c.id, c.seq, c.revision]), [[D2, '2', '1'], [D, '5', '4']]);
    assert.equal(all.scanned_through, '5');
    const page = t.as(B, 'pull_changes', [W, '0', 2, '2']);
    assert.deepEqual(page.changes.map(c => [c.id, c.seq]), [[D, '1'], [D2, '2']]);
    assert.equal(page.changes[0].revision, '4', 'current snapshot, not the journaled one');
    assert.equal(page.scanned_through, '2');
    // Hidden documents are skipped without a snapshot but still scanned.
    setAcl(t, A, 'document', W, D2, { [A]: 'editor' });
    const hidden = t.as(B, 'pull_changes', [W, '0', 100, '3']);
    assert.deepEqual(hidden.changes.map(c => c.id), [D]); assert.equal(hidden.scanned_through, '5');
    assert.deepEqual(t.as(B, 'list_accessible_documents', [W, null, 100, null]).documents, [{ id: D, revision: '4' }]);
    assert.deepEqual(t.as(A, 'list_accessible_documents', [W, null, 1, null]), { restart_required: false, documents: [{ id: D, revision: '4' }], next_id: D, head: '5', access_epoch: '3' });
    assert.equal(t.as(A, 'list_accessible_documents', [W, D, 1, null]).restart_required, true);
    assert.equal(t.as(A, 'list_accessible_documents', [W, D, 1, '2']).restart_required, true);
    assert.deepEqual(t.as(A, 'list_accessible_documents', [W, D, 1, '3']).documents, [{ id: D2, revision: '1' }]);
    // get_documents: hidden and missing ids count as processed and reveal nothing.
    const got = t.as(B, 'get_documents', [W, [D2, uuid(77), D], '3']);
    assert.deepEqual([got.processed, got.documents.map(d => d.id)], [3, [D]]);
    assert.deepEqual(got.documents[0].ciphertext, cipher(W, D, 1, 'd'));
    assert.equal(t.as(B, 'get_documents', [W, [D], '2']).restart_required, true);
    for (const ids of [[], [D, D], [D, null], [[D]], Array.from({ length: 501 }, (_, i) => uuid(1000 + i)), ['nope']]) {
      rejects(() => t.as(B, 'get_documents', [W, ids, '3']), 'invalid_request');
    }
    rejects(() => t.as(B, 'get_documents', [W, 'not-an-array', '3']), 'invalid_request');
    // An outsider learns nothing, existing workspace or not.
    rejects(() => t.as(C, 'get_documents', [W, [D], '3']), 'forbidden');
    rejects(() => t.as(C, 'pull_changes', [uuid(404), '0', 100, '1']), 'forbidden');
  } finally { t.close(); }
});

test('byte budget: a page holds what fits 4 MiB, always at least one element, and scanned_through stops below the cut', () => {
  const t = setup({ users: [1] });
  try {
    t.as(A, 'create_workspace', [W, 'Big']);
    // 1,040,000 base64 characters each (just under the 1 MiB field cap): four fit in 4 MiB, the fifth does not.
    const big = (d, fill) => ({ ...cipher(W, d), ciphertext: Buffer.alloc(780000, fill).toString('base64') });
    const ids = [uuid(201), uuid(202), uuid(203), uuid(204), uuid(205)];
    ids.forEach((d, i) => t.as(A, 'create_document', [W, d, null, 'note', big(d, i + 1)]));
    const pulled = t.as(A, 'pull_changes', [W, '0', 100, '1']);
    assert.deepEqual(pulled.changes.map(c => c.id), ids.slice(0, 4));
    assert.equal(pulled.scanned_through, '4');
    assert.deepEqual(t.as(A, 'pull_changes', [W, '4', 100, '1']).changes.map(c => c.id), [ids[4]]);
    const got = t.as(A, 'get_documents', [W, ids, '1']);
    assert.equal(got.processed, 4); assert.equal(got.documents.length, 4);
    assert.equal(t.as(A, 'get_documents', [W, ids.slice(4), '1']).documents.length, 1);
    // One element always fits, so every call makes progress.
    assert.equal(t.as(A, 'pull_changes', [W, '0', 1, '1']).changes.length, 1);
  } finally { t.close(); }
});

test('one RPC is one transaction: a failure after writes rolls back document, journal, audit, head, receipt and signals', () => {
  const t = setup({ users: [1] });
  try {
    workspace(t);
    // The receipt is the push's last write; failing it must undo everything the push wrote before it.
    const before = t.state();
    t.db.exec("create temp trigger fail_receipt before insert on receipts begin select raise(abort,'synthetic failure'); end");
    assert.throws(() => t.as(A, 'push_document', [W, D, op(1), '1', cipher(W, D, 1, 'q')]), /synthetic failure/);
    t.db.exec('drop trigger fail_receipt');
    assert.deepEqual(t.state(), before);
    assert.equal(t.db.isTransaction, false);
    assert.equal(t.as(A, 'push_document', [W, D, op(1), '1', cipher(W, D, 1, 'q')]).status, 'applied');
  } finally { t.close(); }
});

test('signals carry only user, workspace and generation; foreign keys stay enforced', () => {
  const t = setup({ users: [1, 2] });
  try {
    workspace(t);
    const columns = t.rows('pragma table_info(user_signals)').map(c => c.name);
    assert.deepEqual(columns, ['user_id', 'workspace_id', 'generation']);
    const g = () => t.row('select generation from user_signals where user_id=? and workspace_id=?', A, W).generation;
    const before = g();
    t.as(A, 'push_document', [W, D, op(1), '1', cipher(W, D, 1, 'r')]);
    assert.equal(g(), before + 1);
    assert.equal(t.row('pragma foreign_keys').foreign_keys, 1);
    assert.throws(() => t.db.prepare("insert into members values(?,?,'viewer')").run(W, uuid(55)), /FOREIGN KEY/);
    assert.deepEqual(t.rows('pragma foreign_key_check'), []);
  } finally { t.close(); }
});
