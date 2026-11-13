begin;
-- Executor is intentionally not granted to service_role or authenticated here.
-- Provision a narrowly authenticated gateway/worker connection separately.
-- Errors follow shared/contracts/errors.js: raise '<reason>' using errcode='PT<status>'. Inputs are validated
-- before casts and constraints, so any other SQLSTATE reaching a caller is a server fault.
create role ai_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create table app.ai_routes(
 route_id text primary key check(length(route_id) between 1 and 200),
 provider_id text not null check(length(provider_id) between 1 and 200),
 model_id text not null check(length(model_id) between 1 and 200),
 retention_version text not null check(length(retention_version) between 1 and 200),
 max_cost_microusd bigint not null check(max_cost_microusd>0),
 max_output_tokens integer not null check(max_output_tokens between 1 and 1000000)
);
-- AI rows go with their document or workspace (ON DELETE CASCADE below); only private.delete_workspace, run by account
-- deletion, deletes either. A row that stays when its actor's account is deleted keeps actor_id NULL (F24).
create table app.ai_consents(
 id uuid primary key, workspace_id uuid not null, actor_id uuid references auth.users(id),
 document_id uuid not null, source_revision bigint not null check(source_revision>0),
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 route_id text not null references app.ai_routes(route_id),
 purpose text not null check(purpose='summary'),
 retention_version text not null check(length(retention_version) between 1 and 200),
 max_cost_microusd bigint not null check(max_cost_microusd>0),
 max_output_tokens integer not null check(max_output_tokens between 1 and 1000000),
 expires_at timestamptz not null, revoked_at timestamptz,
 unique(workspace_id,id), foreign key(workspace_id,document_id) references app.documents(workspace_id,id) on delete cascade
);
create table app.ai_budgets(
 workspace_id uuid not null references app.workspaces(id) on delete cascade,
 -- Empty scope is workspace; UUID text is that actor's workspace-period budget.
 scope text not null, period text not null check(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 limit_microusd bigint not null check(limit_microusd>=0),
 held_microusd bigint not null default 0 check(held_microusd>=0),
 spent_microusd bigint not null default 0 check(spent_microusd>=0),
 primary key(workspace_id,scope,period),
 check(held_microusd <= limit_microusd-spent_microusd)
);
create table app.ai_jobs(
 id uuid primary key,workspace_id uuid not null,actor_id uuid references auth.users(id),
 consent_id uuid not null unique,request_hash bytea not null check(octet_length(request_hash)=32),
 input_ref text not null check(input_ref ~ '^[A-Za-z0-9_-]{1,200}$'),
 period text not null, reserved_microusd bigint not null check(reserved_microusd>0),
 state text not null default 'queued' check(state in ('queued','claimed','dispatched','outcome_unknown','succeeded','failed','cancelled')),
 fencing_token bigint not null default 0, lease_until timestamptz,
 cancel_requested boolean not null default false,hold_released boolean not null default false,
 created_at timestamptz not null default clock_timestamp(), result_ref text,
 unique(workspace_id,id),foreign key(workspace_id,consent_id) references app.ai_consents(workspace_id,id) on delete cascade,
 workspace_scope text not null default '' check(workspace_scope=''),
 actor_scope text generated always as (actor_id::text) stored,
 foreign key(workspace_id,workspace_scope,period) references app.ai_budgets(workspace_id,scope,period),
 foreign key(workspace_id,actor_scope,period) references app.ai_budgets(workspace_id,scope,period)
);
create index ai_queue on app.ai_jobs(created_at,id) where state='queued';
-- Account deletion finds the actor's rows, and so do the foreign key checks of the auth.users delete (F24).
create index ai_consents_actor on app.ai_consents(actor_id) where actor_id is not null;
create index ai_jobs_actor on app.ai_jobs(actor_id) where actor_id is not null;
-- private.delete_workspace's cascade from each deleted document (F61).
create index ai_consents_document on app.ai_consents(workspace_id,document_id);
-- The checks of the two budget foreign keys when a budget row is deleted (account deletion, or the cascade from a
-- deleted workspace). Each has its key's exact columns, so a check reads only jobs that reference that row, never the
-- other jobs of its month (F61).
create index ai_jobs_actor_budget on app.ai_jobs(workspace_id,actor_scope,period);
create index ai_jobs_workspace_budget on app.ai_jobs(workspace_id,workspace_scope,period);
create table app.ai_attempts(
 workspace_id uuid not null,job_id uuid primary key,fencing_token bigint not null,
 dispatched_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,job_id) references app.ai_jobs(workspace_id,id) on delete cascade
);
create table app.ai_usage_ledger(
 workspace_id uuid not null,job_id uuid primary key,provider_event_id text not null unique check(length(provider_event_id) between 1 and 200),
 cost_microusd bigint not null check(cost_microusd>=0),outcome text not null check(outcome in ('succeeded','failed')),
 result_ref text check(result_ref ~ '^[A-Za-z0-9_-]{1,200}$'),settled_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,job_id) references app.ai_jobs(workspace_id,id) on delete cascade
);
-- Internal helper temporarily binds existing ACL helpers to the verified actor. F29 minimum: the actor needs edit
-- access to the document, and the workspace's AI switch must be on.
create function private.ai_allowed(c app.ai_consents) returns boolean language plpgsql set search_path=pg_catalog as $$
declare old_sub text:=current_setting('request.jwt.claim.sub',true); ok boolean;
begin
 -- Anonymised (account deleted): nobody to check. set_config would store '', and the hosted auth.uid() then reads the
 -- caller's JWT claims instead.
 if c.actor_id is null then return false; end if;
 perform set_config('request.jwt.claim.sub',c.actor_id::text,true);
 select private.document_rank(c.workspace_id,c.document_id)>=2 and x.ai_enabled and not d.deleted and d.revision=c.source_revision
 into ok from app.documents d join app.workspaces x on x.id=d.workspace_id where d.workspace_id=c.workspace_id and d.id=c.document_id;
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
 return coalesce(ok,false) and c.revoked_at is null and c.expires_at>clock_timestamp();
