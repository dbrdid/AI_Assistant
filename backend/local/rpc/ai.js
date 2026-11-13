// AI RPCs, ported from supabase/migrations/202611090002_ai.sql. Budget reservation and queue insertion happen in the
// same transaction (rpc/index.js), so a job never exists without its hold, nor a hold without its job.
import { fail, isPlainObject, canonicalJson, sha256, utcText, uuidCast, roleRank, documentRank, MAX_BIGINT } from './core.js';

const USER = ['authenticated'];
const EXECUTOR = ['ai_executor'];
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,200}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const PERIOD_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const ACTIVE = ['queued', 'claimed', 'dispatched', 'outcome_unknown'];
const MINUTE_US = 60_000_000;
const DAY_US = 24 * 3600 * 1_000_000;

const onlyKeys = (value, keys) => Object.keys(value).every(k => keys.includes(k));
const getConsent = (ctx, id) => ctx.q.get('select * from ai_consents where id=?', id);
const getJob = (ctx, id) => ctx.q.get('select * from ai_jobs where id=?', id);

// F29 minimum: the actor needs edit access to the document now, the workspace's AI switch must be on, and the
// consent must still match the document's revision, be unrevoked and unexpired.
function aiAllowed(ctx, c) {
  // Anonymised (account deleted): nobody to check.
  if (c.actor_id === null) return false;
  const d = ctx.q.get(`select d.deleted,d.revision,x.ai_enabled from documents d join workspaces x on x.id=d.workspace_id
    where d.workspace_id=? and d.id=?`, c.workspace_id, c.document_id);
  const ok = !!d && documentRank(ctx, c.workspace_id, c.document_id, c.actor_id) >= 2 && !!d.ai_enabled && !d.deleted && d.revision === c.source_revision;
  return ok && c.revoked_at === null && c.expires_at > ctx.now();
}

function consentJson(c) {
  return { id: c.id, workspace_id: c.workspace_id, actor_id: c.actor_id, document_id: c.document_id, source_revision: String(c.source_revision),
    payload_sha256: c.payload_sha256, route_id: c.route_id, purpose: c.purpose, retention_version: c.retention_version,
    max_cost_microusd: String(c.max_cost_microusd), max_output_tokens: c.max_output_tokens, expires_at: utcText(c.expires_at), revoked_at: utcText(c.revoked_at) };
}

function jobJson(ctx, j) {
  const c = ctx.q.get(`select c.*,r.provider_id,r.model_id from ai_consents c join ai_routes r on r.route_id=c.route_id
    where c.id=? and c.workspace_id=?`, j.consent_id, j.workspace_id);
  const live = ctx.q.get('select 1 from documents where workspace_id=? and id=? and revision=? and deleted=0', j.workspace_id, c.document_id, c.source_revision);
  return {
    id: j.id, workspace_id: j.workspace_id, actor_id: j.actor_id, consent_id: j.consent_id, input_ref: j.input_ref, period: j.period,
    reserved_microusd: String(j.reserved_microusd), state: j.state, fencing_token: String(j.fencing_token), lease_until: utcText(j.lease_until),
    cancel_requested: !!j.cancel_requested, hold_released: !!j.hold_released, created_at: utcText(j.created_at), result_ref: j.result_ref,
    source_stale: !live, document_id: c.document_id, source_revision: String(c.source_revision), payload_sha256: c.payload_sha256,
    provider_id: c.provider_id, model_id: c.model_id, route_id: c.route_id, purpose: c.purpose, retention_version: c.retention_version,
    max_cost_microusd: String(c.max_cost_microusd), max_output_tokens: c.max_output_tokens, expires_at: utcText(c.expires_at),
  };
}

// Releases the job's hold on the workspace budget and (while it has one) the actor's budget, once.
function release(ctx, j) {
  if (j.hold_released) return;
  ctx.q.run("update ai_budgets set held_microusd=held_microusd-? where workspace_id=? and period=? and scope in ('',?)", j.reserved_microusd, j.workspace_id, j.period, j.actor_id ?? '');
  ctx.q.run('update ai_jobs set hold_released=1 where id=?', j.id);
}
function cancelQueued(ctx, j) {
  release(ctx, j);
  ctx.q.run("update ai_jobs set state='cancelled',cancel_requested=1,lease_until=null where id=?", j.id);
}

