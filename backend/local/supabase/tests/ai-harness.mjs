import { PGlite } from '@electric-sql/pglite';
import { setupDatabase, configureIdentity, inTransaction } from './harness.mjs';
export { uuid, cipher, asUser, withIdentity, rpc, enableAi } from './harness.mjs';

/** Accepts the same options as database() in harness.mjs; initialize:false reopens dataDir. */
export async function aiDatabase({ dataDir, initialize = true, ...options } = {}) {
  const db = new PGlite(dataDir);
  try {
    if (initialize) await setupDatabase(db, ['sync', 'ai'], options);
    else configureIdentity(db, options);
    return db;
  } catch (error) { await db.close(); throw error; }
}

/** Mirrors the server bridge: SET LOCAL ROLE ai_executor with an empty legacy subject. */
export function asExecutor(db, fn) {
  return inTransaction(db, ['set local role ai_executor', "select set_config('request.jwt.claim.sub','',true)"], fn);
}
