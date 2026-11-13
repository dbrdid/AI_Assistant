begin;
create role sync_backend nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
-- Runs only purge_expired_trash, without a JWT subject. Scheduling it is an ops decision (not deployed here).
create role sync_maintainer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant usage on schema auth to sync_backend;
grant execute on function auth.uid() to sync_backend;
create schema if not exists app;
create schema if not exists private;
revoke all on schema app, private from public, anon, authenticated;
create table app.workspaces(
  id uuid primary key,
  -- Shown to invitees (list_my_invitations), so the size is capped (C106).
  name text not null check(length(name) between 1 and 200),
  head bigint not null default 0 check(head>=0),
  access_epoch bigint not null default 1 check(access_epoch>=1),
  -- Off until the owner turns it on (F29 minimum).
  ai_enabled boolean not null default false,
  -- The member offered ownership; accept_ownership completes the transfer.
  pending_owner_id uuid references auth.users(id)
);
create table app.members(
  workspace_id uuid references app.workspaces(id),
  user_id uuid references auth.users(id),
  role text not null check(role in ('owner','editor','viewer')),
  primary key(workspace_id,user_id)
);
create unique index single_owner on app.members(workspace_id) where role='owner';
create table app.folders(
  workspace_id uuid references app.workspaces(id),
  id uuid not null,
  parent_id uuid,
  -- NULL inherits the parent chain and the workspace role (F01). acl_version makes owner edits compare-and-set (F02).
  acl jsonb,
  acl_version bigint not null default 1 check(acl_version>=1),
  primary key(workspace_id,id),
  foreign key(workspace_id,parent_id) references app.folders(workspace_id,id)
);
create table app.documents(
  workspace_id uuid references app.workspaces(id),
  id uuid not null,
  folder_id uuid,
  kind text not null check(kind in ('meeting','agenda','note')),
  -- A deleted document keeps its content in the trash; purge_expired_trash clears it after the window (F27).
  ciphertext jsonb,
  key_epoch integer not null check(key_epoch>0),
  revision bigint not null default 1 check(revision>=1),
  deleted boolean not null default false,
  -- Content gone (only purge_expired_trash clears it). documents_trash names this column, not ciphertext: a push
  -- rewrites ciphertext but not purged, so it stays a HOT update. STORED: PostgreSQL 18 defaults to VIRTUAL, which
  -- cannot be indexed. Next to deleted, alignment padding usually absorbs its byte.
  purged boolean generated always as (ciphertext is null) stored,
  acl jsonb,
  acl_version bigint not null default 1 check(acl_version>=1),
  deleted_at timestamptz,
  primary key(workspace_id,id),
  foreign key(workspace_id,folder_id) references app.folders(workspace_id,id),
  constraint documents_content_check check(ciphertext is not null or deleted),
  constraint documents_deleted_at_check check((deleted and deleted_at is not null) or (not deleted and deleted_at is null))
);
create table app.journal(
  workspace_id uuid references app.workspaces(id),
  seq bigint not null check(seq>=1),
  document_id uuid not null,
  snapshot jsonb not null,
  actor_id uuid references auth.users(id),
  primary key(workspace_id,seq),
  foreign key(workspace_id,document_id) references app.documents(workspace_id,id)
);
create table app.audit(
  id bigint generated always as identity primary key,
  workspace_id uuid not null references app.workspaces(id),
  -- NULL: written without a JWT subject (account deletion, purge), or the actor's account was deleted (F24).
  actor_id uuid references auth.users(id),
  action text not null,
  target_id uuid,
  head bigint not null check(head>=0),
  access_epoch bigint not null check(access_epoch>=1),
  recorded_at timestamptz not null default now()
);
create table app.receipts(
  workspace_id uuid references app.workspaces(id),
  actor_id uuid references auth.users(id),
  op_id uuid not null,
  request_hash bytea not null check(octet_length(request_hash)=32),
  receipt jsonb not null,
  primary key(workspace_id,actor_id,op_id)
);
create table app.key_envelopes(
  workspace_id uuid,
  document_id uuid,
  user_id uuid,
  key_epoch integer not null check(key_epoch>0),
  wrapped_key jsonb not null,
  primary key(workspace_id,document_id,user_id,key_epoch),
  foreign key(workspace_id,document_id) references app.documents(workspace_id,id),
  foreign key(workspace_id,user_id) references app.members(workspace_id,user_id) on delete cascade
);
create table app.attachments(
  workspace_id uuid,
  document_id uuid,
  id uuid not null,
  storage_path text not null,
  digest text not null,
  size_bytes bigint not null check(size_bytes>=0),
  primary key(workspace_id,id),
  foreign key(workspace_id,document_id) references app.documents(workspace_id,id)
);
create table app.user_signals(
  user_id uuid references auth.users(id),
  workspace_id uuid references app.workspaces(id),
  generation bigint not null default 1 check(generation>=1),
  primary key(user_id,workspace_id)
);
-- No foreign key to auth.users: an invitation must not reveal whether an account exists.
create table app.invitations(
  workspace_id uuid not null references app.workspaces(id),
  user_id uuid not null,
  role text not null check(role in ('editor','viewer')),
  invited_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,user_id)
);
-- Attachment objects to delete once Storage exists (no consumer yet). No foreign key: rows outlive their workspace.
create table app.storage_deletions(
  path text primary key,
  workspace_id uuid not null,
  queued_at timestamptz not null default clock_timestamp()
);
-- Account deletion and purge (F24, F61). By user: forget_user, the foreign key checks of the auth.users delete, and the
-- list RPCs. By workspace, document or parent: private.delete_workspace, the foreign key checks its deletes run, and
-- purge's per-document statements. documents_trash holds only trash whose content is still kept: purge's search.
create index members_user on app.members(user_id);
create index invitations_user on app.invitations(user_id);
create index receipts_actor on app.receipts(actor_id);
create index journal_actor on app.journal(actor_id) where actor_id is not null;
create index journal_document on app.journal(workspace_id,document_id);
create index audit_actor on app.audit(actor_id) where actor_id is not null;
create index audit_target on app.audit(target_id) where target_id is not null;
create index workspaces_pending_owner on app.workspaces(pending_owner_id) where pending_owner_id is not null;
create index documents_folder on app.documents(workspace_id,folder_id);
create index folders_parent on app.folders(workspace_id,parent_id);
create index audit_workspace on app.audit(workspace_id);
create index user_signals_workspace on app.user_signals(workspace_id);
create index attachments_document on app.attachments(workspace_id,document_id);
create index documents_trash on app.documents(deleted_at) where deleted and not purged;
do $$ declare t text; begin foreach t in array array['workspaces','members','folders','documents','journal','receipts','key_envelopes','attachments','user_signals','audit','invitations','storage_deletions'] loop execute format('alter table app.%I enable row level security',t); end loop; end $$;
revoke all on all tables in schema app from public, anon, authenticated;
grant usage on schema app to authenticated;
grant select on app.user_signals to authenticated;
create policy own_signal on app.user_signals for select to authenticated using(user_id=auth.uid());
-- Only this table is eligible for Realtime. Publication setup is intentionally not deployed here.
create function private.lock_workspace(w uuid)
returns app.workspaces
language plpgsql
set search_path=pg_catalog
as $$
  declare x app.workspaces;
 
begin
  -- Subject first, so a call without one cannot tell existing workspaces from missing ones.
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode='PT401';
 
  end if;
  select * into x from app.workspaces where id=w for update;
  if not found then
    raise exception 'forbidden' using errcode='PT403';
 
  end if;
  return x;
 
end
$$;
create function private.role_rank(w uuid)
returns integer
language sql stable
set search_path=pg_catalog
as $$
  select coalesce((select case role when 'owner' then
    3 when 'editor' then
    2
  else
    1 end from app.members where workspace_id=w and user_id=auth.uid()),0) $$;
-- Syntax only; require_acl_members checks the keys against the members. Keys are rewritten to the canonical uuid
-- text, so equal ACLs compare equal; two spellings of one uuid are rejected rather than resolved by key order (F15).
create function private.normalize_acl(a jsonb)
returns jsonb
language plpgsql
set search_path=pg_catalog
as $$
declare
  normalized jsonb;
  entries bigint;
  distinct_keys bigint;