/* ---------- user RPCs ---------- */

function grantConsent(ctx, { p_request: r }) {
  if (!ctx.uid) fail('unauthenticated');
  if (!isPlainObject(r)) fail('invalid_request');
  // Every field is checked before it is stored. The revision is a decimal string of at most 19 digits within bigint
  // (as the gateway accepts); the cost is a 1-18 digit decimal string.
  if (r.approved !== true
    || !onlyKeys(r, ['approved', 'provider_id', 'model_id', 'consent_id', 'workspace_id', 'document_id', 'source_revision', 'payload_sha256', 'route_id', 'purpose', 'retention_version', 'max_cost_microusd', 'max_output_tokens', 'expires_at'])
    || ![r.consent_id, r.workspace_id, r.document_id].every(v => typeof v === 'string' && UUID_RE.test(v))
    || typeof r.source_revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(r.source_revision) || BigInt(r.source_revision) > MAX_BIGINT
    || typeof r.max_cost_microusd !== 'string' || !/^[1-9][0-9]{0,17}$/.test(r.max_cost_microusd)
    || !Number.isInteger(r.max_output_tokens) || r.max_output_tokens < 1 || r.max_output_tokens > 1000000
    || typeof r.payload_sha256 !== 'string' || !HEX64.test(r.payload_sha256)
    || r.purpose !== 'summary'
    || typeof r.retention_version !== 'string' || r.retention_version.length < 1 || r.retention_version.length > 200
    || typeof r.expires_at !== 'string') fail('invalid_request');
  const expiresMs = Date.parse(r.expires_at);
  if (!Number.isFinite(expiresMs)) fail('invalid_request');
  const c = {
    id: uuidCast(r.consent_id), workspace_id: uuidCast(r.workspace_id), actor_id: ctx.uid, document_id: uuidCast(r.document_id),
    source_revision: Number(r.source_revision), payload_sha256: r.payload_sha256, route_id: r.route_id ?? null, purpose: r.purpose,
    retention_version: r.retention_version, max_cost_microusd: Number(r.max_cost_microusd), max_output_tokens: r.max_output_tokens,
    expires_at: expiresMs * 1000, revoked_at: null,
  };
  if (!Number.isSafeInteger(c.source_revision) || !Number.isSafeInteger(c.max_cost_microusd)) fail('invalid_request');
  if (c.expires_at > ctx.now() + DAY_US) fail('invalid_request');
  const route = typeof c.route_id === 'string' ? ctx.q.get('select * from ai_routes where route_id=?', c.route_id) : undefined;
  if (!route || route.provider_id !== r.provider_id || route.model_id !== r.model_id || route.retention_version !== c.retention_version
      || c.max_cost_microusd > route.max_cost_microusd || c.max_output_tokens > route.max_output_tokens) fail('invalid_route');
  // Membership first: a non-member learns neither whether the workspace exists nor whether its AI is on.
  if (roleRank(ctx, c.workspace_id) < 1) fail('invalid_consent');
  if (!ctx.q.get('select 1 from workspaces where id=? and ai_enabled=1', c.workspace_id)) fail('ai_disabled');
  if (!aiAllowed(ctx, c)) fail('invalid_consent');
  const existing = getConsent(ctx, c.id);
  if (existing) {
    if (canonicalJson(consentJson(existing)) !== canonicalJson(consentJson(c))) fail('consent_id_reused');
  } else {
    ctx.q.run(`insert into ai_consents(id,workspace_id,actor_id,document_id,source_revision,payload_sha256,route_id,purpose,retention_version,
      max_cost_microusd,max_output_tokens,expires_at) values(?,?,?,?,?,?,?,?,?,?,?,?)`, c.id, c.workspace_id, c.actor_id, c.document_id,
      c.source_revision, c.payload_sha256, c.route_id, c.purpose, c.retention_version, c.max_cost_microusd, c.max_output_tokens, c.expires_at);
  }
  return consentJson(c);
}

