-- =====================================================================
-- 03. 공유 업무 기록 (ERD ② ③ + tasks/events 추가)
-- 변경점: tasks · events 서버 테이블 추가 (로컬 ERD와 같은 키 구조)
--         revision 컬럼 이름 통일 (notes.content_revision → revision)
--         동기화 대상 테이블에 deleted_at / deleted_by (tombstone · 공유 휴지통)
--         중복 이월 방지를 DB 부분 UNIQUE로 강제
--         모든 연결은 (workspace_id, id) 복합 FK → 다른 공간 데이터와 섞이지 않음
-- 쓰기는 클라이언트 직접 불가 → sync push RPC(다음 단계)로만
-- =====================================================================

-- ---------------------------------------------------------------------
-- projects / project_participants
-- ---------------------------------------------------------------------
create table public.projects (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 100),
  description   text,
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  constraint projects_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);

create table public.project_participants (
  workspace_id  uuid not null,
  project_id    uuid not null,
  account_id    uuid not null,
  added_at      timestamptz not null default now(),
  primary key (workspace_id, project_id, account_id),
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id) references public.workspace_members (workspace_id, account_id) on delete cascade
);
comment on table public.project_participants is '참여 기록은 읽기 권한이 아님. 권한은 workspace_members ACTIVE로 판단';
create index project_participants_member_idx on public.project_participants (workspace_id, account_id);

-- ---------------------------------------------------------------------
-- input_sources / source_text_versions (원본 보존, 불변)
-- ---------------------------------------------------------------------
create table public.input_sources (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  kind          text not null check (kind in ('TEXT', 'VOICE', 'IMAGE', 'DOCUMENT')),
  original_text text,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  unique (workspace_id, id)
);
comment on table public.input_sources is '최초 입력 원본. 수정하지 않음';

create table public.source_text_versions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  source_id     uuid not null,
  version       integer not null check (version >= 1),
  text          text not null,
  confirmed_by  uuid not null references public.accounts (id) on delete restrict,
  confirmed_at  timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, version),
  foreign key (workspace_id, source_id) references public.input_sources (workspace_id, id) on delete cascade
);
comment on table public.source_text_versions is 'STT·OCR 추출문을 사용자가 확인한 불변 버전';

-- ---------------------------------------------------------------------
-- notes / note_projects
-- ---------------------------------------------------------------------
create table public.notes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  source_id     uuid,  -- 수동 생성 메모는 NULL
  title         text check (char_length(title) <= 200),
  body          text not null default '',
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  foreign key (workspace_id, source_id) references public.input_sources (workspace_id, id) on delete restrict,
  constraint notes_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);
create index notes_source_idx on public.notes (workspace_id, source_id) where source_id is not null;

create table public.note_projects (
  workspace_id  uuid not null,
  note_id       uuid not null,
  project_id    uuid not null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, note_id, project_id),
  foreign key (workspace_id, note_id)    references public.notes (workspace_id, id)    on delete cascade,
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade
);
create index note_projects_project_idx on public.note_projects (workspace_id, project_id);

-- ---------------------------------------------------------------------
-- tasks / events (신규: 서버 ERD에 누락돼 있던 공유 업무)
-- ---------------------------------------------------------------------
create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  note_id       uuid,  -- 근거 메모 (선택)
  project_id    uuid,
  assignee_id   uuid,
  title         text not null check (char_length(title) between 1 and 200),
  description   text,
  status        text not null default 'TODO' check (status in ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELED')),
  priority      smallint not null default 0 check (priority between 0 and 3),
  due_at        timestamptz,
  all_day       boolean not null default false,
  completed_at  timestamptz,
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  foreign key (workspace_id, note_id)     references public.notes (workspace_id, id)                     on delete restrict,
  foreign key (workspace_id, project_id)  references public.projects (workspace_id, id)                  on delete restrict,
  foreign key (workspace_id, assignee_id) references public.workspace_members (workspace_id, account_id) on delete restrict,
  constraint tasks_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);
create index tasks_note_idx     on public.tasks (workspace_id, note_id)     where note_id is not null;
create index tasks_project_idx  on public.tasks (workspace_id, project_id)  where project_id is not null;
create index tasks_assignee_idx on public.tasks (workspace_id, assignee_id) where assignee_id is not null;
create index tasks_due_idx      on public.tasks (workspace_id, due_at)      where deleted_at is null;