begin
  if a is null then
    return null;
  end if;
  if jsonb_typeof(a)<>'object' then
    raise exception 'invalid_acl' using errcode='PT400';
  end if;
  if exists(select 1 from jsonb_each(a) e where e.value not in ('"viewer"'::jsonb,'"editor"'::jsonb)) then
    raise exception 'invalid_acl' using errcode='PT400';
  end if;
  -- Keys keep the uuid input syntax; only its syntax error is converted.
  begin
    select count(*),count(distinct x.k),jsonb_object_agg(x.k,x.v) into entries,distinct_keys,normalized
      from (select e.key::uuid::text as k,e.value as v from jsonb_each(a) e) x;
  exception when invalid_text_representation then
    raise exception 'invalid_acl' using errcode='PT400';
  end;
  if entries<>distinct_keys then
    raise exception 'invalid_acl' using errcode='PT400';
  end if;
  -- jsonb_object_agg over no rows is NULL, which would mean inherit; {} denies everyone.
  return coalesce(normalized,'{}'::jsonb);
end
$$;
-- Keys must name current members, so removing a member can strip every grant it holds (F12).
create function private.require_acl_members(w uuid,a jsonb)
returns void
language plpgsql
set search_path=pg_catalog
as $$
begin
  if exists(select 1 from jsonb_object_keys(coalesce(a,'{}'::jsonb)) as acl_key
            where not exists(select 1 from app.members m where m.workspace_id=w and m.user_id=acl_key::uuid)) then
    raise exception 'member_not_found' using errcode='PT404';
  end if;
end
$$;
create function private.acl_rank(a jsonb)
returns integer
language sql stable
set search_path=pg_catalog
as $$
  select case when a is null then
    2 when a->>auth.uid()::text='editor' then
    2 when a->>auth.uid()::text='viewer' then
    1
  else
    0
end
$$;
create function private.folder_rank(w uuid,f uuid)
returns integer
language plpgsql stable
set search_path=pg_catalog
as $$
  declare r integer:=least(private.role_rank(w),2);
  x app.folders;
  seen uuid[]:='{}';
 
begin
  while f is not null loop if f=any(seen) or cardinality(seen)>=128 then
    return 0;
 
  end if;
  seen:=array_append(seen,f);
  select * into x from app.folders where workspace_id=w and id=f;
  if not found then
    return 0;
 
  end if;
  r:=least(r,private.acl_rank(x.acl));
  f:=x.parent_id;
 
  end loop;
  return r;
 
end
$$;
create function private.document_rank(w uuid,d uuid)
returns integer
language plpgsql stable
set search_path=pg_catalog
as $$
  declare x app.documents;
  r integer;
 
begin
  select * into x from app.documents where workspace_id=w and id=d;
  if not found then
    return 0;
 
  end if;
  r:=private.folder_rank(w,x.folder_id);

  return least(r,private.acl_rank(x.acl));
 
end
$$;
create function private.require_owner(w uuid)
returns void
language plpgsql
set search_path=pg_catalog
as $$
 
begin
  if private.role_rank(w)<>3 then
    raise exception 'forbidden' using errcode='PT403';
 
  end if;
 
end
$$;
create function private.audit(w uuid,a text,t uuid)
returns void
language sql
set search_path=pg_catalog
as $$
  insert into app.audit(workspace_id,actor_id,action,target_id,head,access_epoch) select w,auth.uid(),a,t,head,access_epoch from app.workspaces where id=w $$;
-- For code without a JWT subject (account deletion, purge): the actor is recorded as NULL.
create function private.audit_anonymous(w uuid,a text,t uuid default null)
returns void
language sql
set search_path=pg_catalog
as $$
  insert into app.audit(workspace_id,actor_id,action,target_id,head,access_epoch) select w,null,a,t,head,access_epoch from app.workspaces where id=w $$;
-- Signals every member, plus extra (a removed member, an invitee or a cancelled offeree).
create function private.signal(w uuid,extra uuid default null)
returns void
language plpgsql
set search_path=pg_catalog
as $$
begin
  insert into app.user_signals(user_id,workspace_id) select user_id,w from app.members where workspace_id=w on conflict(user_id,workspace_id) do update set generation=app.user_signals.generation+1;
  if extra is not null and not exists(select 1 from app.members where workspace_id=w and user_id=extra) then
    -- Invitations accept any uuid, so extra may have no account: then nobody is signalled and the answer stays the same.
    begin
      insert into app.user_signals(user_id,workspace_id) values(extra,w) on conflict(user_id,workspace_id) do update set generation=app.user_signals.generation+1;
    exception when foreign_key_violation then
      null;
    end;
  end if;
end
$$;
create function private.cipher_ok(c jsonb,k integer,expected integer,w uuid,d uuid)
returns void
language plpgsql
set search_path=pg_catalog
as $$
declare
  nonce_bytes bytea;
  ciphertext_bytes bytea;
begin
  if k is null or k<>expected then
    raise exception 'invalid_key_epoch' using errcode='PT409';
  end if;
  -- Bound the complete envelope and encoded field before regex/decode allocations.
  if c is null or jsonb_typeof(c)<>'object'
     or octet_length(c::text)>1049600
     or length(c->>'ciphertext')>1048576 then
    raise exception 'invalid_ciphertext' using errcode='PT400';
  end if;
  if c->>'algorithm' is distinct from 'A256GCM'
     or jsonb_typeof(c->'nonce') is distinct from 'string'
     or jsonb_typeof(c->'ciphertext') is distinct from 'string'
     or jsonb_typeof(c->'aad') is distinct from 'string'
     or coalesce(c->>'nonce','') !~ '^[A-Za-z0-9+/]{16}$'
     or coalesce(c->>'ciphertext','') !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'invalid_ciphertext' using errcode='PT400';
  end if;
  if (select count(*) from jsonb_object_keys(c))<>4
     or c->>'aad' is distinct from
        '["local-first-v1","'||w::text||'","'||d::text||'","content",'||k::text||']' then
    raise exception 'invalid_ciphertext' using errcode='PT400';
  end if;
  begin
    nonce_bytes:=decode(c->>'nonce','base64');
    ciphertext_bytes:=decode(c->>'ciphertext','base64');
  exception when invalid_parameter_value or invalid_text_representation then
    raise exception 'invalid_ciphertext' using errcode='PT400';
  end;
  if octet_length(nonce_bytes)<>12 or octet_length(ciphertext_bytes)<16
     or replace(encode(nonce_bytes,'base64'),E'\n','')<>c->>'nonce'
     or replace(encode(ciphertext_bytes,'base64'),E'\n','')<>c->>'ciphertext' then
    raise exception 'invalid_ciphertext' using errcode='PT400';
  end if;
end
$$;
create function private.snapshot(d app.documents)
returns jsonb
language sql immutable
set search_path=pg_catalog
as $$
  select jsonb_build_object('id',d.id,'workspace_id',d.workspace_id,'folder_id',d.folder_id,'kind',d.kind,'ciphertext',case when d.deleted then
    null
  else
    d.ciphertext end,'key_epoch',d.key_epoch,'revision',d.revision::text,'deleted',d.deleted) $$;
-- Byte budget of one read response: elements are included while the sum of their text sizes stays within it.
-- The first element is always included, so every call makes progress.
create function private.page_budget()
returns integer
language sql immutable
set search_path=pg_catalog
as $$
  select 4194304 $$;
-- Trash window (F27). Hours, not days: day arithmetic follows the session time zone and moves across DST changes.
create function private.trash_retention()
returns interval
language sql immutable
set search_path=pg_catalog
as $$
  select interval '720 hours' $$;
-- Timestamps in JSON: UTC with microseconds, whatever the session time zone.
create function private.utc_text(t timestamptz)
returns text
language sql stable
set search_path=pg_catalog
as $$
  select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') $$;
create function private.append_change(w uuid,d uuid)
returns bigint
language plpgsql
set search_path=pg_catalog
as $$
  declare h bigint;
 
begin
  update app.workspaces set head=head+1 where id=w returning head into h;
  insert into app.journal select w,h,d,private.snapshot(x),auth.uid() from app.documents x where workspace_id=w and id=d;
  perform private.audit(w,'document_revision',d);
  perform private.signal(w);
  return h;
 
end
$$;
-- The caller holds the workspace lock. Removes a non-owner member together with every ACL key naming it, so a later
-- invitation starts from inherited access only (F12). Returns false and writes nothing when u is no such member.
create function private.remove_member(w uuid,u uuid,a text,anonymous boolean)
returns boolean
language plpgsql
set search_path=pg_catalog
as $$
begin
  delete from app.members where workspace_id=w and user_id=u and role<>'owner';
  if not found then
    return false;
  end if;
  -- NULL (inherit) ACLs have no keys and stay as they are. The version bump makes a stale owner copy that still
  -- names u fail with acl_version_mismatch.
  update app.folders set acl=acl-u::text,acl_version=acl_version+1 where workspace_id=w and acl ? u::text;
  update app.documents set acl=acl-u::text,acl_version=acl_version+1 where workspace_id=w and acl ? u::text;
  update app.workspaces set access_epoch=access_epoch+1,pending_owner_id=nullif(pending_owner_id,u) where id=w;
  if anonymous then
    -- Account deletion: no subject to record, and no signal for the user being deleted.
    perform private.audit_anonymous(w,a);
    perform private.signal(w);
  else
    perform private.audit(w,a,u);
    -- The removed user is signalled too.
    perform private.signal(w,u);
  end if;
  return true;