function jobStatus(ctx, { p_job_id: id }) {
  if (!ctx.uid) fail('unauthenticated');
  const j = ctx.q.get('select * from ai_jobs where id=? and actor_id=?', id, ctx.uid) ?? fail('forbidden');
  const c = getConsent(ctx, j.consent_id);
  // Revocation/expiry does not hide status; current ACL still protects draft references.
  if (documentRank(ctx, j.workspace_id, c.document_id) < 1) return { id: j.id, state: j.state, cancel_requested: !!j.cancel_requested };
  return jobJson(ctx, j);
}

function cancelJob(ctx, { p_job_id: id }) {
  if (!ctx.uid) fail('unauthenticated');
  const j = ctx.q.get('select * from ai_jobs where id=? and actor_id=?', id, ctx.uid) ?? fail('forbidden');
  if (j.state === 'queued' || j.state === 'claimed') cancelQueued(ctx, j);
  else if (j.state === 'dispatched' || j.state === 'outcome_unknown') ctx.q.run('update ai_jobs set cancel_requested=1 where id=?', j.id);
  return jobStatus(ctx, { p_job_id: id });
}

function revokeConsent(ctx, { p_consent_id: id }) {
  if (!ctx.uid) fail('unauthenticated');
  if (!ctx.q.get('select 1 from ai_consents where id=? and actor_id=?', id, ctx.uid)) fail('forbidden');
  ctx.q.run('update ai_consents set revoked_at=coalesce(revoked_at,?) where id=?', ctx.now(), id);
  const c = getConsent(ctx, id);
  for (const j of ctx.q.all(`select * from ai_jobs where consent_id=? and state in (${ACTIVE.map(() => '?').join(',')}) order by id`, c.id, ...ACTIVE)) {
    if (j.state === 'queued' || j.state === 'claimed') cancelQueued(ctx, j);
    else ctx.q.run('update ai_jobs set cancel_requested=1 where id=?', j.id);
  }
  return { consent_id: c.id, revoked_at: utcText(c.revoked_at) };
}

/* ---------- executor RPCs ---------- */

function setRoute(ctx, { p_request: r }) {
  if (!isPlainObject(r) || !onlyKeys(r, ['route_id', 'provider_id', 'model_id', 'retention_version', 'max_cost_microusd', 'max_output_tokens'])) fail('invalid_route');
  const int = v => typeof v === 'number' ? (Number.isSafeInteger(v) ? v : NaN) : typeof v === 'string' && /^-?[0-9]{1,16}$/.test(v) ? Number(v) : NaN;
  const text = v => typeof v === 'string' && v.length >= 1 && v.length <= 200;
  const route = { route_id: r.route_id, provider_id: r.provider_id, model_id: r.model_id, retention_version: r.retention_version,
    max_cost_microusd: int(r.max_cost_microusd), max_output_tokens: int(r.max_output_tokens) };
  if (!text(route.route_id) || !text(route.provider_id) || !text(route.model_id) || !text(route.retention_version)
      || !(route.max_cost_microusd > 0) || !Number.isSafeInteger(route.max_cost_microusd)
      || !(route.max_output_tokens >= 1 && route.max_output_tokens <= 1000000)) fail('invalid_route');
  ctx.q.run(`insert into ai_routes(route_id,provider_id,model_id,retention_version,max_cost_microusd,max_output_tokens) values(?,?,?,?,?,?)
    on conflict(route_id) do nothing`, route.route_id, route.provider_id, route.model_id, route.retention_version, route.max_cost_microusd, route.max_output_tokens);
  const old = ctx.q.get('select * from ai_routes where route_id=?', route.route_id);
  if (canonicalJson(old) !== canonicalJson(route)) fail('route_immutable');
  return { ...route, max_cost_microusd: String(route.max_cost_microusd) };
}

