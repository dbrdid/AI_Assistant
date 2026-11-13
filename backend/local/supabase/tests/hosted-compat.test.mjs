import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_ERRORS } from '../../contracts/errors.js';
import { database, enableAi } from './harness.mjs';
import { aiDatabase, asExecutor, asUser, rpc, uuid, cipher } from './ai-harness.mjs';

/*
 * Hosted (Supabase-style) behaviour simulated on PGlite: hosted default privileges, a
 * non-superuser migrator and PostgREST claims-only identity. Passing here is not a hosted run.
 */

// Allowlists copied from the grant blocks at the end of both migrations.
const SYNC_RPCS = [
  'create_workspace(uuid,text)', 'set_member(uuid,uuid,text)', 'invite_member(uuid,uuid,text)', 'respond_invitation(uuid,boolean)',
  'leave_workspace(uuid)', 'offer_ownership(uuid,uuid)', 'accept_ownership(uuid)', 'list_my_workspaces(uuid,integer)',
  'list_members(uuid,uuid,integer)', 'list_invitations(uuid,uuid,integer)', 'list_my_invitations(uuid,integer)',
  'create_folder(uuid,uuid,uuid,jsonb)', 'list_folders(uuid,uuid,integer)', 'set_folder_acl(uuid,uuid,jsonb,text)',
  'get_acl(uuid,text,uuid)', 'list_acls(uuid,text,uuid,integer)', 'create_document(uuid,uuid,uuid,text,jsonb,integer,uuid)',
  'set_document_acl(uuid,uuid,jsonb,text)', 'push_document(uuid,uuid,uuid,text,jsonb,boolean,integer)',
  'restore_document(uuid,uuid,uuid,text)', 'list_trash(uuid,uuid,integer)', 'set_ai_enabled(uuid,boolean)',
  'pull_changes(uuid,text,integer,text)', 'list_accessible_documents(uuid,uuid,integer,text)',
  'get_documents(uuid,uuid[],text)',
];
// Ops only: run without a JWT subject by the sync_maintainer role.
const MAINTAINER_RPCS = ['purge_expired_trash(integer)'];
const AI_USER_RPCS = ['ai_grant_consent(jsonb)', 'ai_revoke_consent(uuid)', 'ai_cancel_job(uuid)', 'ai_job_status(uuid)'];
const AI_EXECUTOR_RPCS = [
  'ai_set_route(jsonb)', 'ai_set_budget(uuid,uuid,text,bigint)', 'ai_admit_job(uuid,jsonb)', 'ai_claim_job(integer)',
  'ai_begin_dispatch(uuid,bigint)', 'ai_fail_before_dispatch(uuid,bigint)', 'ai_mark_unknown(uuid,bigint)',
  'ai_settle_job(uuid,bigint,text,bigint,text,text)', 'ai_reap_jobs()',
];
const inPublic = names => names.map(name => `public.${name}`).sort();
const USER_RPCS = inPublic([...SYNC_RPCS, ...AI_USER_RPCS]);
const EXECUTOR_RPCS = inPublic(AI_EXECUTOR_RPCS);
const MAINTAINER_ONLY_RPCS = inPublic(MAINTAINER_RPCS);
const ALL_RPCS = [...USER_RPCS, ...EXECUTOR_RPCS, ...MAINTAINER_ONLY_RPCS].sort();
const SYNC_TABLES = ['workspaces', 'members', 'folders', 'documents', 'journal', 'audit', 'receipts', 'key_envelopes', 'attachments', 'user_signals',
  'invitations', 'storage_deletions'];
// The account-deletion trigger function and the hook the AI migration replaces.
const DELETION_FUNCTIONS = ['private.forget_user()', 'private.forget_user_hook(uuid)'].sort();
const AI_TABLES = ['ai_routes', 'ai_consents', 'ai_budgets', 'ai_jobs', 'ai_attempts', 'ai_usage_ledger'];
// The only client-reachable relation privilege: users read their own change signals (RLS policy own_signal).
const CLIENT_RELATION_PRIVILEGES = [{ relation: 'app.user_signals', role: 'authenticated', privileges: ['SELECT'] }];
// No schema a caller can write to may appear in a function search_path. P0-4 may append pg_temp (F14).
const SAFE_SEARCH_PATH = '^search_path=(pg_catalog(, pg_temp)?|"")$';
const APP_SCHEMAS = "n.nspname not in ('pg_catalog', 'information_schema', 'auth') and n.nspname !~ '^pg_'";
const RELATION_KINDS = "c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')";