end
$$;
-- Deletes a workspace whose only member is being deleted. The caller holds the workspace lock and has no JWT
-- subject. Statements follow the foreign keys; AI rows go with their documents and budgets with the workspace.
create function private.delete_workspace(w uuid)
returns void
language plpgsql
set search_path=pg_catalog
as $$
begin
  insert into app.storage_deletions(path,workspace_id) select storage_path,w from app.attachments where workspace_id=w on conflict(path) do nothing;
  delete from app.journal where workspace_id=w;
  delete from app.key_envelopes where workspace_id=w;
  delete from app.attachments where workspace_id=w;
  delete from app.documents where workspace_id=w;
  -- One statement: the parent key between folders is checked once all of them are gone.
  delete from app.folders where workspace_id=w;
  delete from app.members where workspace_id=w;
  delete from app.invitations where workspace_id=w;
  delete from app.receipts where workspace_id=w;
  delete from app.user_signals where workspace_id=w;
  delete from app.audit where workspace_id=w;
  delete from app.workspaces where id=w;
end
$$;
-- The account-deletion hook the AI migration replaces (CREATE OR REPLACE keeps the owner and the revoked EXECUTE): the
-- cleanup of u's AI rows, after the sync cleanup.
create function private.forget_user_hook(u uuid)
returns void
language plpgsql
set search_path=pg_catalog
as $$
begin
  return;
