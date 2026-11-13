-- SQLite schema for the sync and AI backend (formerly supabase/migrations/202611090001_sync.sql and _ai.sql).
--
-- SQLite has no roles, row level security or stored procedures. Every rule the PostgreSQL migrations enforced with
-- RLS, GRANTs and SECURITY DEFINER functions is enforced by rpc/*.js, which is the only code allowed to open this file.
-- Whoever can read the database file can read every row: keep it private to the server process.
--
-- Conventions:
--   ids          TEXT, lowercase canonical uuid (validated by the RPC layer)
--   timestamps   INTEGER microseconds since the Unix epoch, UTC
--   booleans     INTEGER 0/1
--   json         TEXT holding valid JSON
-- Foreign keys need PRAGMA foreign_keys=ON on every connection (db/database.js sets it).

-- Replaces Supabase auth.users: the accounts the RPCs may reference.
create table users(
  id text primary key
) strict;

create table workspaces(
  id text primary key,
  -- Shown to invitees (list_my_invitations), so the size is capped (C106).
  name text not null check(length(name) between 1 and 200),
  head integer not null default 0 check(head>=0),
  access_epoch integer not null default 1 check(access_epoch>=1),
  -- Off until the owner turns it on (F29 minimum).
  ai_enabled integer not null default 0 check(ai_enabled in (0,1)),
  -- The member offered ownership; accept_ownership completes the transfer.
  pending_owner_id text references users(id)
) strict;

create table members(
  workspace_id text not null references workspaces(id),
  user_id text not null references users(id),
  role text not null check(role in ('owner','editor','viewer')),
  primary key(workspace_id,user_id)
) strict;
create unique index single_owner on members(workspace_id) where role='owner';

create table folders(
  workspace_id text not null references workspaces(id),
  id text not null,
  parent_id text,
  -- NULL inherits the parent chain and the workspace role (F01). acl_version makes owner edits compare-and-set (F02).
  acl text check(acl is null or json_valid(acl)),
  acl_version integer not null default 1 check(acl_version>=1),
  primary key(workspace_id,id),
  foreign key(workspace_id,parent_id) references folders(workspace_id,id) deferrable initially deferred
) strict;

create table documents(
  workspace_id text not null references workspaces(id),
  id text not null,
  folder_id text,
  kind text not null check(kind in ('meeting','agenda','note')),
  -- A deleted document keeps its content in the trash; purge_expired_trash clears it after the window (F27).
  ciphertext text check(ciphertext is null or json_valid(ciphertext)),
  key_epoch integer not null check(key_epoch>0),
  revision integer not null default 1 check(revision>=1),
  deleted integer not null default 0 check(deleted in (0,1)),
  acl text check(acl is null or json_valid(acl)),
  acl_version integer not null default 1 check(acl_version>=1),
  deleted_at integer,
  primary key(workspace_id,id),
  foreign key(workspace_id,folder_id) references folders(workspace_id,id),
  check(ciphertext is not null or deleted=1),
  check((deleted=1 and deleted_at is not null) or (deleted=0 and deleted_at is null))
) strict;

create table journal(
  workspace_id text not null references workspaces(id),
  seq integer not null check(seq>=1),
  document_id text not null,
  snapshot text not null check(json_valid(snapshot)),
  actor_id text references users(id),
  primary key(workspace_id,seq),
  foreign key(workspace_id,document_id) references documents(workspace_id,id)
) strict;

create table audit(
  id integer primary key autoincrement,
  workspace_id text not null references workspaces(id),
  -- NULL: written without a subject (account deletion, purge), or the actor's account was deleted (F24).
  actor_id text references users(id),
  action text not null,
  target_id text,
  head integer not null check(head>=0),
  access_epoch integer not null check(access_epoch>=1),
  recorded_at integer not null
) strict;

create table receipts(
  workspace_id text not null references workspaces(id),
  actor_id text not null references users(id),
  op_id text not null,
  request_hash blob not null check(length(request_hash)=32),
  receipt text not null check(json_valid(receipt)),
  primary key(workspace_id,actor_id,op_id)
) strict;

create table key_envelopes(
  workspace_id text not null,
  document_id text not null,
  user_id text not null,
  key_epoch integer not null check(key_epoch>0),
  wrapped_key text not null check(json_valid(wrapped_key)),
  primary key(workspace_id,document_id,user_id,key_epoch),
  foreign key(workspace_id,document_id) references documents(workspace_id,id),
  foreign key(workspace_id,user_id) references members(workspace_id,user_id) on delete cascade
) strict;

create table attachments(
  workspace_id text not null,
  document_id text not null,
  id text not null,
  storage_path text not null,
  digest text not null,
  size_bytes integer not null check(size_bytes>=0),
  primary key(workspace_id,id),
  foreign key(workspace_id,document_id) references documents(workspace_id,id)
) strict;

create table user_signals(
  user_id text not null references users(id),
  workspace_id text not null references workspaces(id),
  generation integer not null default 1 check(generation>=1),
  primary key(user_id,workspace_id)
) strict;

-- No foreign key to users: an invitation must not reveal whether an account exists.
create table invitations(
  workspace_id text not null references workspaces(id),
  user_id text not null,
  role text not null check(role in ('editor','viewer')),
  invited_at integer not null,
  primary key(workspace_id,user_id)
) strict;

-- Attachment objects to delete once storage exists (no consumer yet). No foreign key: rows outlive their workspace.
create table storage_deletions(
  path text primary key,
  workspace_id text not null,
  queued_at integer not null
) strict;

create index members_user on members(user_id);
create index invitations_user on invitations(user_id);
create index receipts_actor on receipts(actor_id);
create index journal_actor on journal(actor_id) where actor_id is not null;
create index journal_document on journal(workspace_id,document_id);
create index audit_actor on audit(actor_id) where actor_id is not null;
create index audit_target on audit(target_id) where target_id is not null;
create index audit_workspace on audit(workspace_id);
create index workspaces_pending_owner on workspaces(pending_owner_id) where pending_owner_id is not null;
create index documents_folder on documents(workspace_id,folder_id);
create index folders_parent on folders(workspace_id,parent_id);
create index user_signals_workspace on user_signals(workspace_id);
create index attachments_document on attachments(workspace_id,document_id);
-- purge_expired_trash's search: trash whose content is still kept.
create index documents_trash on documents(deleted_at) where deleted=1 and ciphertext is not null;

-- AI ----------------------------------------------------------------------------------------------------------------

create table ai_routes(
  route_id text primary key check(length(route_id) between 1 and 200),
  provider_id text not null check(length(provider_id) between 1 and 200),
  model_id text not null check(length(model_id) between 1 and 200),
  retention_version text not null check(length(retention_version) between 1 and 200),
  max_cost_microusd integer not null check(max_cost_microusd>0),
  max_output_tokens integer not null check(max_output_tokens between 1 and 1000000)
) strict;

-- AI rows go with their document or workspace (ON DELETE CASCADE); only account deletion deletes either. A row that
-- stays when its actor's account is deleted keeps actor_id NULL (F24).
create table ai_consents(
  id text primary key,
  workspace_id text not null,
  actor_id text references users(id),
  document_id text not null,
  source_revision integer not null check(source_revision>0),
  payload_sha256 text not null check(length(payload_sha256)=64),
  route_id text not null references ai_routes(route_id),
  purpose text not null check(purpose='summary'),
  retention_version text not null check(length(retention_version) between 1 and 200),
  max_cost_microusd integer not null check(max_cost_microusd>0),
  max_output_tokens integer not null check(max_output_tokens between 1 and 1000000),
  expires_at integer not null,
  revoked_at integer,
  unique(workspace_id,id),
  foreign key(workspace_id,document_id) references documents(workspace_id,id) on delete cascade
) strict;

create table ai_budgets(
  workspace_id text not null references workspaces(id) on delete cascade,
  -- Empty scope is the workspace; a uuid is that actor's workspace-period budget.
  scope text not null,
  period text not null check(period glob '[0-9][0-9][0-9][0-9]-[01][0-9]' and substr(period,6,2) between '01' and '12'),
  limit_microusd integer not null check(limit_microusd>=0),
  held_microusd integer not null default 0 check(held_microusd>=0),
  spent_microusd integer not null default 0 check(spent_microusd>=0),
  primary key(workspace_id,scope,period),
  check(held_microusd <= limit_microusd-spent_microusd)
) strict;

create table ai_jobs(
  id text primary key,
  workspace_id text not null,
  actor_id text references users(id),
  consent_id text not null unique,
  request_hash blob not null check(length(request_hash)=32),
  input_ref text not null check(length(input_ref) between 1 and 200),
  period text not null,
  reserved_microusd integer not null check(reserved_microusd>0),
  state text not null default 'queued' check(state in ('queued','claimed','dispatched','outcome_unknown','succeeded','failed','cancelled')),
  fencing_token integer not null default 0,
  lease_until integer,
  cancel_requested integer not null default 0 check(cancel_requested in (0,1)),
  hold_released integer not null default 0 check(hold_released in (0,1)),
  created_at integer not null,
  result_ref text,
  workspace_scope text not null default '' check(workspace_scope=''),
  -- Kept equal to actor_id by the RPC layer; NULL once the actor is deleted, which releases the budget reference.
  actor_scope text check(actor_scope is actor_id),
  unique(workspace_id,id),
  foreign key(workspace_id,consent_id) references ai_consents(workspace_id,id) on delete cascade,
  foreign key(workspace_id,workspace_scope,period) references ai_budgets(workspace_id,scope,period),
  foreign key(workspace_id,actor_scope,period) references ai_budgets(workspace_id,scope,period)
) strict;
create index ai_queue on ai_jobs(created_at,id) where state='queued';
create index ai_consents_actor on ai_consents(actor_id) where actor_id is not null;
create index ai_jobs_actor on ai_jobs(actor_id) where actor_id is not null;
create index ai_consents_document on ai_consents(workspace_id,document_id);
create index ai_jobs_actor_budget on ai_jobs(workspace_id,actor_scope,period);
create index ai_jobs_workspace_budget on ai_jobs(workspace_id,workspace_scope,period);

create table ai_attempts(
  workspace_id text not null,
  job_id text primary key,
  fencing_token integer not null,
  dispatched_at integer not null,
  foreign key(workspace_id,job_id) references ai_jobs(workspace_id,id) on delete cascade
) strict;

create table ai_usage_ledger(
  workspace_id text not null,
  job_id text primary key,
  provider_event_id text not null unique check(length(provider_event_id) between 1 and 200),
  cost_microusd integer not null check(cost_microusd>=0),
  outcome text not null check(outcome in ('succeeded','failed')),
  result_ref text,
  settled_at integer not null,
  foreign key(workspace_id,job_id) references ai_jobs(workspace_id,id) on delete cascade
) strict;