/** Every function outside the system schemas and the auth stub, with which of `roles` may EXECUTE it. */
async function functionPrivileges(db, roles) {
  const { rows } = await db.query(`
    select format('%s.%s(%s)', n.nspname, p.proname, replace(oidvectortypes(p.proargtypes), ', ', ',')) as signature,
      n.nspname as schema, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
      exists(select 1 from unnest(p.proconfig) as cfg(entry) where entry ~ $2) as search_path_safe,
      exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
      array(select role_name from unnest($1::text[]) as candidate(role_name)
        where has_function_privilege(role_name::name, p.oid, 'EXECUTE')) as roles
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ${APP_SCHEMAS}
    order by 1`, [roles, SAFE_SEARCH_PATH]);
  return rows;
}
const executableBy = (rows, role) => rows.filter(row => row.roles.includes(role)).map(row => row.signature).sort();

/** Non-empty privileges that `roles` and PUBLIC hold on tables, views and sequences outside the system schemas. */
async function relationPrivileges(db, roles) {
  const { rows } = await db.query(`
    select format('%s.%s', n.nspname, c.relname) as relation, grantee.role_name as role,
      case when c.relkind = 'S'
        then array(select p from unnest(array['USAGE', 'SELECT', 'UPDATE']) as p where has_sequence_privilege(grantee.role_name, c.oid, p))
        else array(select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
          where has_table_privilege(grantee.role_name, c.oid, p)) end as privileges
    from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join unnest($1::text[]) as grantee(role_name)
    where ${RELATION_KINDS} and ${APP_SCHEMAS}
    union all
    select format('%s.%s', n.nspname, c.relname), 'PUBLIC', array_agg(acl.privilege_type::text order by acl.privilege_type::text)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) as acl
    where ${RELATION_KINDS} and ${APP_SCHEMAS} and acl.grantee = 0
    group by 1, 2
    order by 1, 2`, [roles]);
  return rows.filter(row => row.privileges.length);
}

async function appTableOwners(db) {
  const { rows } = await db.query(`select c.relname, pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r'`);
  return Object.fromEntries(rows.map(row => [row.relname, row.owner]));
}
const ownedBySyncBackend = tables => Object.fromEntries(tables.map(table => [table, 'sync_backend']));

/** Roles a new public function is explicitly granted EXECUTE by default privileges for the current role (probe rolled back). */
async function defaultFunctionGrantees(db) {
  await db.exec('begin');
  try {
    await db.exec("create function public.default_privilege_probe() returns integer language sql as 'select 1'");
    const { rows: [probe] } = await db.query(`
      select coalesce(array_agg(distinct r.rolname::text order by r.rolname::text), '{}') as grantees
      from pg_proc p cross join aclexplode(p.proacl) as acl join pg_roles r on r.oid = acl.grantee
      where p.oid = 'public.default_privilege_probe()'::regprocedure and acl.privilege_type = 'EXECUTE' and r.rolname <> current_user`);
    return probe.grantees;
  } finally {
    await db.exec('rollback');
  }
}