end
$$;
-- Account deletion (F24): the auth service hard-deletes the auth.users row and this BEFORE trigger cleans up in the
-- same transaction. Without a JWT subject it locks directly, in id order and never through lock_workspace, only the
-- workspaces where u is a member, whose membership and access change. Elsewhere it takes no workspace lock and writes
-- only rows that name u (invitations, signal rows, receipts, journal and audit actor, AI consents, jobs and budgets) and
-- the existing signal rows of the members of workspaces that invited u, so no statement may key-share another
-- workspace row: none updates a row twice or inserts a row there. A call writing one of those rows at the same moment
-- delays it, and some form a cycle that lock_timeout ends with 55P03 (the caller retries): an executor call that
-- updates u's job row twice (private.ai_release, then its final UPDATE) re-checks the actor foreign key and waits for
-- this auth.users row; a purge in a workspace u left holds u's journal rows until it commits; u's own
-- respond_invitation, or AI cancel or revoke; the SEC-2 bump below meeting another RPC's signal statement; two
-- concurrent deletions whose rows meet. They meet where memberships and invitations cross (also for two invitees of the
-- same two workspaces, if their bumps lock the members' signal rows in opposite orders), and where one deletes a
-- sole-member workspace in which the other still has rows (journal rows, receipts, a signal row, an invitation, audit
-- or AI rows, typically after writing there and leaving): private.delete_workspace takes journal, AI rows (with the
-- documents), invitations, receipts, user_signals, then audit; this function invitations, user_signals, receipts,
-- journal, audit, then AI rows (in the hook). Leaving a workspace first spares the wait for its lock and a crossing
-- through that membership, not the others. Foreign keys stay NO ACTION, so a reference left behind fails the delete.
create function private.forget_user()
returns trigger
language plpgsql security definer
set search_path=pg_catalog
set lock_timeout='250ms'
as $$
declare
  u uuid:=old.id;
  ws uuid[];
  w uuid;
begin
  ws:=array(select workspace_id from app.members where user_id=u);
  perform 1 from app.workspaces where id=any(ws) order by id for update;
  -- Classified after the lock in new statements: memberships may have changed while waiting.
  for w in select m.workspace_id from app.members m where m.user_id=u and m.role='owner' and m.workspace_id=any(ws) order by m.workspace_id loop
    if exists(select 1 from app.members where workspace_id=w and user_id<>u) then
      raise exception 'owner_must_transfer' using errcode='PT409';
    end if;
    perform private.delete_workspace(w);
  end loop;
  for w in select m.workspace_id from app.members m where m.user_id=u and m.workspace_id=any(ws) order by m.workspace_id loop
    perform private.remove_member(w,u,'account_deleted',true);
  end loop;
  -- What belongs only to u goes; shared history stays, with u unlinked. A pending invitation of u ends as after a
  -- decline: it goes and the members of its workspace are signalled (u, no member there, is not). Existing signal rows
  -- only and no audit row: an insert's foreign key check would key-share that workspace. The invitation row comes
  -- before the signal rows, the order invite_member uses (also to revoke), so a concurrent invite or revoke never waits
  -- in a cycle with this. An invite committed after this statement leaves an invitation for the deleted id, as an
  -- invitation of an id with no account does.
  with gone as (delete from app.invitations where user_id=u returning workspace_id)
    update app.user_signals s set generation=s.generation+1 from gone g, app.members m
      where m.workspace_id=g.workspace_id and s.workspace_id=g.workspace_id and s.user_id=m.user_id;
  delete from app.user_signals where user_id=u;
  delete from app.receipts where actor_id=u;
  update app.workspaces set pending_owner_id=null where pending_owner_id=u;
  update app.journal set actor_id=null where actor_id=u;
  -- One statement: a second UPDATE of a row this transaction already wrote re-runs the audit->workspaces foreign key
  -- check (FOR KEY SHARE on the workspace row).
  update app.audit set actor_id=nullif(actor_id,u),target_id=nullif(target_id,u) where actor_id=u or target_id=u;
  perform private.forget_user_hook(u);
  return old;
end
$$;
create function public.create_workspace(p_workspace_id uuid,p_name text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
 
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode='PT401';
 
  end if;
  if p_workspace_id is null or p_name is null or length(p_name) not between 1 and 200 then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  -- No row exists to lock yet, so the primary key decides between concurrent creators.
  begin
    insert into app.workspaces(id,name) values(p_workspace_id,p_name);
  exception when unique_violation then
    raise exception 'id_conflict' using errcode='PT409';
  end;
  -- The workspace was just inserted, so only the subject's auth.users key can fail.
  begin
    insert into app.members values(p_workspace_id,auth.uid(),'owner');
  exception when foreign_key_violation then
    raise exception 'unauthenticated' using errcode='PT401';
  end;
  perform private.audit(p_workspace_id,'create_workspace',p_workspace_id);
  perform private.signal(p_workspace_id);
  return jsonb_build_object('workspace_id',p_workspace_id,'head','0','access_epoch','1');
 
end
$$;
create function public.set_member(p_workspace_id uuid,p_user_id uuid,p_role text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare x app.workspaces;
  member_role text;
 
begin
  x:=private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_user_id is null then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if p_user_id=auth.uid() or p_role='owner' then
    raise exception 'owner_change_not_supported' using errcode='PT400';
 
  end if;
  -- A null role removes the member.
  if p_role is not null and p_role not in ('viewer','editor') then
    raise exception 'invalid_role' using errcode='PT400';
  end if;
  -- A call that changes nothing writes nothing: no epoch bump, audit row or signal.
  if p_role is null then
    if not private.remove_member(p_workspace_id,p_user_id,'set_member',false) then
      return jsonb_build_object('access_epoch',x.access_epoch::text,'changed',false);
    end if;
 
  else
    select role into member_role from app.members where workspace_id=p_workspace_id and user_id=p_user_id;
    -- Members join only through invitations (invite_member, respond_invitation).
    if not found then
      raise exception 'member_not_found' using errcode='PT404';
    end if;
    if member_role=p_role then
      return jsonb_build_object('access_epoch',x.access_epoch::text,'changed',false);
    end if;
    update app.members set role=p_role where workspace_id=p_workspace_id and user_id=p_user_id;
    update app.workspaces set access_epoch=access_epoch+1,pending_owner_id=nullif(pending_owner_id,p_user_id) where id=p_workspace_id;
    -- A role change withdraws a pending ownership offer to that member: the owner's latest decision wins.
    if x.pending_owner_id=p_user_id then
      perform private.audit(p_workspace_id,'offer_ownership',null);
    end if;
    perform private.audit(p_workspace_id,'set_member',p_user_id);
    perform private.signal(p_workspace_id,p_user_id);
 
  end if;
  select * into x from app.workspaces where id=p_workspace_id;
  return jsonb_build_object('access_epoch',x.access_epoch::text,'changed',true);
 
end
$$;
-- Members join only through an invitation they accept (F13). Any uuid can be invited, so the answer does not tell
-- whether an account exists. Invitations do not change access, so the epoch stays.
create function public.invite_member(p_workspace_id uuid,p_user_id uuid,p_role text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  pending text;
begin
  perform private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_user_id is null then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if exists(select 1 from app.members where workspace_id=p_workspace_id and user_id=p_user_id) then
    raise exception 'already_member' using errcode='PT409';
  end if;
  select role into pending from app.invitations where workspace_id=p_workspace_id and user_id=p_user_id;
  -- A null role revokes the pending invitation.
  if p_role is null then
    if pending is null then
      return jsonb_build_object('changed',false);
    end if;
    delete from app.invitations where workspace_id=p_workspace_id and user_id=p_user_id;
    perform private.audit(p_workspace_id,'revoke_invitation',p_user_id);
    perform private.signal(p_workspace_id,p_user_id);
    return jsonb_build_object('changed',true);
  end if;
  -- Ownership moves only through offer_ownership.
  if p_role not in ('editor','viewer') then
    raise exception 'invalid_role' using errcode='PT400';
  end if;
  if pending=p_role then
    return jsonb_build_object('changed',false);
  end if;
  insert into app.invitations(workspace_id,user_id,role) values(p_workspace_id,p_user_id,p_role)
    on conflict(workspace_id,user_id) do update set role=excluded.role,invited_at=excluded.invited_at;
  perform private.audit(p_workspace_id,'invite_member',p_user_id);
  perform private.signal(p_workspace_id,p_user_id);
  return jsonb_build_object('changed',true);
end
$$;
-- The invitee's answer. Anyone else gets forbidden whether or not the workspace exists; so does a retried decline,
-- because the invitation is gone and the caller is no member.
create function public.respond_invitation(p_workspace_id uuid,p_accept boolean)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  x app.workspaces;
  invited text;
  member_role text;
begin
  x:=private.lock_workspace(p_workspace_id);
  select role into invited from app.invitations where workspace_id=p_workspace_id and user_id=auth.uid();
  select role into member_role from app.members where workspace_id=p_workspace_id and user_id=auth.uid();
  if invited is null and member_role is null then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  if p_accept is null then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  -- Already a member, for example after a lost accept response: nothing changes.
  if invited is null then
    return jsonb_build_object('changed',false,'role',member_role,'access_epoch',x.access_epoch::text);
  end if;
  delete from app.invitations where workspace_id=p_workspace_id and user_id=auth.uid();
  -- The invitation can name a deleted account whose token is still valid; only the subject's auth.users key can fail.
  begin
    if p_accept then
      insert into app.members values(p_workspace_id,auth.uid(),invited);
      update app.workspaces set access_epoch=access_epoch+1 where id=p_workspace_id returning * into x;
      perform private.audit(p_workspace_id,'accept_invitation',auth.uid());
    else
      perform private.audit(p_workspace_id,'decline_invitation',auth.uid());
    end if;
  exception when foreign_key_violation then
    raise exception 'unauthenticated' using errcode='PT401';
  end;
  if p_accept then
    perform private.signal(p_workspace_id);
    return jsonb_build_object('changed',true,'role',invited,'access_epoch',x.access_epoch::text);
  end if;
  perform private.signal(p_workspace_id,auth.uid());
  return jsonb_build_object('changed',true,'role',null,'access_epoch',x.access_epoch::text);
end
$$;
-- The owner hands the workspace over first (offer_ownership, accept_ownership). A retry gets forbidden.
create function public.leave_workspace(p_workspace_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  r integer;
begin
  perform private.lock_workspace(p_workspace_id);
  r:=private.role_rank(p_workspace_id);
  if r<1 then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  if r=3 then
    raise exception 'owner_must_transfer' using errcode='PT409';
  end if;
  perform private.remove_member(p_workspace_id,auth.uid(),'leave_workspace',false);
  return jsonb_build_object('changed',true,'access_epoch',(select access_epoch::text from app.workspaces where id=p_workspace_id));
end
$$;
-- A null user cancels the pending offer. No epoch bump: access changes only when the offer is accepted.
create function public.offer_ownership(p_workspace_id uuid,p_user_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  x app.workspaces;
begin
  x:=private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_user_id is null then
    if x.pending_owner_id is null then
      return jsonb_build_object('changed',false,'pending_owner_id',null);
    end if;
    update app.workspaces set pending_owner_id=null where id=p_workspace_id;
    perform private.audit(p_workspace_id,'offer_ownership',null);
    perform private.signal(p_workspace_id,x.pending_owner_id);
    return jsonb_build_object('changed',true,'pending_owner_id',null);
  end if;
  if p_user_id=auth.uid() then
    raise exception 'owner_change_not_supported' using errcode='PT400';
  end if;
  if not exists(select 1 from app.members where workspace_id=p_workspace_id and user_id=p_user_id) then
    raise exception 'member_not_found' using errcode='PT404';
  end if;
  if x.pending_owner_id=p_user_id then
    return jsonb_build_object('changed',false,'pending_owner_id',p_user_id);
  end if;
  update app.workspaces set pending_owner_id=p_user_id where id=p_workspace_id;
  perform private.audit(p_workspace_id,'offer_ownership',p_user_id);
  perform private.signal(p_workspace_id,p_user_id);
  return jsonb_build_object('changed',true,'pending_owner_id',p_user_id);
end
$$;
create function public.accept_ownership(p_workspace_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  x app.workspaces;
  r integer;
begin
  x:=private.lock_workspace(p_workspace_id);
  r:=private.role_rank(p_workspace_id);
  -- Already the owner, for example after a lost response: nothing changes.
  if r=3 then
    return jsonb_build_object('changed',false,'access_epoch',x.access_epoch::text);
  end if;
  if r<1 or x.pending_owner_id is distinct from auth.uid() then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  -- The old owner first, because single_owner allows one owner row; it stays as an editor.
  update app.members set role='editor' where workspace_id=p_workspace_id and role='owner';
  update app.members set role='owner' where workspace_id=p_workspace_id and user_id=auth.uid();
  update app.workspaces set pending_owner_id=null,access_epoch=access_epoch+1 where id=p_workspace_id returning * into x;
  perform private.audit(p_workspace_id,'transfer_ownership',auth.uid());
  perform private.signal(p_workspace_id);
  return jsonb_build_object('changed',true,'access_epoch',x.access_epoch::text);
end
$$;
-- The caller's workspaces by id. One statement without workspace locks (I3): every field comes from one snapshot.
create function public.list_my_workspaces(p_after_id uuid default null,p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode='PT401';
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  select jsonb_build_object(
    'workspaces',coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'member_count',p.member_count,
      'ai_enabled',p.ai_enabled,'ownership_offered',p.offered) order by p.id) filter(where p.n<=p_limit),'[]'::jsonb),
    'next_id',case when count(*)>p_limit then (array_agg(p.id order by p.id))[p_limit] end)
  into result
  from (select x.id,x.name,m.role,x.ai_enabled,coalesce(x.pending_owner_id=auth.uid(),false) as offered,
          (select count(*)::integer from app.members c where c.workspace_id=x.id) as member_count,row_number() over(order by x.id) as n
        from app.members m join app.workspaces x on x.id=m.workspace_id
        where m.user_id=auth.uid() and (p_after_id is null or x.id>p_after_id) order by x.id limit p_limit+1) p;
  return result;
end
$$;
create function public.list_members(p_workspace_id uuid,p_after_id uuid default null,p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  x app.workspaces;
  ids uuid[];
begin
  x:=private.lock_workspace(p_workspace_id);
  if private.role_rank(p_workspace_id)<1 then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  -- Keyset page as in list_accessible_documents: one statement per case keeps the predicate index-usable under a
  -- generic plan; the extra id only shows that more exist. The lock keeps the second read consistent with the first.
  if p_after_id is null then
    ids:=array(select m.user_id from app.members m where m.workspace_id=p_workspace_id order by m.user_id limit p_limit+1);
  else
    ids:=array(select m.user_id from app.members m where m.workspace_id=p_workspace_id and m.user_id>p_after_id order by m.user_id limit p_limit+1);
  end if;
  return jsonb_build_object(
    'members',(select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'role',m.role) order by e.n),'[]'::jsonb)
      from unnest(ids) with ordinality as e(id,n) join app.members m on m.workspace_id=p_workspace_id and m.user_id=e.id where e.n<=p_limit),
    'next_id',case when cardinality(ids)>p_limit then ids[p_limit] end,'access_epoch',x.access_epoch::text);
end
$$;
create function public.list_invitations(p_workspace_id uuid,p_after_id uuid default null,p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  x app.workspaces;
  ids uuid[];
begin
  x:=private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  -- Keyset page as in list_members.
  if p_after_id is null then
    ids:=array(select i.user_id from app.invitations i where i.workspace_id=p_workspace_id order by i.user_id limit p_limit+1);
  else
    ids:=array(select i.user_id from app.invitations i where i.workspace_id=p_workspace_id and i.user_id>p_after_id order by i.user_id limit p_limit+1);
  end if;
  return jsonb_build_object(
    'invitations',(select coalesce(jsonb_agg(jsonb_build_object('user_id',i.user_id,'role',i.role,'invited_at',private.utc_text(i.invited_at)) order by e.n),'[]'::jsonb)
      from unnest(ids) with ordinality as e(id,n) join app.invitations i on i.workspace_id=p_workspace_id and i.user_id=e.id where e.n<=p_limit),
    'next_id',case when cardinality(ids)>p_limit then ids[p_limit] end,'pending_owner_id',x.pending_owner_id);
end
$$;
-- The caller's pending invitations by workspace id. One statement without workspace locks (I3).
create function public.list_my_invitations(p_after_id uuid default null,p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode='PT401';
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  select jsonb_build_object(
    'invitations',coalesce(jsonb_agg(jsonb_build_object('workspace_id',p.workspace_id,'name',p.name,'role',p.role,
      'invited_at',private.utc_text(p.invited_at)) order by p.workspace_id) filter(where p.n<=p_limit),'[]'::jsonb),
    'next_id',case when count(*)>p_limit then (array_agg(p.workspace_id order by p.workspace_id))[p_limit] end)
  into result
  from (select i.workspace_id,x.name,i.role,i.invited_at,row_number() over(order by i.workspace_id) as n
        from app.invitations i join app.workspaces x on x.id=i.workspace_id
        where i.user_id=auth.uid() and (p_after_id is null or i.workspace_id>p_after_id) order by i.workspace_id limit p_limit+1) p;
  return result;
end
$$;
create function public.create_folder(p_workspace_id uuid,p_folder_id uuid,p_parent_id uuid default null,p_acl jsonb default null)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare normalized jsonb;
 
begin
  perform private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if private.folder_rank(p_workspace_id,p_parent_id)<2 then
    raise exception 'forbidden' using errcode='PT403';
 
  end if;
  if p_folder_id is null then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  normalized:=private.normalize_acl(p_acl);
  perform private.require_acl_members(p_workspace_id,normalized);
  -- The workspace row lock serializes creators, so this check cannot race.
  if exists(select 1 from app.folders where workspace_id=p_workspace_id and id=p_folder_id) then
    raise exception 'id_conflict' using errcode='PT409';
  end if;
  -- NULL inherits the parent chain and role (F01); an ACL makes the folder restricted from the start.
  insert into app.folders(workspace_id,id,parent_id,acl) values(p_workspace_id,p_folder_id,p_parent_id,normalized);
  perform private.audit(p_workspace_id,'create_folder',p_folder_id);
  -- A new folder holds nothing yet, so the epoch stays; the signal tells members to refetch their folder list.
  perform private.signal(p_workspace_id);
  return jsonb_build_object('id',p_folder_id,'acl_version','1');
 
end
$$;
-- Folders the caller can see (every ancestor visible), by id. Not versioned by access_epoch: clients refetch on a
-- signal or when a document names an unknown folder.
create function public.list_folders(p_workspace_id uuid,p_after_id uuid default null,p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  ids uuid[];
begin
  perform private.lock_workspace(p_workspace_id);
  if private.role_rank(p_workspace_id)<1 then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  -- Keyset page as in list_members; access is evaluated row by row (F22).
  if p_after_id is null then
    ids:=array(select f.id from app.folders f where f.workspace_id=p_workspace_id and private.folder_rank(p_workspace_id,f.id)>0 order by f.id limit p_limit+1);
  else
    ids:=array(select f.id from app.folders f where f.workspace_id=p_workspace_id and f.id>p_after_id and private.folder_rank(p_workspace_id,f.id)>0 order by f.id limit p_limit+1);
  end if;
  return jsonb_build_object(
    'folders',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'parent_id',f.parent_id,'can_edit',private.folder_rank(p_workspace_id,f.id)>=2) order by e.n),'[]'::jsonb)
      from unnest(ids) with ordinality as e(id,n) join app.folders f on f.workspace_id=p_workspace_id and f.id=e.id where e.n<=p_limit),
    'next_id',case when cardinality(ids)>p_limit then ids[p_limit] end);
end
$$;
-- Owner edits are compare-and-set on acl_version (F02). An ACL equal to the stored one writes nothing whatever the
-- expected version, so a retry after a lost response is answered unchanged.
create function public.set_folder_acl(p_workspace_id uuid,p_folder_id uuid,p_acl jsonb,p_expected_version text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare x app.workspaces;
  normalized jsonb;
  f app.folders;
 
begin
  x:=private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  -- A bigint has at most 19 digits, and 19 digits can still exceed its range (separate IF: the cast needs the digits).
  if p_expected_version is null or p_expected_version !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if p_expected_version::numeric>9223372036854775807 then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  normalized:=private.normalize_acl(p_acl);
  select * into f from app.folders where workspace_id=p_workspace_id and id=p_folder_id;
  if not found then
    raise exception 'folder_not_found' using errcode='PT404';
 
  end if;
  -- jsonb equality ignores key order, and null (inherit) equals null.
  if f.acl is not distinct from normalized then
    return jsonb_build_object('access_epoch',x.access_epoch::text,'changed',false,'acl_version',f.acl_version::text);
  end if;
  if f.acl_version<>p_expected_version::bigint then
    raise exception 'acl_version_mismatch' using errcode='PT409';
  end if;
  perform private.require_acl_members(p_workspace_id,normalized);
  update app.folders set acl=normalized,acl_version=acl_version+1 where workspace_id=p_workspace_id and id=p_folder_id returning * into f;
  update app.workspaces set access_epoch=access_epoch+1 where id=p_workspace_id returning * into x;
  perform private.audit(p_workspace_id,'set_folder_acl',p_folder_id);
  perform private.signal(p_workspace_id);
  return jsonb_build_object('access_epoch',x.access_epoch::text,'changed',true,'acl_version',f.acl_version::text);
 
end
$$;
-- The stored ACL and version for an owner's edit (set_folder_acl, set_document_acl).
create function public.get_acl(p_workspace_id uuid,p_kind text,p_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  result jsonb;
begin
  perform private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_kind is null or p_kind not in ('folder','document') then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if p_kind='folder' then
    select jsonb_build_object('id',f.id,'acl',f.acl,'acl_version',f.acl_version::text) into result from app.folders f where f.workspace_id=p_workspace_id and f.id=p_id;
    if not found then
      raise exception 'folder_not_found' using errcode='PT404';
    end if;
  else
    select jsonb_build_object('id',d.id,'acl',d.acl,'acl_version',d.acl_version::text) into result from app.documents d where d.workspace_id=p_workspace_id and d.id=p_id;
    if not found then
      raise exception 'document_not_found' using errcode='PT404';
    end if;
  end if;
  return result;
end
$$;
-- Every folder or document with its ACL, including rows whose ACL leaves the owner out (the owner manages them).
-- Metadata only, never content.
create function public.list_acls(p_workspace_id uuid,p_kind text,p_after_id uuid default null,p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  ids uuid[];
  entries jsonb;
begin
  perform private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_kind is null or p_kind not in ('folder','document') then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  -- Keyset page as in list_members.
  if p_kind='folder' then
    if p_after_id is null then
      ids:=array(select f.id from app.folders f where f.workspace_id=p_workspace_id order by f.id limit p_limit+1);
    else
      ids:=array(select f.id from app.folders f where f.workspace_id=p_workspace_id and f.id>p_after_id order by f.id limit p_limit+1);
    end if;
    entries:=(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'parent_id',f.parent_id,'acl',f.acl,'acl_version',f.acl_version::text) order by e.n),'[]'::jsonb)
      from unnest(ids) with ordinality as e(id,n) join app.folders f on f.workspace_id=p_workspace_id and f.id=e.id where e.n<=p_limit);
  else
    if p_after_id is null then
      ids:=array(select d.id from app.documents d where d.workspace_id=p_workspace_id order by d.id limit p_limit+1);
    else
      ids:=array(select d.id from app.documents d where d.workspace_id=p_workspace_id and d.id>p_after_id order by d.id limit p_limit+1);
    end if;
    entries:=(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'folder_id',d.folder_id,'deleted',d.deleted,'deleted_at',private.utc_text(d.deleted_at),
        'purged',d.deleted and d.ciphertext is null,'acl',d.acl,'acl_version',d.acl_version::text) order by e.n),'[]'::jsonb)
      from unnest(ids) with ordinality as e(id,n) join app.documents d on d.workspace_id=p_workspace_id and d.id=e.id where e.n<=p_limit);
  end if;
  return jsonb_build_object('entries',entries,'next_id',case when cardinality(ids)>p_limit then ids[p_limit] end);
