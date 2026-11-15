-- =====================================================================
-- 08. AI 결과의 근거 원문 버전 연결 + 메모 첨부 연결 테이블
-- 변경점: notes / tasks / events 에 source_version_id
--           → "이 항목은 원문 v2를 보고 만들었다"를 DB에 고정 (같은 공간 복합 FK)
--           → notes는 source_id와 버전이 같은 원본을 가리키도록 (workspace_id, source_id, id) FK
--         note_attachments: 메모 하나에 여러 파일 첨부 (ATTACHMENT 자산만, 같은 공간만)
--           input_sources.asset_id = AI가 분석한 원본 파일 / note_attachments = 그냥 첨부한 파일
-- =====================================================================

-- source_text_versions: (공간, 원본, 버전ID) 조합으로 참조할 수 있게
alter table public.source_text_versions
  add constraint source_text_versions_ws_source_id_key unique (workspace_id, source_id, id);

-- notes: 원본 + 그 원본의 특정 확인 버전
alter table public.notes add column source_version_id uuid;
alter table public.notes
  add constraint notes_source_version_fkey
  foreign key (workspace_id, source_id, source_version_id)
  references public.source_text_versions (workspace_id, source_id, id) on delete restrict;
alter table public.notes
  add constraint notes_version_needs_source check (source_version_id is null or source_id is not null);
create index notes_source_version_idx on public.notes (workspace_id, source_id, source_version_id)
  where source_version_id is not null;

-- tasks / events: AI 제안을 승인해 만든 경우 근거 버전 (수동 생성은 NULL)
alter table public.tasks add column source_version_id uuid;
alter table public.tasks
  add constraint tasks_source_version_fkey
  foreign key (workspace_id, source_version_id)
  references public.source_text_versions (workspace_id, id) on delete restrict;
create index tasks_source_version_idx on public.tasks (workspace_id, source_version_id)
  where source_version_id is not null;

alter table public.events add column source_version_id uuid;
alter table public.events
  add constraint events_source_version_fkey
  foreign key (workspace_id, source_version_id)
  references public.source_text_versions (workspace_id, id) on delete restrict;
create index events_source_version_idx on public.events (workspace_id, source_version_id)
  where source_version_id is not null;

comment on column public.notes.source_version_id  is 'AI 정리 시 사용한 확정 원문 버전 (source_text_versions)';
comment on column public.tasks.source_version_id  is 'AI 제안 승인으로 생성된 경우 근거 원문 버전';
comment on column public.events.source_version_id is 'AI 제안 승인으로 생성된 경우 근거 원문 버전';

-- ---------------------------------------------------------------------
-- note_attachments: 메모 ↔ 첨부 파일 (N:M)
-- assets(workspace_id, id) 복합 FK → workspace_id가 있는 ATTACHMENT 자산만 연결 가능
-- ---------------------------------------------------------------------
create table public.note_attachments (
  workspace_id  uuid not null,
  note_id       uuid not null,
  asset_id      uuid not null,
  position      integer not null default 0,
  added_by      uuid not null references public.accounts (id) on delete restrict,
  added_at      timestamptz not null default now(),
  primary key (workspace_id, note_id, asset_id),
  foreign key (workspace_id, note_id)  references public.notes (workspace_id, id)  on delete cascade,
  foreign key (workspace_id, asset_id) references public.assets (workspace_id, id) on delete restrict
);
create index note_attachments_asset_idx on public.note_attachments (workspace_id, asset_id);

alter table public.note_attachments enable row level security;
revoke all on public.note_attachments from anon;
revoke insert, update, delete on public.note_attachments from authenticated;
create policy note_attachments_select_member on public.note_attachments
  for select to authenticated using (private.is_active_member(workspace_id));

-- 원장에 note_attachments 추가
alter table public.workspace_changes drop constraint workspace_changes_entity_table_check;
alter table public.workspace_changes add constraint workspace_changes_entity_table_check
  check (entity_table in (
    'projects', 'project_participants', 'input_sources', 'source_text_versions',
    'notes', 'note_projects', 'tasks', 'events',
    'meetings', 'agenda_items', 'agenda_transitions', 'workspace_members', 'assets',
    'note_attachments'));