/** extraRoles: roles that exist only in some harness modes (service_role), checked only for the deletion functions. */
async function assertPrivilegeMatrix(db, extraRoles = []) {
  const rows = await functionPrivileges(db, ['anon', 'authenticated', 'ai_executor', 'sync_maintainer', ...extraRoles]);
  // Guards against a vacuous pass; P0-4 may rename the private schema (F50).
  assert.ok(rows.some(row => row.schema === 'private'), 'private helpers must be enumerated');
  // PUBLIC first, so a PUBLIC grant is reported as such rather than as a role-list difference.
  assert.deepEqual(rows.filter(row => row.public_execute).map(row => row.signature), []);
  // Exact lists: no other public function and no private helper is executable by these roles.
  assert.deepEqual(executableBy(rows, 'authenticated'), USER_RPCS);
  assert.deepEqual(executableBy(rows, 'ai_executor'), EXECUTOR_RPCS);
  assert.deepEqual(executableBy(rows, 'sync_maintainer'), MAINTAINER_ONLY_RPCS);
  assert.deepEqual(executableBy(rows, 'anon'), []);
  // Account deletion runs only through the auth.users trigger: the trigger function uses its own definer rights, and
  // it and the hook are owned by sync_backend and executable by no role checked here (service_role included).
  const deletion = rows.filter(row => DELETION_FUNCTIONS.includes(row.signature)).sort((a, b) => (a.signature < b.signature ? -1 : 1));
  assert.deepEqual(deletion.map(({ signature, owner, public_execute, roles }) => ({ signature, owner, public_execute, roles })),
    DELETION_FUNCTIONS.map(signature => ({ signature, owner: 'sync_backend', public_execute: false, roles: [] })));
  assert.equal(deletion.find(row => row.signature === 'private.forget_user()').definer, true);
  const { rows: triggers } = await db.query(`select tgname, tgfoid::regprocedure::text as function, tgenabled::text as enabled,
      (tgtype & 1) <> 0 as for_each_row, (tgtype & 2) <> 0 as before, (tgtype & 8) <> 0 as on_delete
    from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal`);
  assert.deepEqual(triggers, [{ tgname: 'forget_user', function: 'private.forget_user()', enabled: 'O', for_each_row: true, before: true, on_delete: true }]);
  // Every function, helpers included, pins a search_path without caller-writable schemas.
  assert.deepEqual(rows.filter(row => !row.search_path_safe).map(row => row.signature), []);
  // Owner may change for AI RPCs (C109, P0-4).
  const rpcs = rows.filter(row => row.schema === 'public').map(({ signature, definer, owner }) => ({ signature, definer, owner }));
  assert.deepEqual(rpcs, ALL_RPCS.map(signature => ({ signature, definer: true, owner: 'sync_backend' })));
  // Tables and sequences: nothing in schema public, and no client privilege beyond the own-signal SELECT.
  const { rows: [publicRelations] } = await db.query(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and ${RELATION_KINDS}`);
  assert.equal(publicRelations.n, 0, 'no relation may be created in schema public');
  assert.deepEqual(await relationPrivileges(db, ['anon', 'authenticated', 'ai_executor', 'sync_maintainer']), CLIENT_RELATION_PRIVILEGES);
}

test('default harness: EXECUTE and relation privilege matrix matches the migration allowlists', async t => {
  const db = await aiDatabase(); t.after(() => db.close());
  // Precondition: without hosted defaults a new public function gets no explicit grants.
  assert.deepEqual(await defaultFunctionGrantees(db), []);
  await assertPrivilegeMatrix(db);
  // Positive control for the restricted-migrator TODO. May change for AI tables (C109, P0-4).
  assert.deepEqual(await appTableOwners(db), ownedBySyncBackend([...SYNC_TABLES, ...AI_TABLES]));
});

test('R1 with the AI migration: every RPC taking a workspace locks its row as the first statement, except the two that cannot', async t => {
  const db = await aiDatabase(); t.after(() => db.close());
  const { rows } = await db.query(`select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and pg_get_function_arguments(p.oid) like 'p_workspace_id uuid%' order by 1`);
  // The declare part may not contain begin, so a lock inside a nested block after another statement does not pass. Its
  // initializers run before the first statement, so none may read data either: no select, and no call into app or
  // private but the constant private.page_budget(). Comments are stripped first, so their words count for nothing.
  const lockFirst = /^\s*(?:declare\b(?:(?!\bbegin\b|(?:=|\bdefault\b)[^;]*?(?:\bselect\b|\bapp\.|\bprivate\.(?!page_budget\(\))))[\s\S])*)?\bbegin\s+(?:\w+\s*:=\s*|perform\s+)private\.lock_workspace\(p_workspace_id\);/i;
  const code = source => source.replace(/--[^\n]*/g, '');
  const lock = 'begin\n  w:=private.lock_workspace(p_workspace_id);';
  assert.deepEqual(['b integer:=private.page_budget();', 'r integer:=private.document_rank(p_workspace_id,p_document_id);',
    'r integer default private.document_rank(p_workspace_id,p_document_id);', 'h bigint=(select head from app.workspaces where id=p_workspace_id);']
    .map(declaration => lockFirst.test(`declare\n  ${declaration}\n${lock}`)), [true, false, false, false]);
  assert.equal(rows.length, 24, 'the 23 sync RPCs and ai_set_budget');
  // create_workspace has no row to lock yet (the primary key decides between concurrent creators). ai_set_budget is an
  // executor call without a JWT subject, which lock_workspace refuses (R2): it validates its input, then locks the row.
  assert.deepEqual(rows.filter(row => !lockFirst.test(code(row.prosrc))).map(row => row.proname), ['ai_set_budget', 'create_workspace']);
  assert.match(rows.find(row => row.proname === 'ai_set_budget').prosrc, /\bperform 1 from app\.workspaces where id=p_workspace_id for update;/);
});

test('hosted default privileges: explicit revokes keep the matrix for anon, authenticated, ai_executor and PUBLIC', async t => {
  const db = await aiDatabase({ defaultPrivileges: 'supabase' }); t.after(() => db.close());
  // Precondition: the hosted-style defaults apply to functions created by the role that ran the migrations.
  assert.deepEqual(await defaultFunctionGrantees(db), ['anon', 'authenticated', 'service_role']);
  await assertPrivilegeMatrix(db, ['service_role']);
});

test('hosted default privileges: service_role executes no public or private function',
  { todo: 'F46: hosted default privileges leave service_role EXECUTE on all 39 public RPCs; fix planned in P0-4' }, async t => {
    const db = await aiDatabase({ defaultPrivileges: 'supabase' }); t.after(() => db.close());
    // Same precondition as above, so this cannot pass vacuously once the todo flag is removed.
    assert.deepEqual(await defaultFunctionGrantees(db), ['anon', 'authenticated', 'service_role']);
    const rows = await functionPrivileges(db, ['service_role']);
    assert.deepEqual(executableBy(rows, 'service_role'), [], 'service_role must not EXECUTE any app function (F46)');
  });

test('PostgREST claims-only identity: sync and AI RPCs act as the JWT subject', async t => {
  const db = await aiDatabase({ auth: 'supabase' }); t.after(() => db.close());
  const owner = uuid(1), editor = uuid(2), outsider = uuid(3), w = uuid(10), second = uuid(11), d = uuid(20), folder = uuid(21), op = uuid(30);
  await db.query('insert into auth.users values ($1), ($2), ($3)', [owner, editor, outsider]);
  const call = (user, name, args) => asUser(db, user, () => rpc(db, name, args));
  const exec = (name, args) => asExecutor(db, () => rpc(db, name, args));
  // Contract errors (shared/contracts/errors.js): SQLSTATE PT<status> with the bare reason as message.
  const rejected = reason => ({ code: SERVER_ERRORS[reason].sqlstate, message: reason });
  const forbidden = rejected('forbidden');
  const identity = async () => (await db.query(`select current_setting('request.jwt.claim.sub', true) as legacy,
    auth.uid()::text as uid, current_user::text as role`)).rows[0];
  const assertClaimsOnly = (seen, user) => {
    assert.ok(seen.legacy === null || seen.legacy === '', `legacy request.jwt.claim.sub must be unset, saw ${seen.legacy}`);
    assert.deepEqual({ uid: seen.uid, role: seen.role }, { uid: user, role: 'authenticated' });
  };

  await t.test('asUser sends the subject only in request.jwt.claims', async () => {
    for (const user of [owner, editor, outsider]) assertClaimsOnly(await asUser(db, user, identity), user);
  });

  await t.test('sync flow as owner and editor is attributed to each subject', async () => {
    assert.deepEqual(await call(owner, 'create_workspace', [w, 'Hosted']), { workspace_id: w, head: '0', access_epoch: '1' });
    // Members join by invitation: the owner invites and the editor accepts, each as its claims subject.
    assert.deepEqual(await call(owner, 'invite_member', [w, editor, 'editor']), { changed: true });
    assert.deepEqual(await call(editor, 'respond_invitation', [w, true]), { changed: true, role: 'editor', access_epoch: '2' });
    assert.deepEqual(await call(editor, 'create_document', [w, d, null, 'note', cipher(w, d)]),
      { op_id: d, document_id: d, status: 'applied', revision: '1', head: '1' });
    // The document inherits the workspace roles (F01), so the owner reads it below without an ACL call (epoch stays 2).
    const content = cipher(w, d, 1, 'b');
    const pushed = await call(editor, 'push_document', [w, d, op, '1', content]);
    assert.deepEqual({ status: pushed.status, revision: pushed.revision }, { status: 'applied', revision: '2' });
    const manifest = await call(owner, 'list_accessible_documents', [w]);
    assert.deepEqual(
      { restart: manifest.restart_required, epoch: manifest.access_epoch, documents: manifest.documents.map(doc => [doc.id, doc.revision]) },
      { restart: false, epoch: '2', documents: [[d, '2']] });
    const pull = await call(owner, 'pull_changes', [w, '0', 100, manifest.access_epoch]);
    assert.deepEqual({ reset: pull.reset_required, through: pull.scanned_through }, { reset: false, through: '2' });
    const latest = pull.changes.at(-1);
    assert.deepEqual({ id: latest.id, seq: latest.seq, revision: latest.revision, ciphertext: latest.ciphertext }, { id: d, seq: '2', revision: '2', ciphertext: content });
    const fetched = await call(owner, 'get_documents', [w, [d], manifest.access_epoch]);
    assert.deepEqual(
      { restart: fetched.restart_required, processed: fetched.processed, documents: fetched.documents.map(doc => [doc.id, doc.revision, doc.ciphertext]) },
      { restart: false, processed: 1, documents: [[d, '2', content]] });
    // auth.uid() resolved to each caller's claims subject.
    const members = await db.query('select user_id, role from app.members where workspace_id = $1 order by role', [w]);
    assert.deepEqual(members.rows, [{ user_id: editor, role: 'editor' }, { user_id: owner, role: 'owner' }]);
    const receipts = await db.query('select actor_id, op_id from app.receipts where workspace_id = $1 order by op_id', [w]);
    assert.deepEqual(receipts.rows, [{ actor_id: editor, op_id: d }, { actor_id: editor, op_id: op }]);
    // create_folder runs as the owner subject (its audit row names it; the new folder inherits, so its ACL no longer
    // carries the subject); set_folder_acl accepts only the owner subject.
    assert.deepEqual(await call(owner, 'create_folder', [w, folder, null]), { id: folder, acl_version: '1' });
    const audited = await db.query("select actor_id from app.audit where workspace_id = $1 and action = 'create_folder' and target_id = $2", [w, folder]);
    assert.deepEqual(audited.rows, [{ actor_id: owner }]);
    const folderAcl = async () => (await db.query('select acl from app.folders where workspace_id = $1 and id = $2', [w, folder])).rows[0].acl;
    assert.equal(await folderAcl(), null);
    await assert.rejects(call(editor, 'set_folder_acl', [w, folder, { [editor]: 'editor' }, '1']), forbidden);
    assert.deepEqual(await call(owner, 'set_folder_acl', [w, folder, { [editor]: 'editor' }, '1']), { access_epoch: '3', changed: true, acl_version: '2' });
    assert.deepEqual(await folderAcl(), { [editor]: 'editor' });
  });

  await t.test('missing subject and outsider are denied', async () => {
    await assert.rejects(call('', 'create_workspace', [second, 'Second']), rejected('unauthenticated'));
    assert.equal((await db.query('select count(*)::int as n from app.workspaces where id = $1', [second])).rows[0].n, 0);
    assert.deepEqual(await call(owner, 'create_workspace', [second, 'Second']), { workspace_id: second, head: '0', access_epoch: '1' });
    const epoch = (await call(owner, 'list_accessible_documents', [w])).access_epoch;
    const pullArgs = [w, '0', 100, epoch];
    await assert.rejects(call(outsider, 'pull_changes', pullArgs), forbidden);
    assert.equal((await call(owner, 'pull_changes', pullArgs)).reset_required, false);
  });

  await t.test('AI consent, admission, status, cancel and revoke use the claims subject and release budgets', async () => {
    const route = { route_id: 'synthetic-v1', provider_id: 'synthetic', model_id: 'test', retention_version: 'none-v1', max_cost_microusd: '100', max_output_tokens: 100 };
    // AI is off by default (F29 minimum); only the owner turns it on.
    assert.deepEqual(await enableAi(db, owner, w), { ai_enabled: true, changed: true });
    await exec('ai_set_route', [route]);
    // Budgets for this and the next UTC month, so admission across a month boundary still finds one.
    const { rows: [clock] } = await db.query(`with t as (select clock_timestamp() at time zone 'UTC' as ts)
      select to_char(ts, 'YYYY-MM') as this_month, to_char(ts + interval '1 month', 'YYYY-MM') as next_month from t`);
    const periods = [clock.this_month, clock.next_month];
    for (const period of periods) for (const actor of [null, editor]) await exec('ai_set_budget', [w, actor, period, '300']);
    const hash = 'a'.repeat(64), consentId = uuid(40), jobId = uuid(41);
    const consent = {
      approved: true, consent_id: consentId, workspace_id: w, document_id: d, source_revision: '2', payload_sha256: hash,
      route_id: route.route_id, provider_id: route.provider_id, model_id: route.model_id, purpose: 'summary',
      retention_version: route.retention_version, max_cost_microusd: '100', max_output_tokens: 100,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
    const granted = await asUser(db, editor, async () => {
      const result = await rpc(db, 'ai_grant_consent', [consent]);
      // private.ai_allowed swaps the legacy GUC internally; the claims subject must still apply.
      assertClaimsOnly(await identity(), editor);
      return result;
    });
    assert.equal(granted.actor_id, editor);
    const job = await exec('ai_admit_job', [editor, { job_id: jobId, consent_id: consentId, input_ref: 'opaque_input', payload_sha256: hash, route_id: route.route_id }]);
    assert.deepEqual({ id: job.id, actor_id: job.actor_id, state: job.state, reserved: job.reserved_microusd }, { id: jobId, actor_id: editor, state: 'queued', reserved: '100' });
    assert.ok(periods.includes(job.period), `unexpected job period ${job.period}`);
    const budgets = async () => (await db.query(`select period, scope, held_microusd::text as held, spent_microusd::text as spent
      from app.ai_budgets where workspace_id = $1 order by period, scope`, [w])).rows;
    const held = amount => periods.flatMap(period => ['', editor].map(scope => ({ period, scope, held: period === job.period ? amount : '0', spent: '0' })));
    assert.deepEqual(await budgets(), held('100'));
    assert.equal((await call(editor, 'ai_job_status', [jobId])).state, 'queued');
    // Same job, other subject.
    await assert.rejects(call(outsider, 'ai_job_status', [jobId]), forbidden);
    const cancelled = await call(editor, 'ai_cancel_job', [jobId]);
    assert.deepEqual({ state: cancelled.state, hold_released: cancelled.hold_released }, { state: 'cancelled', hold_released: true });
    assert.deepEqual(await budgets(), held('0'));
    // ai_revoke_consent also finds the consent through the claims subject.
    const secondConsent = { ...consent, consent_id: uuid(42) };
    assert.equal((await call(editor, 'ai_grant_consent', [secondConsent])).actor_id, editor);
    await assert.rejects(call(outsider, 'ai_revoke_consent', [secondConsent.consent_id]), forbidden);
    const revoked = await call(editor, 'ai_revoke_consent', [secondConsent.consent_id]);
    assert.equal(revoked.consent_id, secondConsent.consent_id);
    assert.ok(revoked.revoked_at, 'revocation time must be set');
  });
});

test('restricted migrator reproduces the superuser-migrated catalog',
  { todo: 'F47: a non-superuser migrator cannot ALTER ... OWNER TO sync_backend (42501), so the migration rolls back; fix planned in P0-4' }, async () => {
    const snapshot = async (open, roles) => {
      let db;
      try { db = await open(); } catch (error) {
        return `migration failed: ${error.code} ${error.message} at ${String(error.where ?? '').split('\n')[0]}`;
      }
      try {
        return { functions: await functionPrivileges(db, roles), relations: await relationPrivileges(db, roles), tables: await appTableOwners(db) };
      } finally { await db.close(); }
    };
    // Compared with the superuser result instead of hard-coded owners, so the expectation stays right
    // when P0-4 also moves AI objects to their own owner (C109). Restricted and hosted defaults is the realistic pairing.
    // P0-4 should also decide whether the migrator may keep its membership in sync_backend afterwards. A SET-only
    // membership does not get through the sync migration: once schema app belongs to sync_backend, 'alter table
    // app.workspaces owner to sync_backend' fails with 'permission denied for schema app' (the migrator no longer has
    // USAGE there), or earlier, at the first 'alter function public... owner to sync_backend', where sync_backend may
    // not create in schema public. INHERIT membership is needed, also because the AI migration replaces the
    // sync_backend-owned forget_user hook (CREATE OR REPLACE). Checked in PGlite only.
    const cases = [
      ['sync', options => database(options), ['anon', 'authenticated', 'sync_maintainer']],
      ['sync+ai', options => aiDatabase(options), ['anon', 'authenticated', 'ai_executor', 'sync_maintainer']],
      ['sync+ai, hosted defaults', options => aiDatabase({ ...options, defaultPrivileges: 'supabase' }), ['anon', 'authenticated', 'ai_executor', 'sync_maintainer', 'service_role']],
    ];
    const actual = {}, expected = {};
    for (const [label, open, roles] of cases) {
      expected[label] = await snapshot(() => open({}), roles);
      actual[label] = await snapshot(() => open({ migrator: 'restricted' }), roles);
    }
    assert.deepEqual(actual, expected);
  });