end
$$;
create function public.create_document(p_workspace_id uuid,p_document_id uuid,p_folder_id uuid,p_kind text,p_ciphertext jsonb,p_key_epoch integer default 1,p_op_id uuid default null)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare x app.workspaces;
  h bigint;
  hash bytea;
  old app.receipts;
  result jsonb;
  -- Without p_op_id the document id is the op id, as before; either way it shares the push op_id namespace.
  op uuid:=coalesce(p_op_id,p_document_id);
 
begin
  x:=private.lock_workspace(p_workspace_id);
  if private.folder_rank(p_workspace_id,p_folder_id)<2 then
    raise exception 'forbidden' using errcode='PT403';
 
  end if;
  hash:=sha256(convert_to(jsonb_build_array('create',p_document_id,p_folder_id,p_kind,p_ciphertext,p_key_epoch)::text,'UTF8'));
  select * into old from app.receipts where workspace_id=p_workspace_id and actor_id=auth.uid() and op_id=op;
  if found then
    -- The receipt is the caller's own, so a different request under this id (for example one of the caller's
    -- push op_ids) is reported as op_id_reused before access is checked; nothing about others leaks.
    if old.request_hash<>hash then
    raise exception 'op_id_reused' using errcode='PT409';

  end if;
  if private.document_rank(p_workspace_id,p_document_id)<2 then
    raise exception 'forbidden' using errcode='PT403';

  end if;
  return old.receipt;
 
  end if;
  -- Validated after the receipt lookup, like the ciphertext, so a replay always gets its receipt.
  if p_document_id is null or p_kind is null or p_kind not in ('meeting','agenda','note') then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  perform private.cipher_ok(p_ciphertext,p_key_epoch,1,p_workspace_id,p_document_id);
  -- The workspace row lock serializes creators, so this check cannot race.
  if exists(select 1 from app.documents where workspace_id=p_workspace_id and id=p_document_id) then
    raise exception 'id_conflict' using errcode='PT409';
  end if;
  -- The ACL stays NULL: a new document inherits its folder chain and the workspace role (F01).
  insert into app.documents(workspace_id,id,folder_id,kind,ciphertext,key_epoch)
    values(p_workspace_id,p_document_id,p_folder_id,p_kind,p_ciphertext,p_key_epoch);
  h:=private.append_change(p_workspace_id,p_document_id);
  -- The push receipt shape (F20).
  result:=jsonb_build_object('op_id',op,'document_id',p_document_id,'status','applied','revision','1','head',h::text);
  insert into app.receipts values(p_workspace_id,auth.uid(),op,hash,result);
  return result;
 