create table public.events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  note_id       uuid,
  project_id    uuid,
  title         text not null check (char_length(title) between 1 and 200),
  description   text,
  location      text,
  start_at      timestamptz not null,
  end_at        timestamptz not null,  -- 원문에 없으면 사용자가 직접 선택 (슬라이드 4)
  all_day       boolean not null default false,
  timezone      text not null default 'Asia/Seoul',
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  foreign key (workspace_id, note_id)    references public.notes (workspace_id, id)    on delete restrict,
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete restrict,
  constraint events_time_order check (end_at >= start_at),
  constraint events_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);
create index events_note_idx    on public.events (workspace_id, note_id)    where note_id is not null;
create index events_project_idx on public.events (workspace_id, project_id) where project_id is not null;
create index events_range_idx   on public.events (workspace_id, start_at)   where deleted_at is null;

-- ---------------------------------------------------------------------
-- meetings / agenda_items / agenda_transitions (ERD ③)
-- ---------------------------------------------------------------------
create table public.meetings (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  project_id    uuid,
  title         text not null check (char_length(title) between 1 and 200),
  starts_at     timestamptz,
  ends_at       timestamptz,
  status        text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'DONE', 'CANCELED')),
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete restrict,
  constraint meetings_time_order check (ends_at is null or starts_at is null or ends_at >= starts_at),
  constraint meetings_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);
create index meetings_project_idx on public.meetings (workspace_id, project_id) where project_id is not null;

create table public.agenda_items (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  meeting_id       uuid not null,
  title            text not null check (char_length(title) between 1 and 200),
  description      text,
  status           text not null default 'OPEN' check (status in ('OPEN', 'DISCUSSED', 'DEFERRED', 'CARRIED_OVER', 'CLOSED')),
  position         integer not null default 0,
  carried_from_id  uuid,
  revision         bigint not null default 1,
  created_by       uuid not null references public.accounts (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  deleted_by       uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  foreign key (workspace_id, meeting_id)      references public.meetings (workspace_id, id)     on delete cascade,
  foreign key (workspace_id, carried_from_id) references public.agenda_items (workspace_id, id) on delete restrict,
  constraint agenda_not_self_carry check (carried_from_id is null or carried_from_id <> id),
  constraint agenda_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);
create index agenda_items_meeting_idx on public.agenda_items (workspace_id, meeting_id, position);
-- 같은 원본 안건을 같은 회의로 두 번 이월하는 것을 DB에서 차단 (동시 요청 포함)
create unique index agenda_items_one_carry_per_meeting_idx
  on public.agenda_items (workspace_id, meeting_id, carried_from_id)
  where carried_from_id is not null;
create index agenda_items_carried_from_idx on public.agenda_items (workspace_id, carried_from_id) where carried_from_id is not null;

create table public.agenda_transitions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  agenda_item_id  uuid not null,
  from_status     text,
  to_status       text not null,
  actor_id        uuid not null references public.accounts (id) on delete restrict,  -- 인증 문맥에서 결정
  revision        bigint not null,
  created_at      timestamptz not null default now(),
  foreign key (workspace_id, agenda_item_id) references public.agenda_items (workspace_id, id) on delete cascade
);
create index agenda_transitions_item_idx on public.agenda_transitions (workspace_id, agenda_item_id, created_at);

-- ---------------------------------------------------------------------
-- revision 자동 증가 (UPDATE마다 +1)
-- ---------------------------------------------------------------------
create trigger projects_bump_revision     before update on public.projects     for each row execute function private.bump_revision();
create trigger notes_bump_revision        before update on public.notes        for each row execute function private.bump_revision();
create trigger tasks_bump_revision        before update on public.tasks        for each row execute function private.bump_revision();
create trigger events_bump_revision       before update on public.events       for each row execute function private.bump_revision();
create trigger meetings_bump_revision     before update on public.meetings     for each row execute function private.bump_revision();
create trigger agenda_items_bump_revision before update on public.agenda_items for each row execute function private.bump_revision();

-- ---------------------------------------------------------------------
-- RLS: ACTIVE 멤버만 조회. 쓰기 정책 없음 (sync push RPC 전용)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'project_participants', 'input_sources', 'source_text_versions',
    'notes', 'note_projects', 'tasks', 'events',
    'meetings', 'agenda_items', 'agenda_transitions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.is_active_member(workspace_id))',
      t || '_select_member', t);
  end loop;
end $$;