function setBudget(ctx, { p_workspace_id: w, p_actor_id: actor, p_period: period, p_limit_microusd: limit }) {
  if (w === null || period === null || !PERIOD_RE.test(period) || limit === null || limit < 0) fail('invalid_request');
  if (!ctx.q.get('select 1 from workspaces where id=?', w)) fail('workspace_not_found');
  if (actor !== null && !ctx.q.get('select 1 from members where workspace_id=? and user_id=?', w, actor)) fail('actor_not_member');
  const scope = actor ?? '';
  ctx.q.run('insert into ai_budgets(workspace_id,scope,period,limit_microusd) values(?,?,?,?) on conflict do nothing', w, scope, period, limit);
  const b = ctx.q.get('select * from ai_budgets where workspace_id=? and scope=? and period=?', w, scope, period);
  if (b.limit_microusd !== limit) fail('budget_immutable');
  return { workspace_id: b.workspace_id, scope: b.scope, period: b.period, limit_microusd: String(b.limit_microusd),
    held_microusd: String(b.held_microusd), spent_microusd: String(b.spent_microusd) };
}

function admitJob(ctx, { p_actor_id: actor, p_request: r }) {
  if (actor === null || !isPlainObject(r)) fail('invalid_request');
  if (!onlyKeys(r, ['job_id', 'consent_id', 'input_ref', 'payload_sha256', 'route_id'])
    || typeof r.job_id !== 'string' || !UUID_RE.test(r.job_id) || typeof r.consent_id !== 'string' || !UUID_RE.test(r.consent_id)
    || typeof r.input_ref !== 'string' || !REF_RE.test(r.input_ref)
    || typeof r.payload_sha256 !== 'string' || !HEX64.test(r.payload_sha256)
    || typeof r.route_id !== 'string') fail('invalid_request');
  const c = ctx.q.get('select * from ai_consents where id=? and actor_id=?', uuidCast(r.consent_id), actor) ?? fail('invalid_consent');
  // Before the replay path: with AI off nothing is admitted or handed out again.
  if (!ctx.q.get('select 1 from workspaces where id=? and ai_enabled=1', c.workspace_id)) fail('ai_disabled');
  const hash = sha256(canonicalJson({ actor_id: actor, request: r }));
  const jobId = uuidCast(r.job_id);
  const existing = getJob(ctx, jobId);
  if (existing) {
    if (existing.actor_id !== actor || !Buffer.from(existing.request_hash).equals(hash)) fail('job_id_reused');
    if (!aiAllowed(ctx, c)) fail('invalid_consent');
    return jobJson(ctx, existing);
  }
  if (!aiAllowed(ctx, c) || c.payload_sha256 !== r.payload_sha256 || c.route_id !== r.route_id) fail('invalid_consent');
  // Single-use consent, checked before quotas.
  if (ctx.q.get('select 1 from ai_jobs where consent_id=?', c.id)) fail('consent_already_used');
  const now = ctx.now();
  const recent = ctx.q.get('select count(*) as n from ai_jobs where workspace_id=? and actor_id=? and created_at>?', c.workspace_id, actor, now - MINUTE_US).n;
  const active = ctx.q.get(`select count(*) as n from ai_jobs where workspace_id=? and actor_id=? and state in (${ACTIVE.map(() => '?').join(',')})`, c.workspace_id, actor, ...ACTIVE).n;
  if (recent >= 10 || active >= 3) fail('rate_limited');
  const period = new Date(Math.floor(now / 1000)).toISOString().slice(0, 7);
  const budgets = ctx.q.all("select * from ai_budgets where workspace_id=? and period=? and scope in ('',?)", c.workspace_id, period, actor);
  // Both the workspace and the actor budget rows must exist for this UTC month.
  if (budgets.length !== 2) fail('budget_not_configured');
  if (budgets.some(b => b.limit_microusd - b.spent_microusd - b.held_microusd < c.max_cost_microusd)) fail('budget_exceeded');
  ctx.q.run("update ai_budgets set held_microusd=held_microusd+? where workspace_id=? and period=? and scope in ('',?)", c.max_cost_microusd, c.workspace_id, period, actor);
  ctx.q.run(`insert into ai_jobs(id,workspace_id,actor_id,consent_id,request_hash,input_ref,period,reserved_microusd,created_at,actor_scope)
    values(?,?,?,?,?,?,?,?,?,?)`, jobId, c.workspace_id, actor, c.id, hash, r.input_ref, period, c.max_cost_microusd, now, actor);
  return jobJson(ctx, getJob(ctx, jobId));
}

