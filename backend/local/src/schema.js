/**
 * The on-device schema, versioned with PRAGMA user_version. A later change adds a numbered step to STEPS and never
 * edits a released one. Every row belongs to a workspace; links carry the workspace in their foreign keys, so a memo
 * can never point at a task of another workspace.
 *
 * Times are epoch milliseconds (Date.now()). Dates are 'YYYY-MM-DD' and times 'HH:MM' text, as the screens use them.
 */
const V1 = `
create table workspaces(
  id text primary key,
  name text not null,
  description text not null default '',
  personal integer not null default 0 check(personal in (0,1)),
  created_at integer not null
);
create unique index workspaces_name on workspaces(name);
create unique index workspaces_one_personal on workspaces(personal) where personal=1;

create table settings(
  key text primary key,
  value text not null
);

create table memos(
  workspace_id text not null references workspaces(id) on delete cascade,
  id text primary key,
  title text not null default '',
  body text not null default '',
  strokes text not null default '[]',
  photos text not null default '[]',
  favorite integer not null default 0 check(favorite in (0,1)),
  -- Counts content edits (title, body, strokes) only; AI proposals compare it to detect a changed source.
  revision integer not null default 1 check(revision>=1),
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  unique(workspace_id,id)
);
create index memos_list on memos(workspace_id, deleted_at, updated_at);

create table tasks(
  workspace_id text not null references workspaces(id) on delete cascade,
  id text primary key,
  title text not null,
  date text not null,
  start_time text not null default '',
  end_time text not null default '',
  priority text not null,
  status text not null,
  alarm text not null,
  assignee text not null default '',
  place text not null default '',
  project text not null default '',
  description text not null default '',
  revision integer not null default 1 check(revision>=1),
  created_at integer not null,
  updated_at integer not null,
  unique(workspace_id,id)
);
create index tasks_by_date on tasks(workspace_id, date, start_time);

create table memo_tasks(
  workspace_id text not null,
  memo_id text not null,
  task_id text not null,
  position integer not null,
  primary key(memo_id, task_id),
  foreign key(workspace_id, memo_id) references memos(workspace_id, id) on delete cascade,
  foreign key(workspace_id, task_id) references tasks(workspace_id, id) on delete cascade
);
create index memo_tasks_task on memo_tasks(task_id);
create index memo_tasks_workspace on memo_tasks(workspace_id, memo_id, position);

create table proposals(
  workspace_id text not null references workspaces(id) on delete cascade,
  id text primary key,
  kind text not null check(kind in ('event','task','memo')),
  title text not null default '',
  date text not null default '',
  start_time text not null default '',
  end_time text not null default '',
  place text not null default '',
  assignee text not null default '',
  body text not null default '',
  evidence text not null default '',
  source_type text not null default '',
  source_id text,
  source_title text not null default '',
  -- The memo revision the analysis read; approval is refused once the memo has moved on.
  source_revision integer,
  status text not null default 'pending' check(status in ('pending','hold','approved','rejected','superseded')),
  result_kind text check(result_kind in ('memo','task')),
  result_id text,
  created_at integer not null,
  updated_at integer not null,
  check((status='approved') = (result_id is not null and result_kind is not null))
);
create index proposals_open on proposals(workspace_id, status, created_at);
create index proposals_source on proposals(workspace_id, source_type, source_id);
`;

const STEPS = [V1];
export const SCHEMA_VERSION = STEPS.length;

/**
 * Brings the database to SCHEMA_VERSION. Each step and its version bump commit together. On a new database the
 * personal workspace is created and selected in the same transaction as the tables.
 */
export function migrate(db, { now, newId }) {
  const version = db.getFirstSync('pragma user_version').user_version;
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error(`Unsupported local database version ${version}`);
  }
  for (let step = version; step < SCHEMA_VERSION; step++) {
    db.withTransactionSync(() => {
      db.execSync(STEPS[step]);
      if (step === 0) {
        const personal = newId();
        db.runSync('insert into workspaces(id,name,description,personal,created_at) values(?,?,?,?,?)', [personal, '개인 공간', '', 1, now()]);
        db.runSync("insert into settings(key,value) values('current_workspace',?)", [personal]);
      }
      db.execSync(`pragma user_version = ${step + 1}`);
    });
  }
}
