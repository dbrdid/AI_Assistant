import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

/*
 * Test-only Supabase fixtures. Nothing in this file is part of a migration.
 *
 * Options (defaults keep the original local behaviour):
 *   auth: 'legacy'   - auth.uid() reads only request.jwt.claim.sub, and asUser sets that GUC.
 *         'supabase' - the hosted auth.uid() definition (legacy GUC first, otherwise
 *                      request.jwt.claims->>'sub'); asUser sets only request.jwt.claims,
 *                      as PostgREST does.
 *   defaultPrivileges: 'none' | 'supabase' - 'supabase' creates service_role and applies the
 *         hosted-style ALTER DEFAULT PRIVILEGES on schema public before migrating.
 *   migrator: 'superuser' | 'restricted' - 'restricted' applies migrations as a non-superuser
 *         CREATEROLE role, the way a hosted deployment account does.
 *
 * Identity is always transaction-scoped: asUser, withIdentity and asExecutor run the callback
 * inside BEGIN ... COMMIT with SET LOCAL ROLE and set_config(..., true). No subject or role
 * survives into later statements, so code that silently depends on a leftover identity fails.
 */
const MIGRATIONS = { sync: '202611090001_sync.sql', ai: '202611090002_ai.sql' };
const AUTH_UID = {
  legacy: "select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid",
  supabase: "select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid",
};
const OPTIONS = { auth: ['legacy', 'supabase'], defaultPrivileges: ['none', 'supabase'], migrator: ['superuser', 'restricted'] };
const identityModes = new WeakMap();
const activeScopes = new WeakSet();

function checkOptions(options) {
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(OPTIONS, key) || !OPTIONS[key].includes(value)) throw new Error(`Unknown harness option ${key}=${value}`);
  }
}

/** Records how asUser transmits identity for a database opened without running setup. */
export function configureIdentity(db, { auth = 'legacy' } = {}) {
  checkOptions({ auth });
  identityModes.set(db, auth);
}

export async function setupDatabase(db, names, { auth = 'legacy', defaultPrivileges = 'none', migrator = 'superuser' } = {}) {
  checkOptions({ auth, defaultPrivileges, migrator });
  if (!Array.isArray(names) || names.some(name => !Object.hasOwn(MIGRATIONS, name))) throw new Error('Unknown migration');
  configureIdentity(db, { auth });
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ ${AUTH_UID[auth]} $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  const role = migrator === 'restricted' ? 'migrator' : null;
  if (role) {
    // Approximates a deployment account: not a superuser, but CREATEROLE, CREATE on the database and grantable
    // privileges on schema public and on the auth objects the migrations reference. Grantable public privileges
    // assume the account owns the database (PostgreSQL 15+ gives public to pg_database_owner); this is not a
    // verified copy of Supabase's role setup.
    await db.exec(`create role migrator nologin createrole;
      grant usage, create on schema public to migrator with grant option;
      do $$ begin execute format('grant create on database %I to migrator', current_database()); end $$;
      grant usage on schema auth to migrator with grant option;
      grant execute on function auth.uid() to migrator with grant option;
      grant references on auth.users to migrator;
      grant trigger on auth.users to migrator;`);
  }
  if (defaultPrivileges === 'supabase') {
    const forRole = role ? `for role ${role} ` : '';
    await db.exec(`create role service_role nologin noinherit bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges ${forRole}in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges ${forRole}in schema public grant all on functions to anon, authenticated, service_role;
      alter default privileges ${forRole}in schema public grant all on sequences to anon, authenticated, service_role;`);
  }
  if (role) await db.exec(`set role ${role}`);
  try {
    for (const name of names) await db.exec(await readFile(new URL(`../migrations/${MIGRATIONS[name]}`, import.meta.url), 'utf8'));
  } catch (error) {
    // Migrations open their own transaction; end it so the session stays usable.
    await db.exec('rollback').catch(() => {});
    throw error;
  } finally {
    if (role) await db.exec('reset role');
  }
}