end $$;
create function private.ai_job_json(j app.ai_jobs) returns jsonb language sql stable set search_path=pg_catalog as $$
 select (to_jsonb(j)-'request_hash'-'workspace_scope'-'actor_scope') ||
 jsonb_build_object('fencing_token',j.fencing_token::text,'reserved_microusd',j.reserved_microusd::text,
 'source_stale',not exists(select 1 from app.documents d where d.workspace_id=j.workspace_id and d.id=c.document_id and d.revision=c.source_revision and not d.deleted),'document_id',c.document_id,'source_revision',c.source_revision::text,'payload_sha256',c.payload_sha256,
 'provider_id',r.provider_id,'model_id',r.model_id,'route_id',c.route_id,'purpose',c.purpose,'retention_version',c.retention_version,
 'max_cost_microusd',c.max_cost_microusd::text,'max_output_tokens',c.max_output_tokens,'expires_at',c.expires_at)
 from app.ai_consents c join app.ai_routes r on r.route_id=c.route_id where c.id=j.consent_id and c.workspace_id=j.workspace_id
$$;
-- All mutations acquire workspace before job and budgets. Budget order is scope text.
create function private.ai_release(j app.ai_jobs) returns void language plpgsql set search_path=pg_catalog as $$
begin
 if j.hold_released then return; end if;
 perform 1 from app.ai_budgets where workspace_id=j.workspace_id and period=j.period and scope in ('',j.actor_id::text) order by scope for update;
 update app.ai_budgets set held_microusd=held_microusd-j.reserved_microusd
 where workspace_id=j.workspace_id and period=j.period and scope in ('',j.actor_id::text);
 update app.ai_jobs set hold_released=true where id=j.id;
