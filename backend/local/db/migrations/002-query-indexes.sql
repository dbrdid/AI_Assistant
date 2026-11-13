-- Keep the v1 schema immutable. This step changes indexes only; no user rows are rewritten.
-- Queue selection first chooses a workspace, then its earliest queued row (rowid breaks ties).
drop index ai_queue;
create index ai_queue_workspace on ai_jobs(workspace_id,created_at) where state='queued';

-- Prefix-only user indexes are superseded by ordered membership/invitation lookup.
drop index members_user;
create index members_user on members(user_id,workspace_id);
drop index invitations_user;
create index invitations_user on invitations(user_id,workspace_id);

-- Admission rate counts bound both tenant and actor before the timestamp range.
create index ai_jobs_actor_recent on ai_jobs(workspace_id,actor_id,created_at);
