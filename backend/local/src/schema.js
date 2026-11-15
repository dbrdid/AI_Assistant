/**
 * 기기 스키마 (PRAGMA user_version으로 버전 관리). 배포된 뒤에는 STEPS에 단계를 더하기만 하고 지난 단계는 고치지 않습니다.
 * 2026-11-15: 화면에 연결되기 전이라 1단계를 서버(Supabase) 스키마에 맞춰 다시 썼습니다.
 *
 * 서버와 맞춘 점
 *   - 모든 id는 UUID (서버 기록 id로 그대로 씀). 공유 공간은 workspaces.server_id가 서버 공간 id
 *   - 길이 한도·손글씨 형식은 서버 check 제약과 같음 (validate.js)
 *   - 일정·할 일은 화면처럼 한 표(tasks). kind가 서버 표를 정함: 'task' → tasks, 'event' → events
 *   - 일정·할 일도 deleted_at(휴지통)이 있음: 공유 공간은 서버처럼 휴지통으로, 개인 공간은 화면 규칙대로 바로 삭제
 *   - outbox: 공유 공간에서 한 저장을 서버 형식 변경(LocalChange)으로 같은 트랜잭션에 적어 둠 → 동기화가 가져감
 *
 * 시각은 밀리초 숫자(Date.now()), 날짜는 'YYYY-MM-DD', 시간은 'HH:MM' 글자 (화면이 쓰는 모양).
 */
const V1 = `
create table workspaces(
  id text primary key,
  server_id text unique,
  name text not null,
  description text not null default '',
  personal integer not null default 0 check(personal in (0,1)),
  role text not null default 'OWNER' check(role in ('OWNER','EDITOR','VIEWER')),
  member_count integer not null default 1 check(member_count>=1),
  created_at integer not null,
  check(personal=0 or server_id is null)
);
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
  -- 내용(제목·본문·손글씨)이 바뀔 때만 오르는 기기 번호. AI 제안이 원본 변경을 알아내는 데 씀 (서버 revision과 다른 숫자)
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
  kind text not null check(kind in ('task','event')),
  title text not null,
  date text not null default '',
  end_date text not null default '',
  start_time text not null default '',
  end_time text not null default '',
  priority text not null,
  status text not null,
  alarm text not null,
  assignee text not null default '',
  place text not null default '',
  project text not null default '',
  project_id text,
  description text not null default '',
  revision integer not null default 1 check(revision>=1),
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer,
  unique(workspace_id,id)
);
create index tasks_by_date on tasks(workspace_id, deleted_at, date, start_time);

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
  end_date text not null default '',
  start_time text not null default '',
  end_time text not null default '',
  place text not null default '',
  assignee text not null default '',
  priority text not null default '',
  body text not null default '',
  evidence text not null default '',
  source_type text not null default '',
  source_id text,
  source_title text not null default '',
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

-- 공유 공간에서 한 저장 1번 = 1줄. changes는 동기화(local-sync의 saveLocal)에 그대로 넘길 LocalChange 배열(JSON)
create table outbox(
  seq integer primary key autoincrement,
  workspace_id text not null references workspaces(id) on delete cascade,
  changes text not null,
  created_at integer not null
);
`;

const STEPS = [V1];
export const SCHEMA_VERSION = STEPS.length;

export function createPersonal(db, { now, newId }) {
  const personal = newId();
  db.runSync("insert into workspaces(id,name,description,personal,role,created_at) values(?,?,?,1,'OWNER',?)", [personal, '개인 공간', '', now()]);
  db.runSync("insert into settings(key,value) values('current_workspace',?) on conflict(key) do update set value=excluded.value", [personal]);
  return personal;
}

/**
 * DB를 마지막 단계까지 올림. 단계와 버전 올리기는 한 트랜잭션이라, 도중에 실패하면 그 단계는 없던 일이 되고 다음에 다시 시도함.
 * 새 DB면 개인 공간을 같이 만듦.
 * 표를 바꿀 때: 위 V1은 고치지 말고, 바꾸는 SQL(alter table 등)을 새 문자열로 STEPS 끝에 더함. 이미 설치된 기기는 그 단계만 실행됨.
 * steps는 테스트용 (다음 단계가 생겼을 때 기존 기록이 남는지 확인).
 */
export function migrate(db, { now, newId }, steps = STEPS) {
  const SCHEMA_VERSION = steps.length;
  const version = db.getFirstSync('pragma user_version').user_version;
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error(`Unsupported local database version ${version}`);
  }
  // 서버에 맞추기 전(2026-11-15 원본) 스키마로 만든 파일은 버전 번호가 같아서 표 모양으로 구분함
  if (version >= 1 && !db.getFirstSync("select 1 as ok from sqlite_master where type='table' and name='outbox'")) {
    throw new Error('이 기기 DB는 이전 스키마로 만들어졌어요. DB 파일을 지우고 다시 열어 주세요');
  }
  for (let step = version; step < SCHEMA_VERSION; step++) {
    db.withTransactionSync(() => {
      db.execSync(steps[step]);
      if (step === 0) createPersonal(db, { now, newId });
      db.execSync(`pragma user_version = ${step + 1}`);
    });
  }
}
