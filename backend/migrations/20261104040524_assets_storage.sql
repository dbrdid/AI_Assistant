-- =====================================================================
-- 07. 첨부·백업 파일 메타데이터(assets) + 비공개 Storage 버킷 (슬라이드 39)
-- 업로드 절차: 준비 API(Edge Function) → 서명된 업로드 URL로 비공개 업로드
--              → 완료 API가 실제 객체·크기·해시·현재 권한 확인 → AVAILABLE
-- 목적 분리:   ATTACHMENT = 공유 공간 첨부 (attachments 버킷, 경로 {workspace_id}/{asset_id})
--              BACKUP     = 개인 암호화 백업 (backups 버킷,  경로 {account_id}/{asset_id})
-- 클라이언트는 assets·Storage에 직접 쓰지 못함. 업로드·완료·삭제는 Edge Function(service_role) 전용
-- =====================================================================

create table public.assets (
  id                   uuid primary key default gen_random_uuid(),
  purpose              text not null check (purpose in ('ATTACHMENT', 'BACKUP')),
  workspace_id         uuid references public.workspaces (id) on delete cascade,  -- ATTACHMENT만
  owner_account_id     uuid not null references public.accounts (id) on delete restrict,  -- 업로드한 사람 / 백업 소유자
  bucket_id            text not null,
  object_path          text not null,
  original_name        text check (char_length(original_name) <= 255),
  mime_type            text not null,
  declared_size_bytes  bigint not null check (declared_size_bytes > 0),
  declared_sha256      text not null check (declared_sha256 ~ '^[0-9a-f]{64}$'),
  actual_size_bytes    bigint check (actual_size_bytes > 0),
  status               text not null default 'PENDING' check (status in ('PENDING', 'AVAILABLE', 'FAILED', 'DELETED')),
  failure_reason       text,
  upload_expires_at    timestamptz not null default now() + interval '1 hour',  -- PENDING 정리 기준
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  deleted_at           timestamptz,
  deleted_by           uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  unique (bucket_id, object_path),
  -- 목적별 버킷·경로·공간 규칙
  constraint assets_purpose_shape check (
    (purpose = 'ATTACHMENT' and workspace_id is not null and bucket_id = 'attachments'
       and object_path = workspace_id::text || '/' || id::text)
    or
    (purpose = 'BACKUP' and workspace_id is null and bucket_id = 'backups'
       and object_path = owner_account_id::text || '/' || id::text)
  ),
  -- AVAILABLE = 완료 검증을 통과한 상태 (선언 크기와 실제 크기가 같아야 함)
  constraint assets_available_verified check (
    status <> 'AVAILABLE'
    or (completed_at is not null and actual_size_bytes = declared_size_bytes)
  ),
  constraint assets_deleted_pair check ((status = 'DELETED') = (deleted_at is not null))
);
comment on table public.assets is '첨부·백업 파일 메타데이터. AVAILABLE은 공개 URL이 아니라 권한 있는 사용자가 서명 URL로 받을 수 있는 상태';
comment on column public.assets.declared_sha256 is '기기가 업로드 전에 계산한 SHA-256. 완료 API가 실제 객체와 대조';

create index assets_owner_idx      on public.assets (owner_account_id);
create index assets_deleted_by_idx on public.assets (deleted_by) where deleted_by is not null;
create index assets_pending_idx    on public.assets (upload_expires_at) where status = 'PENDING';

-- 원본 입력(음성·이미지·문서)이 어떤 파일에서 왔는지 연결 (같은 공간끼리만)
alter table public.input_sources add column asset_id uuid;
alter table public.input_sources
  add constraint input_sources_asset_fkey
  foreign key (workspace_id, asset_id) references public.assets (workspace_id, id) on delete restrict;
alter table public.input_sources
  add constraint input_sources_asset_kind check (asset_id is null or kind in ('VOICE', 'IMAGE', 'DOCUMENT'));
create index input_sources_asset_idx on public.input_sources (workspace_id, asset_id) where asset_id is not null;

-- 공유 첨부 목록도 동기화 원장으로 전달
alter table public.workspace_changes drop constraint workspace_changes_entity_table_check;
alter table public.workspace_changes add constraint workspace_changes_entity_table_check
  check (entity_table in (
    'projects', 'project_participants', 'input_sources', 'source_text_versions',
    'notes', 'note_projects', 'tasks', 'events',
    'meetings', 'agenda_items', 'agenda_transitions', 'workspace_members', 'assets'));

-- ---------------------------------------------------------------------
-- RLS: 공유 첨부는 ACTIVE 멤버가 AVAILABLE만 조회 (업로더는 자기 PENDING/FAILED도 조회)
--      백업은 소유자만
-- ---------------------------------------------------------------------
alter table public.assets enable row level security;
revoke all on public.assets from anon;
revoke insert, update, delete on public.assets from authenticated;

create policy assets_select on public.assets
  for select to authenticated
  using (
    (purpose = 'ATTACHMENT' and (
        (status = 'AVAILABLE' and private.is_active_member(workspace_id))
        or (owner_account_id = (select auth.uid()) and status in ('PENDING', 'FAILED'))
    ))
    or (purpose = 'BACKUP' and owner_account_id = (select auth.uid()) and status <> 'DELETED')
  );

-- ---------------------------------------------------------------------
-- Storage 버킷 (비공개)
-- 프로젝트 전역 업로드 한도(기본 50MB)보다 크게 잡을 수 없음 → 필요하면 Storage 설정에서 같이 올릴 것
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('attachments', 'attachments', false, 52428800,
   array['image/*', 'audio/*', 'application/pdf', 'text/plain',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('backups', 'backups', false, 52428800,
   array['application/octet-stream'])  -- 기기에서 암호화한 바이너리만
on conflict (id) do nothing;

-- 다운로드(서명 URL 발급) 권한: assets 행이 AVAILABLE이고 현재 권한이 있을 때만
create or replace function private.can_read_asset_object(p_bucket_id text, p_object_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.assets a
    where a.bucket_id   = p_bucket_id
      and a.object_path = p_object_name
      and a.status      = 'AVAILABLE'
      and (
        (a.purpose = 'ATTACHMENT' and private.is_active_member(a.workspace_id))
        or (a.purpose = 'BACKUP' and a.owner_account_id = (select auth.uid()))
      )
  );
$$;
revoke all on function private.can_read_asset_object(text, text) from public, anon;
grant execute on function private.can_read_asset_object(text, text) to authenticated;

-- storage.objects: 조회(=서명 URL 발급)만 허용. 업로드는 준비 API가 만든 서명 업로드 URL로,
-- 삭제·덮어쓰기는 Edge Function(Storage API)으로만
create policy assets_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id in ('attachments', 'backups')
    and private.can_read_asset_object(bucket_id, name)
  );