function claimJob(ctx, { p_lease_seconds: lease }) {
  if (lease === null || lease < 1 || lease > 900) fail('invalid_lease');
  // Oldest queued job of the lowest workspace id, as the PostgreSQL version picked its first unlocked workspace.
  const w = ctx.q.get("select min(workspace_id) as w from ai_jobs where state='queued'").w;
  if (!w) return null;
  const j = ctx.q.get("select id from ai_jobs where workspace_id=? and state='queued' order by created_at,id limit 1", w);
  ctx.q.run("update ai_jobs set state='claimed',fencing_token=fencing_token+1,lease_until=? where id=?", ctx.now() + lease * 1_000_000, j.id);
  return jobJson(ctx, getJob(ctx, j.id));
}

function lockedJob(ctx, id, token) {
  const j = getJob(ctx, id) ?? fail('job_not_found');
  if (token === null || j.fencing_token !== token) fail('stale_fence');
  return j;
}
function requireClaimed(ctx, j) { if (j.state !== 'claimed' || j.lease_until <= ctx.now()) fail('not_claimed'); }

function beginDispatch(ctx, { p_job_id: id, p_fencing_token: token }) {
  const j = lockedJob(ctx, id, token);
  requireClaimed(ctx, j);
  const c = getConsent(ctx, j.consent_id);
  if (j.cancel_requested || !aiAllowed(ctx, c)) cancelQueued(ctx, j);
  else {
    ctx.q.run('insert into ai_attempts(workspace_id,job_id,fencing_token,dispatched_at) values(?,?,?,?)', j.workspace_id, j.id, j.fencing_token, ctx.now());
    ctx.q.run("update ai_jobs set state='dispatched' where id=?", j.id);
  }
  return jobJson(ctx, getJob(ctx, j.id));
}

function failBeforeDispatch(ctx, { p_job_id: id, p_fencing_token: token }) {
  const j = lockedJob(ctx, id, token);
  requireClaimed(ctx, j);
  release(ctx, j);
  ctx.q.run("update ai_jobs set state='failed',lease_until=null where id=?", j.id);
  return jobJson(ctx, getJob(ctx, j.id));
}

function markUnknown(ctx, { p_job_id: id, p_fencing_token: token }) {
  const j = lockedJob(ctx, id, token);
  if (j.state !== 'dispatched' && j.state !== 'outcome_unknown') fail('not_dispatched');
  ctx.q.run("update ai_jobs set state='outcome_unknown',lease_until=null where id=?", j.id);
  return jobJson(ctx, getJob(ctx, j.id));
}

function settleJob(ctx, { p_job_id: id, p_fencing_token: token, p_provider_event_id: event, p_cost_microusd: cost, p_outcome: outcome, p_result_ref: ref }) {
  const j = lockedJob(ctx, id, token);
  const l = ctx.q.get('select * from ai_usage_ledger where job_id=?', j.id);
  if (l) {
    if (l.provider_event_id !== event || l.cost_microusd !== cost || l.outcome !== outcome || l.result_ref !== ref) fail('settlement_conflict');
    return jobJson(ctx, j);
  }
  if ((j.state !== 'dispatched' && j.state !== 'outcome_unknown') || j.hold_released) fail('not_dispatched');
  if (cost === null || cost < 0 || cost > j.reserved_microusd) fail('invalid_cost');
  if ((outcome !== 'succeeded' && outcome !== 'failed') || (outcome === 'succeeded' && ref === null) || (outcome === 'failed' && ref !== null)) fail('invalid_outcome');
  if (event === null || event.length < 1 || event.length > 200 || (ref !== null && !REF_RE.test(ref))) fail('invalid_request');
  if (ctx.q.get('select 1 from ai_usage_ledger where provider_event_id=?', event)) fail('event_id_reused');
  ctx.q.run('insert into ai_usage_ledger(workspace_id,job_id,provider_event_id,cost_microusd,outcome,result_ref,settled_at) values(?,?,?,?,?,?,?)',
    j.workspace_id, j.id, event, cost, outcome, ref, ctx.now());
  release(ctx, j);
  ctx.q.run("update ai_budgets set spent_microusd=spent_microusd+? where workspace_id=? and period=? and scope in ('',?)", cost, j.workspace_id, j.period, j.actor_id ?? '');
  ctx.q.run(`update ai_jobs set state=case when cancel_requested=1 then 'cancelled' else ? end,
    result_ref=case when cancel_requested=1 then null else ? end,lease_until=null where id=?`, outcome, ref, j.id);
  return jobJson(ctx, getJob(ctx, j.id));
}