end $$;
create function public.ai_grant_consent(p_request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c app.ai_consents; existing app.ai_consents; cname text;
 uuid_re constant text:='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='PT401'; end if;
 -- Separate IF: the key filter below fails on a non-object.
 if p_request is null or jsonb_typeof(p_request)<>'object' then raise exception 'invalid_request' using errcode='PT400'; end if;
 -- Every field is checked before a cast or table constraint can fail. The revision is a decimal string of at most
 -- 19 digits within bigint (as the gateway accepts); the cost is a 1-18 digit decimal string.
 if p_request->'approved' is distinct from 'true'::jsonb
  or (p_request - array['approved','provider_id','model_id','consent_id','workspace_id','document_id','source_revision','payload_sha256','route_id','purpose','retention_version','max_cost_microusd','max_output_tokens','expires_at'])<>'{}'::jsonb
  or coalesce(p_request->>'consent_id','') !~ uuid_re or coalesce(p_request->>'workspace_id','') !~ uuid_re or coalesce(p_request->>'document_id','') !~ uuid_re
  or jsonb_typeof(p_request->'source_revision') is distinct from 'string' or p_request->>'source_revision' !~ '^[1-9][0-9]{0,18}$'
  or jsonb_typeof(p_request->'max_cost_microusd') is distinct from 'string' or p_request->>'max_cost_microusd' !~ '^[1-9][0-9]{0,17}$'
  or jsonb_typeof(p_request->'max_output_tokens') is distinct from 'number' or p_request->>'max_output_tokens' !~ '^([1-9][0-9]{0,5}|1000000)$'
  or jsonb_typeof(p_request->'payload_sha256') is distinct from 'string' or p_request->>'payload_sha256' !~ '^[a-f0-9]{64}$'
  or p_request->'purpose' is distinct from '"summary"'::jsonb
  or jsonb_typeof(p_request->'retention_version') is distinct from 'string' or length(p_request->>'retention_version') not between 1 and 200
  or jsonb_typeof(p_request->'expires_at') is distinct from 'string'
 then raise exception 'invalid_request' using errcode='PT400'; end if;
 -- Separate IF: the numeric cast is safe only after the digit check above.
 if (p_request->>'source_revision')::numeric>9223372036854775807 then raise exception 'invalid_request' using errcode='PT400'; end if;
 c.id:=(p_request->>'consent_id')::uuid;c.workspace_id:=(p_request->>'workspace_id')::uuid;c.actor_id:=auth.uid();
 c.document_id:=(p_request->>'document_id')::uuid;c.source_revision:=(p_request->>'source_revision')::bigint;
 c.payload_sha256:=p_request->>'payload_sha256';c.route_id:=p_request->>'route_id';c.purpose:=p_request->>'purpose';c.retention_version:=p_request->>'retention_version';
 c.max_cost_microusd:=(p_request->>'max_cost_microusd')::bigint;c.max_output_tokens:=(p_request->>'max_output_tokens')::integer;
 -- The timestamptz parser is the guard for expires_at; these are its input errors.
 begin
  c.expires_at:=(p_request->>'expires_at')::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value or invalid_parameter_value then
  raise exception 'invalid_request' using errcode='PT400';
 end;
 if c.expires_at>clock_timestamp()+interval '24 hours' then raise exception 'invalid_request' using errcode='PT400'; end if;
 perform 1 from app.workspaces where id=c.workspace_id for update;
 if not exists(select 1 from app.ai_routes r where r.route_id=c.route_id and r.provider_id=p_request->>'provider_id' and r.model_id=p_request->>'model_id' and r.retention_version=c.retention_version and c.max_cost_microusd<=r.max_cost_microusd and c.max_output_tokens<=r.max_output_tokens) then raise exception 'invalid_route' using errcode='PT400';end if;
 -- Membership first: a non-member learns neither whether the workspace exists nor whether its AI is on.
 if private.role_rank(c.workspace_id)<1 then raise exception 'invalid_consent' using errcode='PT403'; end if;
 if not exists(select 1 from app.workspaces where id=c.workspace_id and ai_enabled) then raise exception 'ai_disabled' using errcode='PT403'; end if;
 if not private.ai_allowed(c) then raise exception 'invalid_consent' using errcode='PT403'; end if;
 select * into existing from app.ai_consents where id=c.id;
 if found then
  if to_jsonb(existing) is distinct from to_jsonb(c) then raise exception 'consent_id_reused' using errcode='PT409'; end if;
 else
  begin
   insert into app.ai_consents select c.*;
  exception when unique_violation then
   -- Backstop: a concurrent grant of this ID in another workspace (no shared lock). Any other unique violation
   -- is re-raised unchanged, so it stays a server fault.
   get stacked diagnostics cname=constraint_name;
   if cname in ('ai_consents_pkey','ai_consents_workspace_id_id_key') then raise exception 'consent_id_reused' using errcode='PT409'; end if;
   raise;
  end;
 end if;
 return to_jsonb(c)||jsonb_build_object('source_revision',c.source_revision::text,'max_cost_microusd',c.max_cost_microusd::text);
end $$;
create function public.ai_set_route(p_request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r app.ai_routes;old app.ai_routes;begin
 if p_request is null or jsonb_typeof(p_request)<>'object' then raise exception 'invalid_route' using errcode='PT400';end if;
 if (p_request-array['route_id','provider_id','model_id','retention_version','max_cost_microusd','max_output_tokens'])<>'{}'::jsonb then raise exception 'invalid_route' using errcode='PT400';end if;
 -- The column input functions are the format guard for the numeric fields; accepted inputs are unchanged.
 begin
  r:=jsonb_populate_record(null::app.ai_routes,p_request);
 exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid_route' using errcode='PT400';
 end;
 -- Mirrors the table constraints, so the insert below cannot fail on them.
 if not coalesce(length(r.route_id) between 1 and 200 and length(r.provider_id) between 1 and 200 and length(r.model_id) between 1 and 200
  and length(r.retention_version) between 1 and 200 and r.max_cost_microusd>0 and r.max_output_tokens between 1 and 1000000,false)
 then raise exception 'invalid_route' using errcode='PT400';end if;
 insert into app.ai_routes select r.* on conflict(route_id) do nothing;
 select * into old from app.ai_routes where route_id=r.route_id;
 if old is distinct from r then raise exception 'route_immutable' using errcode='PT409';end if;
 return to_jsonb(r)||jsonb_build_object('max_cost_microusd',r.max_cost_microusd::text);
end $$;
create function public.ai_set_budget(p_workspace_id uuid,p_actor_id uuid,p_period text,p_limit_microusd bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare b app.ai_budgets;
begin
 -- Mirrors the table constraints on period and limit.
 if p_workspace_id is null or p_period is null or p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_limit_microusd is null or p_limit_microusd<0 then raise exception 'invalid_request' using errcode='PT400';end if;
 perform 1 from app.workspaces where id=p_workspace_id for update;
 if not found then raise exception 'workspace_not_found' using errcode='PT404';end if;
 if p_actor_id is not null and not exists(select 1 from app.members where workspace_id=p_workspace_id and user_id=p_actor_id) then raise exception 'actor_not_member' using errcode='PT400';end if;
 insert into app.ai_budgets(workspace_id,scope,period,limit_microusd) values(p_workspace_id,coalesce(p_actor_id::text,''),p_period,p_limit_microusd)
 on conflict(workspace_id,scope,period) do nothing;
 select * into b from app.ai_budgets where workspace_id=p_workspace_id and scope=coalesce(p_actor_id::text,'') and period=p_period;
 if b.limit_microusd is distinct from p_limit_microusd then raise exception 'budget_immutable' using errcode='PT409'; end if;
 return to_jsonb(b)||jsonb_build_object('limit_microusd',b.limit_microusd::text,'held_microusd',b.held_microusd::text,'spent_microusd',b.spent_microusd::text);
end $$;
create function public.ai_admit_job(p_actor_id uuid,p_request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c app.ai_consents;j app.ai_jobs;h bytea;period_key text:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM'); n integer; room integer; cname text;
 uuid_re constant text:='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
begin
 -- Separate IF: the key filter below fails on a non-object.
 if p_actor_id is null or p_request is null or jsonb_typeof(p_request)<>'object' then raise exception 'invalid_request' using errcode='PT400';end if;
 if (p_request-array['job_id','consent_id','input_ref','payload_sha256','route_id'])<>'{}'::jsonb
  or coalesce(p_request->>'job_id','') !~ uuid_re or coalesce(p_request->>'consent_id','') !~ uuid_re
  or jsonb_typeof(p_request->'input_ref') is distinct from 'string' or p_request->>'input_ref' !~ '^[A-Za-z0-9_-]{1,200}$'
  or jsonb_typeof(p_request->'payload_sha256') is distinct from 'string' or p_request->>'payload_sha256' !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(p_request->'route_id') is distinct from 'string'
 then raise exception 'invalid_request' using errcode='PT400';end if;
 select * into c from app.ai_consents where id=(p_request->>'consent_id')::uuid and actor_id=p_actor_id;
 if not found then raise exception 'invalid_consent' using errcode='PT403';end if;
 perform 1 from app.workspaces where id=c.workspace_id for update;
 select * into c from app.ai_consents where id=c.id;
 -- Gone with its workspace (account deletion) while this call waited for the lock.
 if not found then raise exception 'invalid_consent' using errcode='PT403';end if;
 -- Before the replay path: with AI off nothing is admitted or handed out again.
 if not exists(select 1 from app.workspaces where id=c.workspace_id and ai_enabled) then raise exception 'ai_disabled' using errcode='PT403';end if;
 h:=sha256(convert_to(jsonb_build_object('actor_id',p_actor_id,'request',p_request)::text,'UTF8'));
 select * into j from app.ai_jobs where id=(p_request->>'job_id')::uuid;
 if found then
  if j.actor_id<>p_actor_id or j.request_hash<>h then raise exception 'job_id_reused' using errcode='PT409';end if;
  if not private.ai_allowed(c) then raise exception 'invalid_consent' using errcode='PT403';end if;
  return private.ai_job_json(j);
 end if;
 if not private.ai_allowed(c) or c.payload_sha256 is distinct from p_request->>'payload_sha256' or c.route_id is distinct from p_request->>'route_id' then raise exception 'invalid_consent' using errcode='PT403';end if;
 -- Single-use consent, checked before quotas; the unique key on the insert below is the backstop.
 if exists(select 1 from app.ai_jobs where consent_id=c.id) then raise exception 'consent_already_used' using errcode='PT409';end if;
 if (select count(*) from app.ai_jobs where workspace_id=c.workspace_id and actor_id=p_actor_id and created_at>clock_timestamp()-interval '1 minute')>=10
 or (select count(*) from app.ai_jobs where workspace_id=c.workspace_id and actor_id=p_actor_id and state in ('queued','claimed','dispatched','outcome_unknown'))>=3 then raise exception 'rate_limited' using errcode='PT429';end if;
 perform 1 from app.ai_budgets where workspace_id=c.workspace_id and period=period_key and scope in ('',p_actor_id::text) order by scope for update;
 select count(*),count(*) filter(where limit_microusd-spent_microusd-held_microusd>=c.max_cost_microusd) into n,room
 from app.ai_budgets where workspace_id=c.workspace_id and period=period_key and scope in ('',p_actor_id::text);
 -- Both the workspace and the actor budget rows must exist for this UTC month.
 if n<>2 then raise exception 'budget_not_configured' using errcode='PT402';end if;
 if room<>2 then raise exception 'budget_exceeded' using errcode='PT402';end if;
 update app.ai_budgets set held_microusd=held_microusd+c.max_cost_microusd where workspace_id=c.workspace_id and period=period_key and scope in ('',p_actor_id::text);
 begin
  insert into app.ai_jobs(id,workspace_id,actor_id,consent_id,request_hash,input_ref,period,reserved_microusd)
  values((p_request->>'job_id')::uuid,c.workspace_id,p_actor_id,c.id,h,p_request->>'input_ref',period_key,c.max_cost_microusd) returning * into j;
 exception when unique_violation then
  -- Backstop for races the checks above cannot see, e.g. one job ID admitted concurrently in two workspaces.
  get stacked diagnostics cname=constraint_name;
  if cname='ai_jobs_consent_id_key' then raise exception 'consent_already_used' using errcode='PT409';end if;
  if cname in ('ai_jobs_pkey','ai_jobs_workspace_id_id_key') then raise exception 'job_id_reused' using errcode='PT409';end if;
  raise;
 end;
 return private.ai_job_json(j);
end $$;
create function public.ai_job_status(p_job_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare j app.ai_jobs;c app.ai_consents;begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='PT401';end if;
 select * into j from app.ai_jobs where id=p_job_id and actor_id=auth.uid();
 if not found then raise exception 'forbidden' using errcode='PT403';end if;
 select * into c from app.ai_consents where id=j.consent_id;
 -- Revocation/expiry does not hide status; current ACL still protects draft references.
 if private.document_rank(j.workspace_id,c.document_id)<1 then
 return jsonb_build_object('id',j.id,'state',j.state,'cancel_requested',j.cancel_requested);
 end if;
 return private.ai_job_json(j);
end $$;
create function public.ai_cancel_job(p_job_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare j app.ai_jobs;begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='PT401';end if;
 select * into j from app.ai_jobs where id=p_job_id and actor_id=auth.uid();
 if not found then raise exception 'forbidden' using errcode='PT403';end if;
 perform 1 from app.workspaces where id=j.workspace_id for update;
 select * into j from app.ai_jobs where id=p_job_id for update;
 -- Jobs go with their workspace (account deletion), possibly while this call waited for the lock.
 if not found then raise exception 'job_not_found' using errcode='PT404';end if;
 if j.state in ('queued','claimed') then
  perform private.ai_release(j);
  update app.ai_jobs set state='cancelled',cancel_requested=true,lease_until=null where id=j.id;
 elsif j.state in ('dispatched','outcome_unknown') then update app.ai_jobs set cancel_requested=true where id=j.id;
 end if;
 return public.ai_job_status(p_job_id);
end $$;
create function public.ai_revoke_consent(p_consent_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c app.ai_consents;j app.ai_jobs;begin
 if auth.uid() is null then raise exception 'unauthenticated' using errcode='PT401';end if;
 select * into c from app.ai_consents where id=p_consent_id and actor_id=auth.uid();
 if not found then raise exception 'forbidden' using errcode='PT403';end if;
 perform 1 from app.workspaces where id=c.workspace_id for update;
 update app.ai_consents set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=c.id returning * into c;
 -- Gone with its workspace while this call waited for the lock: the answer for no such consent.
 if not found then raise exception 'forbidden' using errcode='PT403';end if;
 for j in select * from app.ai_jobs where consent_id=c.id and state in ('queued','claimed','dispatched','outcome_unknown') order by id for update loop
  if j.state in ('queued','claimed') then
   perform private.ai_release(j);update app.ai_jobs set state='cancelled',cancel_requested=true,lease_until=null where id=j.id;
  else update app.ai_jobs set cancel_requested=true where id=j.id;end if;
 end loop;
 return jsonb_build_object('consent_id',c.id,'revoked_at',c.revoked_at);
end $$;
create function public.ai_claim_job(p_lease_seconds integer default 60) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare j app.ai_jobs;w uuid;begin
 if p_lease_seconds is null or p_lease_seconds not between 1 and 900 then raise exception 'invalid_lease' using errcode='PT400';end if;
 -- Lock workspace first: same order as revocation and synchronization ACL updates.
 select x.id into w from app.workspaces x where exists(select 1 from app.ai_jobs q where q.workspace_id=x.id and q.state='queued') order by x.id for update of x skip locked limit 1;
 if w is null then return null;end if;
 select * into j from app.ai_jobs where workspace_id=w and state='queued' order by created_at,id for update skip locked limit 1;
 if not found then return null;end if;
 update app.ai_jobs set state='claimed',fencing_token=fencing_token+1,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds) where id=j.id returning * into j;
 return private.ai_job_json(j);
end $$;
create function private.ai_locked_job(job uuid,token bigint) returns app.ai_jobs language plpgsql set search_path=pg_catalog as $$
declare j app.ai_jobs;begin
 select * into j from app.ai_jobs where id=job;
 if not found then raise exception 'job_not_found' using errcode='PT404';end if;
 perform 1 from app.workspaces where id=j.workspace_id for update;
 select * into j from app.ai_jobs where id=job for update;
 -- Jobs go with their workspace (account deletion), possibly while this call waited for the lock.
 if not found then raise exception 'job_not_found' using errcode='PT404';end if;
 if token is null or j.fencing_token<>token then raise exception 'stale_fence' using errcode='PT409';end if;
 return j;
end $$;
create function public.ai_begin_dispatch(p_job_id uuid,p_fencing_token bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare j app.ai_jobs;c app.ai_consents;begin
 j:=private.ai_locked_job(p_job_id,p_fencing_token);
 if j.state<>'claimed' or j.lease_until<=clock_timestamp() then raise exception 'not_claimed' using errcode='PT409';end if;
 select * into c from app.ai_consents where id=j.consent_id;
 if j.cancel_requested or not private.ai_allowed(c) then
  perform private.ai_release(j);update app.ai_jobs set state='cancelled',cancel_requested=true,lease_until=null where id=j.id returning * into j;
 else
  insert into app.ai_attempts(workspace_id,job_id,fencing_token) values(j.workspace_id,j.id,j.fencing_token);
  update app.ai_jobs set state='dispatched' where id=j.id returning * into j;
 end if;
 return private.ai_job_json(j);
end $$;
create function public.ai_fail_before_dispatch(p_job_id uuid,p_fencing_token bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare j app.ai_jobs;begin
 j:=private.ai_locked_job(p_job_id,p_fencing_token);
 if j.state<>'claimed' or j.lease_until<=clock_timestamp() then raise exception 'not_claimed' using errcode='PT409';end if;
 perform private.ai_release(j);update app.ai_jobs set state='failed',lease_until=null where id=j.id returning * into j;
 return private.ai_job_json(j);
end $$;
create function public.ai_mark_unknown(p_job_id uuid,p_fencing_token bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare j app.ai_jobs;begin
 j:=private.ai_locked_job(p_job_id,p_fencing_token);
 if j.state not in ('dispatched','outcome_unknown') then raise exception 'not_dispatched' using errcode='PT409';end if;
 update app.ai_jobs set state='outcome_unknown',lease_until=null where id=j.id returning * into j;
 return private.ai_job_json(j);
end $$;
create function public.ai_settle_job(p_job_id uuid,p_fencing_token bigint,p_provider_event_id text,p_cost_microusd bigint,p_outcome text,p_result_ref text default null) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare j app.ai_jobs;l app.ai_usage_ledger;cname text;begin
 j:=private.ai_locked_job(p_job_id,p_fencing_token);
 select * into l from app.ai_usage_ledger where job_id=j.id;
 if found then
  if l.provider_event_id is distinct from p_provider_event_id or l.cost_microusd is distinct from p_cost_microusd or l.outcome is distinct from p_outcome or l.result_ref is distinct from p_result_ref then raise exception 'settlement_conflict' using errcode='PT409';end if;
  return private.ai_job_json(j);
 end if;
 if j.state not in ('dispatched','outcome_unknown') or j.hold_released then raise exception 'not_dispatched' using errcode='PT409';end if;
 if p_cost_microusd is null or p_cost_microusd<0 or p_cost_microusd>j.reserved_microusd then raise exception 'invalid_cost' using errcode='PT400';end if;
 if p_outcome is null or p_outcome not in ('succeeded','failed') or (p_outcome='succeeded' and p_result_ref is null) or (p_outcome='failed' and p_result_ref is not null) then raise exception 'invalid_outcome' using errcode='PT400';end if;
 -- Mirrors the ledger CHECKs on the event ID and result reference.
 if p_provider_event_id is null or length(p_provider_event_id) not between 1 and 200 or (p_result_ref is not null and p_result_ref !~ '^[A-Za-z0-9_-]{1,200}$') then raise exception 'invalid_request' using errcode='PT400';end if;
 if exists(select 1 from app.ai_usage_ledger where provider_event_id=p_provider_event_id) then raise exception 'event_id_reused' using errcode='PT409';end if;
 begin
  insert into app.ai_usage_ledger(workspace_id,job_id,provider_event_id,cost_microusd,outcome,result_ref) values(j.workspace_id,j.id,p_provider_event_id,p_cost_microusd,p_outcome,p_result_ref);
 exception when unique_violation then
  -- Backstop: the same event settled concurrently for a job in another workspace (no shared lock).
  get stacked diagnostics cname=constraint_name;
  if cname='ai_usage_ledger_provider_event_id_key' then raise exception 'event_id_reused' using errcode='PT409';end if;
  raise;
 end;
 perform private.ai_release(j);
 update app.ai_budgets set spent_microusd=spent_microusd+p_cost_microusd where workspace_id=j.workspace_id and period=j.period and scope in ('',j.actor_id::text);
 update app.ai_jobs set state=case when cancel_requested then 'cancelled' else p_outcome end,result_ref=case when cancel_requested then null else p_result_ref end,lease_until=null where id=j.id returning * into j;
 return private.ai_job_json(j);
end $$;
create function public.ai_reap_jobs() returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare w record;j app.ai_jobs;n integer:=0;begin
 for w in select x.id from app.workspaces x where exists(select 1 from app.ai_jobs q where q.workspace_id=x.id and q.state in ('claimed','dispatched') and q.lease_until<=clock_timestamp()) order by x.id for update of x skip locked loop
  for j in select * from app.ai_jobs where workspace_id=w.id and state in ('claimed','dispatched') and lease_until<=clock_timestamp() order by id for update skip locked loop
   update app.ai_jobs set state=case when j.state='claimed' then 'queued' else 'outcome_unknown' end,lease_until=null where id=j.id;n:=n+1;
  end loop;
 end loop;
 return jsonb_build_object('reaped',n);
end $$;
-- Account deletion (F24): this replaces the sync migration's no-op hook, and CREATE OR REPLACE keeps its owner
-- (sync_backend) and revoked EXECUTE. It runs after the sync cleanup, so u's solo workspaces are gone with their AI
-- rows. The rest stay, unlinked. In a workspace u no longer belongs to this is row work without a workspace lock: no
-- RPC adds a row of u there (consent and admission need edit access, a budget needs membership), ai_reap_jobs skips
-- locked rows, and each row is changed once, so no foreign key re-check key-shares the workspace. A call holding u's job
-- or consent row delays the hook until it commits. One that updates u's job twice (private.ai_release, then its final
-- UPDATE: the cancel path of ai_begin_dispatch, ai_fail_before_dispatch, ai_settle_job, u's own ai_cancel_job or
-- ai_revoke_consent) re-checks the actor foreign key and waits for the auth.users row being deleted: a cycle that the
-- trigger's lock_timeout ends with 55P03 (the caller retries), in a workspace u left as in one u belongs to.
create or replace function private.forget_user_hook(u uuid) returns void language plpgsql set search_path=pg_catalog as $$
declare i uuid;begin
 for i in select id from app.ai_consents where actor_id=u order by id loop update app.ai_consents set actor_id=null where id=i;end loop;
 -- request_hash covers the actor id, so a candidate id could be confirmed against it; it becomes a hash of the job id.
 -- Replay needs no hash any more: admission looks the consent up by actor.
 for i in select id from app.ai_jobs where actor_id=u order by id loop update app.ai_jobs set actor_id=null,request_hash=sha256(uuid_send(i)) where id=i;end loop;
 -- After the jobs: until their actor_id became NULL, their actor_scope referenced these rows.
 delete from app.ai_budgets where scope=u::text;
end $$;
do $$ declare t text;fn text;begin
 foreach t in array array['ai_routes','ai_consents','ai_budgets','ai_jobs','ai_attempts','ai_usage_ledger'] loop
  execute format('alter table app.%I enable row level security',t);
  execute format('revoke all on app.%I from public,anon,authenticated,ai_executor',t);
  execute format('alter table app.%I owner to sync_backend',t);
 end loop;
 foreach fn in array array['ai_allowed(app.ai_consents)','ai_job_json(app.ai_jobs)','ai_release(app.ai_jobs)','ai_locked_job(uuid,bigint)'] loop
  execute 'revoke all on function private.'||fn||' from public,anon,authenticated,ai_executor';
  execute 'alter function private.'||fn||' owner to sync_backend';
 end loop;
 foreach fn in array array['ai_grant_consent(jsonb)','ai_revoke_consent(uuid)','ai_cancel_job(uuid)','ai_job_status(uuid)'] loop
  execute 'revoke all on function public.'||fn||' from public,anon,authenticated,ai_executor';
  execute 'grant execute on function public.'||fn||' to authenticated';
  execute 'alter function public.'||fn||' owner to sync_backend';
 end loop;
 foreach fn in array array['ai_set_route(jsonb)','ai_set_budget(uuid,uuid,text,bigint)','ai_admit_job(uuid,jsonb)','ai_claim_job(integer)','ai_begin_dispatch(uuid,bigint)','ai_fail_before_dispatch(uuid,bigint)','ai_mark_unknown(uuid,bigint)','ai_settle_job(uuid,bigint,text,bigint,text,text)','ai_reap_jobs()'] loop
  execute 'revoke all on function public.'||fn||' from public,anon,authenticated,ai_executor';
  execute 'grant execute on function public.'||fn||' to ai_executor';
  execute 'alter function public.'||fn||' owner to sync_backend';
 end loop;
end $$;
commit;