end
$$;
-- Compare-and-set like set_folder_acl.
create function public.set_document_acl(p_workspace_id uuid,p_document_id uuid,p_acl jsonb,p_expected_version text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare x app.workspaces;
  normalized jsonb;
  d app.documents;
 
begin
  x:=private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_expected_version is null or p_expected_version !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if p_expected_version::numeric>9223372036854775807 then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  normalized:=private.normalize_acl(p_acl);
  select * into d from app.documents where workspace_id=p_workspace_id and id=p_document_id;
  if not found then
    raise exception 'document_not_found' using errcode='PT404';
 
  end if;
  if d.acl is not distinct from normalized then
    return jsonb_build_object('access_epoch',x.access_epoch::text,'changed',false,'acl_version',d.acl_version::text);
  end if;
  if d.acl_version<>p_expected_version::bigint then
    raise exception 'acl_version_mismatch' using errcode='PT409';
  end if;
  perform private.require_acl_members(p_workspace_id,normalized);
  update app.documents set acl=normalized,acl_version=acl_version+1 where workspace_id=p_workspace_id and id=p_document_id returning * into d;
  update app.workspaces set access_epoch=access_epoch+1 where id=p_workspace_id returning * into x;
  perform private.audit(p_workspace_id,'set_document_acl',p_document_id);
  perform private.signal(p_workspace_id);
  return jsonb_build_object('access_epoch',x.access_epoch::text,'changed',true,'acl_version',d.acl_version::text);
 
end
$$;
create function public.push_document(p_workspace_id uuid,p_document_id uuid,p_op_id uuid,p_base_revision text,p_ciphertext jsonb,p_deleted boolean default false,p_key_epoch integer default 1)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare w app.workspaces;
  d app.documents;
  old app.receipts;
  hash bytea;
  result jsonb;
  h bigint;
 
begin
  w:=private.lock_workspace(p_workspace_id);
  if private.document_rank(p_workspace_id,p_document_id)<2 then
    raise exception 'forbidden' using errcode='PT403';
 
  end if;
  -- A bigint has at most 19 digits.
  if p_op_id is null or p_deleted is null or p_base_revision is null or p_base_revision !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid_push' using errcode='PT400';
 
  end if;
  -- 19 digits can still exceed the bigint range.
  if p_base_revision::numeric>9223372036854775807 then
    raise exception 'invalid_push' using errcode='PT400';
  end if;
  hash:=sha256(convert_to(jsonb_build_array(p_document_id,p_base_revision,p_ciphertext,p_deleted,p_key_epoch)::text,'UTF8'));
  select * into old from app.receipts where workspace_id=p_workspace_id and actor_id=auth.uid() and op_id=p_op_id;
  if found then
    if old.request_hash<>hash then
    raise exception 'op_id_reused' using errcode='PT409';
 
  end if;
  return old.receipt;
 
  end if;
  select * into strict d from app.documents where workspace_id=p_workspace_id and id=p_document_id;
  perform private.cipher_ok(p_ciphertext,p_key_epoch,d.key_epoch,p_workspace_id,p_document_id);
  -- A deleted document is reported before any revision comparison, so no push revives it; restore_document does.
  if d.deleted then
    result:=jsonb_build_object('op_id',p_op_id,'document_id',p_document_id,'status','deleted','revision',d.revision::text,'head',w.head::text);
  elsif d.revision<>p_base_revision::bigint then
    result:=jsonb_build_object('op_id',p_op_id,'document_id',p_document_id,'status','conflict','revision',d.revision::text,'head',w.head::text);
 
  else
    if p_deleted then
      -- To the trash (F27): the stored content stays for a restore; the request's ciphertext is validated and hashed only.
      update app.documents set deleted=true,deleted_at=clock_timestamp(),revision=revision+1 where workspace_id=p_workspace_id and id=p_document_id returning * into d;
    else
      update app.documents set ciphertext=p_ciphertext,revision=revision+1,key_epoch=p_key_epoch where workspace_id=p_workspace_id and id=p_document_id returning * into d;
    end if;
  h:=private.append_change(p_workspace_id,p_document_id);
  result:=jsonb_build_object('op_id',p_op_id,'document_id',p_document_id,'status','applied','revision',d.revision::text,'head',h::text);
 
  end if;
  insert into app.receipts values(p_workspace_id,auth.uid(),p_op_id,hash,result);
  return result;
 
end
$$;
-- Brings a document back from the trash for anyone who may edit it (F27). The receipt shares the op_id namespace
-- with push and create.
create function public.restore_document(p_workspace_id uuid,p_document_id uuid,p_op_id uuid,p_base_revision text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  w app.workspaces;
  d app.documents;
  old app.receipts;
  hash bytea;
  result jsonb;
  h bigint;
begin
  w:=private.lock_workspace(p_workspace_id);
  if private.document_rank(p_workspace_id,p_document_id)<2 then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  -- The base revision rules of push_document.
  if p_op_id is null or p_base_revision is null or p_base_revision !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if p_base_revision::numeric>9223372036854775807 then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  hash:=sha256(convert_to(jsonb_build_array('restore',p_document_id,p_base_revision)::text,'UTF8'));
  select * into old from app.receipts where workspace_id=p_workspace_id and actor_id=auth.uid() and op_id=p_op_id;
  if found then
    if old.request_hash<>hash then
      raise exception 'op_id_reused' using errcode='PT409';
    end if;
    return old.receipt;
  end if;
  select * into strict d from app.documents where workspace_id=p_workspace_id and id=p_document_id;
  if not d.deleted then
    -- Live at receipt.revision: someone restored it already.
    result:=jsonb_build_object('op_id',p_op_id,'document_id',p_document_id,'status','conflict','revision',d.revision::text,'head',w.head::text);
  elsif d.revision<>p_base_revision::bigint then
    -- Still deleted, at another revision: retry with that base.
    result:=jsonb_build_object('op_id',p_op_id,'document_id',p_document_id,'status','deleted','revision',d.revision::text,'head',w.head::text);
  elsif d.ciphertext is null or d.deleted_at<=clock_timestamp()-private.trash_retention() then
    -- Past the window, purged or not. Nothing is stored, and later calls get the same answer.
    raise exception 'restore_expired' using errcode='PT409';
  else
    update app.documents set deleted=false,deleted_at=null,revision=revision+1 where workspace_id=p_workspace_id and id=p_document_id returning * into d;
    h:=private.append_change(p_workspace_id,p_document_id);
    perform private.audit(p_workspace_id,'restore_document',p_document_id);
    result:=jsonb_build_object('op_id',p_op_id,'document_id',p_document_id,'status','applied','revision',d.revision::text,'head',h::text);
  end if;
  insert into app.receipts values(p_workspace_id,auth.uid(),p_op_id,hash,result);
  return result;
end
$$;
-- Trash entries the caller may restore (document_rank >= 2, so readers never see deleted content), by id, with their
-- content under the byte budget of get_documents.
create function public.list_trash(p_workspace_id uuid,p_after_id uuid default null,p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  w app.workspaces;
  ids uuid[];
  doc_id uuid;
  last_id uuid;
  next_id uuid;
  item jsonb;
  item_size integer;
  total bigint:=0;
  items jsonb[]:='{}';
  budget integer:=private.page_budget();
begin
  w:=private.lock_workspace(p_workspace_id);
  if private.role_rank(p_workspace_id)<1 then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  -- Keyset page as in list_members: deleted, content kept and inside the window.
  if p_after_id is null then
    ids:=array(select d.id from app.documents d where d.workspace_id=p_workspace_id and d.deleted and d.ciphertext is not null
      and d.deleted_at>clock_timestamp()-private.trash_retention() and private.document_rank(p_workspace_id,d.id)>=2 order by d.id limit p_limit+1);
  else
    ids:=array(select d.id from app.documents d where d.workspace_id=p_workspace_id and d.id>p_after_id and d.deleted and d.ciphertext is not null
      and d.deleted_at>clock_timestamp()-private.trash_retention() and private.document_rank(p_workspace_id,d.id)>=2 order by d.id limit p_limit+1);
  end if;
  -- The page ends after p_limit entries, or before the first entry that does not fit the budget (the first one always
  -- does); next_id is then the last included id.
  foreach doc_id in array ids loop
    if cardinality(items)=p_limit then
      next_id:=last_id;
      exit;
    end if;
    select jsonb_build_object('id',d.id,'folder_id',d.folder_id,'kind',d.kind,'key_epoch',d.key_epoch,'revision',d.revision::text,
      'deleted_at',private.utc_text(d.deleted_at),'purge_after',private.utc_text(d.deleted_at+private.trash_retention()),'ciphertext',d.ciphertext)
      into item from app.documents d where d.workspace_id=p_workspace_id and d.id=doc_id;
    item_size:=octet_length(item::text);
    if cardinality(items)>0 and total+item_size>budget then
      next_id:=last_id;
      exit;
    end if;
    total:=total+item_size;
    items:=array_append(items,item);
    last_id:=doc_id;
  end loop;
  return jsonb_build_object('documents',to_jsonb(items),'next_id',next_id,'head',w.head::text,'access_epoch',w.access_epoch::text);
end
$$;
-- Clears expired trash content (F27); granted to sync_maintainer only. No JWT subject, so it locks directly. One
-- workspace per call, skipping locked ones, so a long purge never stalls sync elsewhere; the caller loops while more.
-- Each call must run and commit in its own transaction: row locks last until the transaction ends, so a loop inside
-- one transaction keeps every processed workspace locked.
create function public.purge_expired_trash(p_limit integer default 100)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  w uuid;
  d uuid;
  purged integer:=0;
  -- One boundary per call, and a value an index condition can use (clock_timestamp() in a statement is volatile). It
  -- is safe to fix it at the start: a restore after that would answer restore_expired for every document it selects.
  cutoff timestamptz:=clock_timestamp()-private.trash_retention();
begin
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  -- Candidates come from documents_trash (trash with content), not from a pass over every workspace. The statements
  -- say not c.purged, as its predicate does: the planner would not match the equivalent ciphertext is not null to it.
  select x.id into w from app.workspaces x
    where x.id=any(array(select c.workspace_id from app.documents c where c.deleted and not c.purged and c.deleted_at<=cutoff))
    order by x.id for update skip locked limit 1;
  if w is null then
    return jsonb_build_object('purged',0,'more',false);
  end if;
  -- Re-read under the lock (a restore may have committed meanwhile). Clients choose document ids and only the pair
  -- (workspace, document) is unique, so every statement names both.
  for d in select c.id from app.documents c where c.workspace_id=w and c.deleted and not c.purged
      and c.deleted_at<=cutoff order by c.id limit p_limit loop
    update app.documents set ciphertext=null where workspace_id=w and id=d;
    update app.journal set snapshot=jsonb_set(snapshot,'{ciphertext}','null'::jsonb) where workspace_id=w and document_id=d and snapshot->'ciphertext'<>'null'::jsonb;
    delete from app.key_envelopes where workspace_id=w and document_id=d;
    with gone as (delete from app.attachments where workspace_id=w and document_id=d returning storage_path)
      insert into app.storage_deletions(path,workspace_id) select storage_path,w from gone on conflict(path) do nothing;
    perform private.audit_anonymous(w,'purge_document',d);
    purged:=purged+1;
  end loop;
  -- Deleted documents already read as ciphertext null, so nothing a client reads changes: no revision, journal row
  -- or signal (I1).
  -- min() rather than EXISTS: it is answered from documents_trash in deleted_at order, stopping at the first entry. An
  -- EXISTS can be planned as a scan of the whole table when old tombstones dominate the statistics, and this call still
  -- holds the workspace lock.
  return jsonb_build_object('purged',purged,'more',(select min(c.deleted_at) from app.documents c where c.deleted and not c.purged
    and c.deleted_at<=cutoff) is not null);
end
$$;
-- The AI switch (F29 minimum). AI use is not visibility, so the epoch stays; the AI RPCs read the switch under the
-- workspace lock.
create function public.set_ai_enabled(p_workspace_id uuid,p_enabled boolean)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
declare
  x app.workspaces;
begin
  x:=private.lock_workspace(p_workspace_id);
  perform private.require_owner(p_workspace_id);
  if p_enabled is null then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if x.ai_enabled=p_enabled then
    return jsonb_build_object('ai_enabled',p_enabled,'changed',false);
  end if;
  update app.workspaces set ai_enabled=p_enabled where id=p_workspace_id;
  perform private.audit(p_workspace_id,'set_ai_enabled',null);
  perform private.signal(p_workspace_id);
  return jsonb_build_object('ai_enabled',p_enabled,'changed',true);
end
$$;
create function public.pull_changes(p_workspace_id uuid,p_after text,p_limit integer default 100,p_expected_epoch text default null)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare w app.workspaces;
  after_seq bigint;
  scanned bigint;
  item record;
  change jsonb;
  change_size integer;
  total bigint:=0;
  changes jsonb[]:='{}';
  budget integer:=private.page_budget();
 
begin
  w:=private.lock_workspace(p_workspace_id);
  if private.role_rank(p_workspace_id)<1 then
    raise exception 'forbidden' using errcode='PT403';
 
  end if;
  -- A bigint has at most 19 digits.
  if p_after is null or p_after !~ '^(0|[1-9][0-9]{0,18})$' then
    raise exception 'invalid_cursor' using errcode='PT400';
 
  end if;
  -- 19 digits can still exceed the bigint range.
  if p_after::numeric>9223372036854775807 then
    raise exception 'invalid_cursor' using errcode='PT400';
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
  end if;
  after_seq:=p_after::bigint;
  if after_seq>w.head then
    raise exception 'cursor_ahead' using errcode='PT409';
 
  end if;
  if p_expected_epoch is distinct from w.access_epoch::text then
    return jsonb_build_object('reset_required',true,'changes','[]'::jsonb,'scanned_through',after_seq::text,'head',w.head::text,'access_epoch',w.access_epoch::text);
 
  end if;
  -- The window is at most p_limit journal rows. Each document in it is sent once: its current snapshot with seq =
  -- its greatest seq in the window, in that seq order. Hidden documents are skipped without a snapshot. Snapshots
  -- are built only until the byte budget cuts the page; scanned_through then stops just below the cut document's
  -- seq, so that document and every later one come in a later page.
  scanned:=after_seq;
  for item in select document_id,max(seq) as last_seq from (select document_id,seq from app.journal where workspace_id=p_workspace_id and seq>after_seq order by seq limit p_limit) win group by document_id order by last_seq loop
    if private.document_rank(p_workspace_id,item.document_id)>0 then
      select private.snapshot(current_doc)||jsonb_build_object('seq',item.last_seq::text) into change from app.documents current_doc where workspace_id=p_workspace_id and id=item.document_id;
      change_size:=octet_length(change::text);
      if cardinality(changes)>0 and total+change_size>budget then
        scanned:=item.last_seq-1;
        exit;
      end if;
      total:=total+change_size;
      changes:=array_append(changes,change);
    end if;
    scanned:=item.last_seq;
  end loop;
  return jsonb_build_object('reset_required',false,'changes',to_jsonb(changes),'scanned_through',scanned::text,'head',w.head::text,'access_epoch',w.access_epoch::text);
 
end
$$;
create function public.list_accessible_documents(p_workspace_id uuid,p_after_id uuid default null,p_limit integer default 100,p_expected_epoch text default null)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare w app.workspaces;
  ids uuid[];
  revisions bigint[];
 
begin
  w:=private.lock_workspace(p_workspace_id);
  if private.role_rank(p_workspace_id)<1 then
    raise exception 'forbidden' using errcode='PT403';
 
  end if;
  if p_limit is null or p_limit<1 or p_limit>500 then
    raise exception 'invalid_limit' using errcode='PT400';
 
  end if;
  -- Only an access change restarts a listing; writes made meanwhile are pulled from the first page's head.
  if (p_after_id is not null and p_expected_epoch is null) or (p_expected_epoch is not null and p_expected_epoch<>w.access_epoch::text) then
    return jsonb_build_object('restart_required',true,'documents','[]'::jsonb,'next_id',null,'head',w.head::text,'access_epoch',w.access_epoch::text);
 
  end if;
  -- Metadata only; content comes from get_documents. One statement per case keeps the keyset predicate
  -- index-usable under a generic plan. The extra row only shows that more exist. Access is still evaluated
  -- row by row, so sparse visibility scans many rows (F22).
  if p_after_id is null then
    select array_agg(x.id order by x.id),array_agg(x.revision order by x.id) into ids,revisions from (select d.id,d.revision from app.documents d where d.workspace_id=p_workspace_id and not d.deleted and private.document_rank(p_workspace_id,d.id)>0 order by d.id limit p_limit+1) x;
  else
    select array_agg(x.id order by x.id),array_agg(x.revision order by x.id) into ids,revisions from (select d.id,d.revision from app.documents d where d.workspace_id=p_workspace_id and d.id>p_after_id and not d.deleted and private.document_rank(p_workspace_id,d.id)>0 order by d.id limit p_limit+1) x;
  end if;
  return jsonb_build_object('restart_required',false,
    'documents',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'revision',e.revision::text) order by e.n),'[]'::jsonb) from unnest(ids,revisions) with ordinality as e(id,revision,n) where e.n<=p_limit),
    'next_id',case when cardinality(ids)>p_limit then ids[p_limit] end,'head',w.head::text,'access_epoch',w.access_epoch::text);
 