export async function database(options = {}) {
  const db = new PGlite();
  try { await setupDatabase(db, ['sync'], options); return db; } catch (error) { await db.close(); throw error; }
}

export function uuid(n) { return `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`; }
export function cipher(w,d,epoch=1,value='a') { return {algorithm:'A256GCM',nonce:Buffer.alloc(12,1).toString('base64'),ciphertext:Buffer.alloc(20,value).toString('base64'),aad:JSON.stringify(['local-first-v1',w,d,'content',epoch])}; }

/** Runs fn in one transaction after the given setup statements; nesting is rejected. */
export async function inTransaction(db, setup, fn) {
  if (activeScopes.has(db)) throw new Error('Identity scopes cannot be nested');
  activeScopes.add(db);
  try {
    await db.exec('begin');
    try {
      for (const statement of setup) {
        if (typeof statement === 'string') await db.exec(statement); else await db.query(statement[0], statement[1]);
      }
      const result = await fn();
      await db.exec('commit');
      return result;
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
  } finally {
    activeScopes.delete(db);
  }
}

function subjectStatement(db, user) {
  if (typeof user !== 'string') throw new Error('User id string required');
  if ((identityModes.get(db) ?? 'legacy') === 'supabase') {
    return ["select set_config('request.jwt.claims',$1,true)", [JSON.stringify(user ? { sub: user, role: 'authenticated' } : { role: 'authenticated' })]];
  }
  return ["select set_config('request.jwt.claim.sub',$1,true)", [user]];
}

/** Runs fn as the authenticated role with a transaction-scoped JWT subject ('' means no subject). */
export function asUser(db, user, fn) {
  return inTransaction(db, ['set local role authenticated', subjectStatement(db, user)], fn);
}

/** Keeps the current (superuser) role but sets the subject, for inspecting private helpers. */
export function withIdentity(db, user, fn) {
  return inTransaction(db, [subjectStatement(db, user)], fn);
}

/**
 * Calls public.<name> with positional arguments. PGlite serializes each value by the declared parameter type:
 * objects and arrays become JSON for jsonb, arrays become array literals for uuid[], strings pass through.
 */
export async function rpc(db,name,args) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('invalid RPC name');
  const values=args;
  return (await db.query(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(',')}) as result`,values)).rows[0].result;
}

/**
 * Calls public.<name> in named notation built from the object's keys (`p_x => $1, ...`), the way PostgREST resolves
 * a call: a parameter name the function does not have fails with 42883 instead of being matched by position.
 */
export async function rpcNamed(db,name,args) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('invalid RPC name');
  const keys=Object.keys(args);
  if (keys.some(key=>!/^[a-z_]+$/.test(key))) throw new Error('invalid RPC argument name');
  return (await db.query(`select public.${name}(${keys.map((key,i)=>`${key} => $${i+1}`).join(',')}) as result`,keys.map(key=>args[key]))).rows[0].result;
}

/** Adds user to w the only way the RPCs allow: the owner invites, then the user accepts. Returns the accept result. */
export async function join(db,owner,w,user,role) {
  await asUser(db,owner,()=>rpc(db,'invite_member',[w,user,role]));
  return asUser(db,user,()=>rpc(db,'respond_invitation',[w,true]));
}

/** Sets a folder or document ACL as the owner with the stored version: get_acl, then set_<kind>_acl, in one transaction. */
export function setAcl(db,owner,kind,w,id,acl) {
  if (kind!=='folder' && kind!=='document') throw new Error('kind must be folder or document');
  return asUser(db,owner,async()=>{
    const {acl_version}=await rpc(db,'get_acl',[w,kind,id]);
    return rpc(db,`set_${kind}_acl`,[w,id,acl,acl_version]);
  });
}

/** Turns the workspace AI switch on as the owner (AI is off by default). */
export function enableAi(db,owner,w) {
  return asUser(db,owner,()=>rpc(db,'set_ai_enabled',[w,true]));
}

const AS_AUTH_ADMIN=['set local role auth_admin_test',"select set_config('request.jwt.claim.sub','',true)","select set_config('request.jwt.claims','',true)"];
async function authAdminRole(db) {
  await db.exec(`do $$ begin if not exists(select 1 from pg_roles where rolname='auth_admin_test') then
    create role auth_admin_test nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    grant usage on schema auth to auth_admin_test; grant delete, select(id) on auth.users to auth_admin_test; end if; end $$;`);
}

/**
 * Deletes an auth.users row the way the auth service does: as a non-superuser role with no rights on schema app or
 * private and no JWT subject, so account-deletion cleanup must run on the trigger's own definer rights. The role is
 * created once per database. PostgreSQL also requires SELECT on the column a DELETE's WHERE clause reads, so it holds
 * SELECT(id) besides DELETE. Returns the number of deleted rows.
 */
export async function deleteUserAsAuthAdmin(db,userId) {
  if (activeScopes.has(db)) throw new Error('Identity scopes cannot be nested');
  await authAdminRole(db);
  return inTransaction(db,AS_AUTH_ADMIN,async()=>(await db.query('delete from auth.users where id=$1',[userId])).affectedRows);
}

/**
 * The deletion of deleteUserAsAuthAdmin, rolled back. After the DELETE, inspect({top}) runs as the session (superuser)
 * role in the same transaction; top is txid_current() taken before the DELETE. A row the deletion locked has xmax >= top
 * (an exception block runs in a subtransaction with a larger id), so a single session sees which workspace rows a
 * deletion holds. Returns what inspect returns.
 */
export async function dryRunDeletion(db,userId,inspect) {
  if (activeScopes.has(db)) throw new Error('Identity scopes cannot be nested');
  await authAdminRole(db);
  const rollback=new Error('dry run rollback');let result;
  try {
    await inTransaction(db,AS_AUTH_ADMIN,async()=>{
      const top=(await db.query('select txid_current()::text t')).rows[0].t;
      if ((await db.query('delete from auth.users where id=$1',[userId])).affectedRows!==1) throw new Error('dry run deleted no account');
      await db.exec('reset role');
      result=await inspect({top});
      throw rollback;
    });
  } catch (error) { if (error!==rollback) throw error; }
  return result;
}

/**
 * Per app table: rows its scans returned (seq_tup_read + idx_tup_fetch) and index entries read (idx_tup_read), from the
 * cumulative statistics. The forced flush and the cleared snapshot make every earlier statement count; compare two calls.
 */
export async function tableReads(db,tables) {
  await db.query('select pg_stat_force_next_flush()');
  await db.query('select pg_stat_clear_snapshot()');
  const {rows}=await db.query(`select s.relname,(s.seq_tup_read+coalesce(s.idx_tup_fetch,0))::text heap,
      coalesce((select sum(i.idx_tup_read) from pg_stat_user_indexes i where i.relid=s.relid),0)::text entries
    from pg_stat_user_tables s where s.schemaname='app' and s.relname=any($1)`,[tables]);
  return Object.fromEntries(rows.map(r=>[r.relname,{heap:Number(r.heap),entries:Number(r.entries)}]));
}

/** Runs fn as sync_maintainer without a JWT subject, the way an ops job calls purge_expired_trash. */
export function asMaintainer(db,fn) {
  return inTransaction(db,['set local role sync_maintainer',"select set_config('request.jwt.claim.sub','',true)","select set_config('request.jwt.claims','',true)"],fn);
}

/**
 * Every row of every table in schema app, plus the auth.users ids, as one object keyed by table name; rows are in a fixed
 * order. Two equal snapshots mean nothing was written; the tables whose rows differ are exactly the tables a call changed.
 * Reads as the session (superuser) role, so call it outside identity scopes.
 */
export async function appState(db) {
  const {rows:[{parts}]}=await db.query(`select string_agg(format('%L,(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),''[]'') from app.%I x)',tablename,tablename),',' order by tablename) parts
    from pg_tables where schemaname='app'`);
  return (await db.query(`select jsonb_build_object(${parts},'auth.users',(select coalesce(jsonb_agg(id order by id),'[]') from auth.users)) state`)).rows[0].state;
}
