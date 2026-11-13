import { openDatabase, transaction } from '../db/database.js';
import { RpcFault, bindArguments, queries, uuidCast } from './core.js';
import { SYNC_RPCS, forgetUser } from './sync.js';
import { AI_RPCS, forgetUserAi } from './ai.js';

export { RpcError, RpcFault } from './core.js';

const RPCS = new Map([...SYNC_RPCS, ...AI_RPCS].map(spec => [spec.name, Object.freeze(spec)]));
/**
 * Who may call what, replacing the PostgreSQL GRANTs:
 *   authenticated    a verified user (uid); the 25 sync RPCs and 4 user AI RPCs
 *   ai_executor      the gateway/worker server path, no uid; the 9 executor AI RPCs
 *   sync_maintainer  an ops job, no uid; purge_expired_trash only
 */
export const ROLES = Object.freeze(['authenticated', 'ai_executor', 'sync_maintainer']);
export const RPC_NAMES = Object.freeze(Object.fromEntries(ROLES.map(role => [role, [...RPCS.values()].filter(s => s.roles.includes(role)).map(s => s.name)])));

/**
 * The backend over one SQLite database. Every call runs in its own write transaction and returns plain JSON values.
 * Business errors are RpcError (code PT<status>, message = contract reason); a call outside the caller's role or
 * with unknown argument names is an RpcFault (42501 / 42883), which callers must treat as a server fault.
 *
 * now() returns microseconds since the epoch; tests inject a clock.
 */
export function createBackend({ path = ':memory:', now = () => Date.now() * 1000, busyTimeoutMs } = {}) {
  if (typeof now !== 'function') throw new Error('Clock function required');
  const db = openDatabase(path, { busyTimeoutMs });
  const q = queries(db);
  const clock = () => {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) throw new Error('Clock must return integer microseconds');
    return t;
  };

  function call({ role, uid = null } = {}, name, args) {
    const spec = RPCS.get(name);
    if (!ROLES.includes(role) || !spec || !spec.roles.includes(role)) throw new RpcFault('42501', `permission denied for function ${name}`);
    // Only the authenticated role carries a subject; '' or null means none (the RPC answers unauthenticated).
    let subject = null;
    if (role === 'authenticated' && uid !== null && uid !== '') {
      subject = uuidCast(uid);
      if (!subject) throw new RpcFault('22P02', 'invalid subject');
    }
    const bound = bindArguments(spec, args);
    return transaction(db, () => spec.fn({ q, uid: subject, now: clock }, bound));
  }

  return Object.freeze({
    db,
    call,
    /** Registers an account id (the role Supabase auth.users played). Returns false when it already exists. */
    createUser(id) {
      const user = uuidCast(id);
      if (!user) throw new Error('User id must be a uuid');
      return transaction(db, () => q.run('insert or ignore into users(id) values(?)', user) === 1);
    },
    /**
     * Hard-deletes an account and cleans up after it in the same transaction (formerly the auth.users trigger, F24).
     * Throws owner_must_transfer while it owns a workspace with other members. Returns 1, or 0 for no such account.
     */
    deleteUser(id) {
      const user = uuidCast(id);
      if (!user) throw new Error('User id must be a uuid');
      return transaction(db, () => forgetUser({ q, uid: null, now: clock }, user, forgetUserAi));
    },
    close() { if (db.isOpen) db.close(); },
  });
}
