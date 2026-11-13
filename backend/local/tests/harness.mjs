import assert from 'node:assert/strict';
import { createBackend } from '../rpc/index.js';
import { SERVER_ERRORS } from '../contracts/errors.js';

/* Test-only fixtures for the SQLite backend. Nothing here is used by production code. */

export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const cipher = (w, d, epoch = 1, value = 'a') => ({ algorithm: 'A256GCM', nonce: Buffer.alloc(12, 1).toString('base64'),
  ciphertext: Buffer.alloc(20, value).toString('base64'), aad: JSON.stringify(['local-first-v1', w, d, 'content', epoch]) });
export const HOUR_US = 3600 * 1_000_000;

/**
 * A backend over a fresh database with a controllable clock (microseconds). users: account numbers to create.
 * as(user, name, args) calls as that user ('' = no subject); exec(...) as ai_executor; maint(...) as sync_maintainer.
 */
export function setup({ users = [], path = ':memory:', start = Date.now() * 1000 } = {}) {
  const clock = { t: start };
  const b = createBackend({ path, now: () => clock.t });
  for (const n of users) b.createUser(uuid(n));
  return {
    b, db: b.db, clock,
    advance(hours) { clock.t += Math.round(hours * HOUR_US); },
    as: (user, name, args) => b.call({ role: 'authenticated', uid: user }, name, args),
    exec: (name, args) => b.call({ role: 'ai_executor' }, name, args),
    maint: (name, args) => b.call({ role: 'sync_maintainer' }, name, args),
    row: (sql, ...params) => { const r = b.db.prepare(sql).get(...params); return r ? { ...r } : undefined; },
    rows: (sql, ...params) => b.db.prepare(sql).all(...params).map(r => ({ ...r })),
    state: () => appState(b.db),
    close: () => b.close(),
  };
}

/** Every row of every table, in a fixed order. Two equal snapshots mean nothing was written. */
export function appState(db) {
  const out = {};
  for (const { name } of db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all()) {
    out[name] = db.prepare(`select * from "${name}"`).all().map(r => JSON.stringify(r, (_, v) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)).sort();
  }
  return out;
}

/** Asserts fn throws the contract error reason (code PT<status>, message reason). */
export function rejects(fn, reason) {
  assert.ok(Object.hasOwn(SERVER_ERRORS, reason), `not a contract reason: ${reason}`);
  assert.throws(fn, error => error.code === SERVER_ERRORS[reason].sqlstate && error.message === reason, `expected ${reason}`);
}
/** Asserts fn throws reason and leaves every table unchanged. */
export function rejectsUnchanged(t, fn, reason) {
  const before = t.state();
  rejects(fn, reason);
  assert.deepEqual(t.state(), before, `${reason} wrote something`);
}

/** Adds user to w the only way the RPCs allow: the owner invites, then the user accepts. */
export function join(t, owner, w, user, role) {
  t.as(owner, 'invite_member', [w, user, role]);
  return t.as(user, 'respond_invitation', [w, true]);
}
/** Sets a folder or document ACL as the owner with the stored version. */
export function setAcl(t, owner, kind, w, id, acl) {
  const { acl_version } = t.as(owner, 'get_acl', [w, kind, id]);
  return t.as(owner, `set_${kind}_acl`, [w, id, acl, acl_version]);
}
export const enableAi = (t, owner, w) => t.as(owner, 'set_ai_enabled', [w, true]);