end
$$;
create function public.get_documents(p_workspace_id uuid,p_ids uuid[],p_expected_epoch text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog
as $$
  declare w app.workspaces;
  doc_id uuid;
  snap jsonb;
  snap_size integer;
  total bigint:=0;
  processed integer:=0;
  snaps jsonb[]:='{}';
  budget integer:=private.page_budget();
 
begin
  w:=private.lock_workspace(p_workspace_id);
  if private.role_rank(p_workspace_id)<1 then
    raise exception 'forbidden' using errcode='PT403';
  end if;
  -- Separate checks: OR does not fix the evaluation order, and array_position fails on a multidimensional array
  -- (PostgREST turns nested JSON arrays into one).
  if p_ids is null or cardinality(p_ids)<1 or cardinality(p_ids)>500 then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if array_ndims(p_ids)<>1 then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if array_position(p_ids,null) is not null or (select count(distinct v) from unnest(p_ids) as v)<>cardinality(p_ids) then
    raise exception 'invalid_request' using errcode='PT400';
  end if;
  if p_expected_epoch is distinct from w.access_epoch::text then
    return jsonb_build_object('restart_required',true,'documents','[]'::jsonb,'processed',0,'head',w.head::text,'access_epoch',w.access_epoch::text);
  end if;
  -- Walks the ids in storage order (lower bounds may differ from 1). A hidden or missing id is skipped and counted
  -- as processed, so the answer reveals nothing about it. The walk stops before the first visible document that
  -- does not fit the byte budget; the first visible document is always included.
  foreach doc_id in array p_ids loop
    if private.document_rank(p_workspace_id,doc_id)>0 then
      select private.snapshot(d) into snap from app.documents d where workspace_id=p_workspace_id and id=doc_id;
      snap_size:=octet_length(snap::text);
      if cardinality(snaps)>0 and total+snap_size>budget then
        exit;
      end if;
      total:=total+snap_size;
      snaps:=array_append(snaps,snap);
    end if;
    processed:=processed+1;
  end loop;
  return jsonb_build_object('restart_required',false,'documents',to_jsonb(snaps),'processed',processed,'head',w.head::text,'access_epoch',w.access_epoch::text);
end
$$;
-- Before the ownership changes below: CREATE TRIGGER needs EXECUTE on the function, which the migrator has while it
-- owns it. Dropping the trigger needs the auth.users owner; to disable it, replace the function body with `return old`.
create trigger forget_user before delete on auth.users for each row execute function private.forget_user();
revoke all on all functions in schema private from public, anon, authenticated;
-- Explicit RPC allowlist. Never grant EXECUTE to all public functions.
do $$ declare fn text; begin foreach fn in array array['create_workspace(uuid,text)','set_member(uuid,uuid,text)','invite_member(uuid,uuid,text)','respond_invitation(uuid,boolean)','leave_workspace(uuid)','offer_ownership(uuid,uuid)','accept_ownership(uuid)','list_my_workspaces(uuid,integer)','list_members(uuid,uuid,integer)','list_invitations(uuid,uuid,integer)','list_my_invitations(uuid,integer)','create_folder(uuid,uuid,uuid,jsonb)','list_folders(uuid,uuid,integer)','set_folder_acl(uuid,uuid,jsonb,text)','get_acl(uuid,text,uuid)','list_acls(uuid,text,uuid,integer)','create_document(uuid,uuid,uuid,text,jsonb,integer,uuid)','set_document_acl(uuid,uuid,jsonb,text)','push_document(uuid,uuid,uuid,text,jsonb,boolean,integer)','restore_document(uuid,uuid,uuid,text)','list_trash(uuid,uuid,integer)','set_ai_enabled(uuid,boolean)','pull_changes(uuid,text,integer,text)','list_accessible_documents(uuid,uuid,integer,text)','get_documents(uuid,uuid[],text)'] loop execute 'revoke all on function public.'||fn||' from public, anon, authenticated'; execute 'grant execute on function public.'||fn||' to authenticated'; execute 'alter function public.'||fn||' owner to sync_backend'; end loop; end $$;
-- The purge runs for ops as sync_maintainer, never for clients.
revoke all on function public.purge_expired_trash(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_trash(integer) to sync_maintainer;
alter function public.purge_expired_trash(integer) owner to sync_backend;
-- The definer has no LOGIN, superuser or BYPASSRLS capability. Table ownership
-- deliberately supplies the narrow RLS bypass used only by these checked RPCs.
alter schema app owner to sync_backend;
alter schema private owner to sync_backend;
do $$ declare obj record; begin
 for obj in select tablename from pg_tables where schemaname='app' loop
  execute format('alter table app.%I owner to sync_backend',obj.tablename);
 end loop;
 for obj in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' loop
  execute format('alter function %s owner to sync_backend',obj.signature);
 end loop;
end $$;
commit;