function reapJobs(ctx) {
  const reaped = ctx.q.run(`update ai_jobs set state=case when state='claimed' then 'queued' else 'outcome_unknown' end,lease_until=null
    where state in ('claimed','dispatched') and lease_until<=?`, ctx.now());
  return { reaped };
}

/** Account deletion (F24): u's AI rows that stay (in workspaces that remain) are unlinked; u's budget rows go. */
export function forgetUserAi(ctx, u) {
  ctx.q.run('update ai_consents set actor_id=null where actor_id=?', u);
  // request_hash covers the actor id, so a candidate id could be confirmed against it; it becomes a hash of the job id.
  for (const { id } of ctx.q.all('select id from ai_jobs where actor_id=? order by id', u)) {
    ctx.q.run('update ai_jobs set actor_id=null,actor_scope=null,request_hash=? where id=?', sha256(id), id);
  }
  // After the jobs: until their actor_scope became NULL, they referenced these rows.
  ctx.q.run('delete from ai_budgets where scope=?', u);
}

export const AI_RPCS = [
  { name: 'ai_grant_consent', roles: USER, params: [['p_request', 'json']], fn: grantConsent },
  { name: 'ai_revoke_consent', roles: USER, params: [['p_consent_id', 'uuid']], fn: revokeConsent },
  { name: 'ai_cancel_job', roles: USER, params: [['p_job_id', 'uuid']], fn: cancelJob },
  { name: 'ai_job_status', roles: USER, params: [['p_job_id', 'uuid']], fn: jobStatus },
  { name: 'ai_set_route', roles: EXECUTOR, params: [['p_request', 'json']], fn: setRoute },
  { name: 'ai_set_budget', roles: EXECUTOR, params: [['p_workspace_id', 'uuid'], ['p_actor_id', 'uuid'], ['p_period', 'text'], ['p_limit_microusd', 'bigint']], fn: setBudget },
  { name: 'ai_admit_job', roles: EXECUTOR, params: [['p_actor_id', 'uuid'], ['p_request', 'json']], fn: admitJob },
  { name: 'ai_claim_job', roles: EXECUTOR, params: [['p_lease_seconds', 'integer', 60]], fn: claimJob },
  { name: 'ai_begin_dispatch', roles: EXECUTOR, params: [['p_job_id', 'uuid'], ['p_fencing_token', 'bigint']], fn: beginDispatch },
  { name: 'ai_fail_before_dispatch', roles: EXECUTOR, params: [['p_job_id', 'uuid'], ['p_fencing_token', 'bigint']], fn: failBeforeDispatch },
  { name: 'ai_mark_unknown', roles: EXECUTOR, params: [['p_job_id', 'uuid'], ['p_fencing_token', 'bigint']], fn: markUnknown },
  { name: 'ai_settle_job', roles: EXECUTOR, params: [['p_job_id', 'uuid'], ['p_fencing_token', 'bigint'], ['p_provider_event_id', 'text'], ['p_cost_microusd', 'bigint'], ['p_outcome', 'text'], ['p_result_ref', 'text', null]], fn: settleJob },
  { name: 'ai_reap_jobs', roles: EXECUTOR, params: [], fn: reapJobs },
];
