-- =====================================================================
-- 04. 동기화 원장 · 요청 멱등성 · 기기 등록 (ERD ④ + 슬라이드 37)
-- 변경점: workspace_sync_heads.min_retained_seq 추가 (커서가 보관 범위보다 오래됐는지 판단)
--         workspace_changes 내용 컬럼 확정 (entity_table/key, op, data, revision, operation_id, actor)
--         devices 테이블 신설 (기기 ID·이름·앱 버전·푸시 토큰 → push_tokens 대체)
--         공간 생성 시 sync_head 자동 생성 + create_workspace RPC
-- 원장 테이블은 RLS ON + 정책 없음 → 클라이언트 직접 접근 불가, RPC/Edge Function 전용
-- =====================================================================

create table public.workspace_sync_heads (
  workspace_id      uuid primary key references public.workspaces (id) on delete cascade,
  last_seq          bigint not null default 0,
  min_retained_seq  bigint not null default 0,
  updated_at        timestamptz not null default now(),
  constraint sync_heads_seq_range check (min_retained_seq >= 0 and min_retained_seq <= last_seq)
);
comment on column public.workspace_sync_heads.last_seq is 'push 트랜잭션이 이 행을 잠근 뒤 +1 해서 seq 배정 (커밋 순서 = seq 순서)';
comment on column public.workspace_sync_heads.min_retained_seq is '이보다 오래된 변경은 정리됨. 커서 < min_retained_seq 이면 스냅샷 재동기화';

create table public.workspace_changes (
  workspace_id  uuid not null references public.workspace_sync_heads (workspace_id) on delete cascade,
  seq           bigint not null check (seq > 0),
  entity_table  text not null check (entity_table in (
                  'projects', 'project_participants', 'input_sources', 'source_text_versions',
                  'notes', 'note_projects', 'tasks', 'events',
                  'meetings', 'agenda_items', 'agenda_transitions', 'workspace_members')),
  entity_key    text not null,  -- 단일 PK면 id, 복합 PK면 'note_id:project_id' 형식
  op            text not null check (op in ('UPSERT', 'DELETE')),
  revision      bigint,
  data          jsonb,          -- UPSERT: 변경 후 행 전체. soft delete도 deleted_at 담은 UPSERT
  operation_id  uuid,
  actor_id      uuid references public.accounts (id) on delete restrict,
  committed_at  timestamptz not null default now(),
  primary key (workspace_id, seq),
  constraint changes_upsert_has_data check (op <> 'UPSERT' or data is not null)
);
create index workspace_changes_entity_idx on public.workspace_changes (workspace_id, entity_table, entity_key);

create table public.devices (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references public.accounts (id) on delete cascade,
  installation_id  text not null,  -- 앱 설치 시 생성한 기기 식별자
  device_name      text check (char_length(device_name) <= 100),
  platform         text not null check (platform in ('ios', 'android', 'web')),
  app_version      text not null,
  push_provider    text check (push_provider in ('FCM', 'APNS')),
  push_token       text,
  last_seen_at     timestamptz not null default now(),
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (account_id, installation_id),
  constraint devices_push_pair check ((push_token is null) = (push_provider is null))
);
create unique index devices_active_push_token_idx on public.devices (push_token)
  where push_token is not null and revoked_at is null;
create trigger devices_touch before update on public.devices for each row execute function private.touch_updated_at();

create table public.sync_operations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  actor_id      uuid not null references public.accounts (id) on delete restrict,
  device_id     uuid references public.devices (id) on delete set null,
  operation_id  uuid not null,
  payload_hash  text not null,
  status        text not null check (status in ('ACCEPTED', 'CONFLICT', 'REJECTED')),
  receipt       jsonb not null default '{}'::jsonb,
  accepted_seq  bigint,
  created_at    timestamptz not null default now(),
  unique (workspace_id, actor_id, operation_id),
  constraint sync_ops_seq_when_accepted check ((status = 'ACCEPTED') = (accepted_seq is not null))
);
comment on table public.sync_operations is '같은 operation_id + payload_hash 재요청은 저장된 receipt 그대로 반환 (멱등성)';
create index sync_operations_actor_idx  on public.sync_operations (actor_id);
create index sync_operations_device_idx on public.sync_operations (device_id) where device_id is not null;

-- 공간이 생기면 sync_head도 같이 생성
create or replace function private.create_sync_head()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_sync_heads (workspace_id) values (new.id);
  return new;
end $$;

create trigger workspaces_create_sync_head
  after insert on public.workspaces
  for each row execute function private.create_sync_head();

-- 공유 공간 생성 RPC: 공간 + OWNER 멤버 + sync_head 를 한 트랜잭션으로
create or replace function public.create_workspace(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  insert into public.workspaces (kind, name, created_by)
  values ('SHARED', p_name, v_uid)
  returning id into v_id;

  insert into public.workspace_members (workspace_id, account_id, role)
  values (v_id, v_uid, 'OWNER');

  return v_id;
end $$;

revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.workspace_sync_heads enable row level security;
alter table public.workspace_changes    enable row level security;
alter table public.sync_operations      enable row level security;
alter table public.devices              enable row level security;

revoke all on public.workspace_sync_heads, public.workspace_changes, public.sync_operations, public.devices from anon;
revoke all on public.workspace_sync_heads, public.workspace_changes, public.sync_operations from authenticated;
-- (위 3개는 정책 없음 = 클라이언트 접근 불가)

revoke insert, update, delete on public.devices from authenticated;
grant insert (account_id, installation_id, device_name, platform, app_version, push_provider, push_token) on public.devices to authenticated;
grant update (device_name, app_version, push_provider, push_token, last_seen_at) on public.devices to authenticated;

create policy devices_select_own on public.devices
  for select to authenticated using (account_id = (select auth.uid()));
create policy devices_insert_own on public.devices
  for insert to authenticated with check (account_id = (select auth.uid()));
create policy devices_update_own on public.devices
  for update to authenticated
  using (account_id = (select auth.uid()) and revoked_at is null)
  with check (account_id = (select auth.uid()));

revoke all on all functions in schema private from public, anon;
grant execute on function private.is_active_member(uuid) to authenticated;
grant execute on function private.has_role(uuid, text[]) to authenticated;
grant execute on function private.shares_workspace(uuid) to authenticated;
