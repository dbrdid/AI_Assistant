-- =====================================================================
-- 05. 운영 테이블: 구독(가짜 결제) · 이용량 · AI 요청 원장 · 동의 · 알림
-- AI Gateway(Edge Function, service_role)가 쓰고, 사용자는 본인 것만 조회
-- ai_requests에는 본문을 저장하지 않음 (요청 ID · 해시 · 상태만)
-- =====================================================================

create table public.subscriptions (
  account_id          uuid primary key references public.accounts (id) on delete cascade,
  plan                text not null default 'FREE' check (plan in ('FREE', 'PRO')),
  status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'CANCELED', 'EXPIRED')),
  current_period_end  timestamptz,
  payment_ref         text,  -- MVP: 가짜 결제 참조값
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger subscriptions_touch before update on public.subscriptions for each row execute function private.touch_updated_at();

create table public.usage_counters (
  account_id    uuid not null references public.accounts (id) on delete cascade,
  metric        text not null check (metric ~ '^[A-Z_]+$'),  -- 예: AI_ORGANIZE, AI_QUERY, STT_SECONDS, OCR_PAGES, IMAGE_GEN
  period_start  date not null,
  used          bigint not null default 0 check (used >= 0),
  reserved      bigint not null default 0 check (reserved >= 0),  -- 호출 전 비용 예약분
  updated_at    timestamptz not null default now(),
  primary key (account_id, metric, period_start)
);
create trigger usage_counters_touch before update on public.usage_counters for each row execute function private.touch_updated_at();

create table public.consents (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts (id) on delete cascade,
  consent_type    text not null check (consent_type in ('TERMS', 'PRIVACY', 'EXTERNAL_AI', 'PERSONAL_SYNC', 'MARKETING')),
  scope           jsonb not null default '{}'::jsonb,  -- 예: {"provider":"openai","features":["organize"]}
  policy_version  text not null,
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  constraint consents_revoke_after_grant check (revoked_at is null or revoked_at >= granted_at)
);
comment on table public.consents is '로그인 ≠ 기록 동기화 동의 ≠ 외부 AI 전송 동의 (각각 별도 행)';
create index consents_active_idx on public.consents (account_id, consent_type) where revoked_at is null;

create table public.ai_requests (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.accounts (id) on delete restrict,
  workspace_id         uuid references public.workspaces (id) on delete set null,
  consent_id           uuid references public.consents (id) on delete restrict,
  client_request_id    uuid not null,  -- 앱이 만든 요청 ID (재시도 시 동일)
  endpoint             text not null check (endpoint in ('organize', 'analyze', 'query', 'stt', 'ocr', 'image')),
  input_hash           text not null,
  provider             text,
  model                text,
  provider_request_id  text,
  status               text not null default 'RESERVED' check (status in ('RESERVED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  reserved_units       integer not null default 0 check (reserved_units >= 0),
  charged_units        integer check (charged_units >= 0),
  error_code           text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  unique (account_id, client_request_id)
);
comment on table public.ai_requests is '외부 AI 요청 원장. 본문(프롬프트·응답) 저장 금지. 대화 저장소 아님';
create index ai_requests_workspace_idx on public.ai_requests (workspace_id) where workspace_id is not null;
create index ai_requests_consent_idx   on public.ai_requests (consent_id)   where consent_id is not null;
create index ai_requests_status_idx    on public.ai_requests (status, created_at) where status in ('RESERVED', 'UNKNOWN');

create table public.notifications (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.accounts (id) on delete cascade,
  workspace_id   uuid references public.workspaces (id) on delete cascade,
  kind           text not null check (kind in ('BRIEFING_DAILY', 'BRIEFING_WEEKLY', 'EVENT_REMINDER', 'INVITE', 'SYSTEM')),
  ref_table      text,  -- 본문 대신 참조만 (열면 권한 확인 후 조회)
  ref_id         uuid,
  scheduled_for  timestamptz not null default now(),
  sent_at        timestamptz,
  read_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index notifications_account_idx   on public.notifications (account_id, created_at desc);
create index notifications_workspace_idx on public.notifications (workspace_id) where workspace_id is not null;
create index notifications_pending_idx   on public.notifications (scheduled_for) where sent_at is null;

-- 가입 시 FREE 구독도 함께 생성 (01의 함수 교체)
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounts (id, email) values (new.id, new.email);

  insert into public.profiles (account_id, display_name, affiliation)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name',
                  new.raw_user_meta_data ->> 'name',
                  new.raw_user_meta_data ->> 'full_name',
                  new.raw_user_meta_data ->> 'nickname',
                  ''), 50),
    left(new.raw_user_meta_data ->> 'affiliation', 100)
  );

  insert into public.user_settings (account_id) values (new.id);
  insert into public.subscriptions (account_id) values (new.id);
  return new;
end $$;

-- ---------------------------------------------------------------------
-- RLS: 본인 것만 조회. 동의는 본인이 등록·철회, 알림은 읽음 처리만
-- ---------------------------------------------------------------------
alter table public.subscriptions  enable row level security;
alter table public.usage_counters enable row level security;
alter table public.consents       enable row level security;
alter table public.ai_requests    enable row level security;
alter table public.notifications  enable row level security;

revoke all on public.subscriptions, public.usage_counters, public.consents, public.ai_requests, public.notifications from anon;
revoke insert, update, delete on public.subscriptions, public.usage_counters, public.consents, public.ai_requests, public.notifications from authenticated;

grant insert (account_id, consent_type, scope, policy_version) on public.consents to authenticated;
grant update (revoked_at) on public.consents to authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy subscriptions_select_own  on public.subscriptions  for select to authenticated using (account_id = (select auth.uid()));
create policy usage_counters_select_own on public.usage_counters for select to authenticated using (account_id = (select auth.uid()));
create policy ai_requests_select_own    on public.ai_requests    for select to authenticated using (account_id = (select auth.uid()));

create policy consents_select_own on public.consents for select to authenticated using (account_id = (select auth.uid()));
create policy consents_insert_own on public.consents for insert to authenticated with check (account_id = (select auth.uid()));
create policy consents_revoke_own on public.consents for update to authenticated
  using (account_id = (select auth.uid()) and revoked_at is null)
  with check (account_id = (select auth.uid()) and revoked_at is not null);

create policy notifications_select_own on public.notifications for select to authenticated using (account_id = (select auth.uid()));
create policy notifications_read_own   on public.notifications for update to authenticated
  using (account_id = (select auth.uid())) with check (account_id = (select auth.uid()));

revoke all on all functions in schema private from public, anon;
grant execute on function private.is_active_member(uuid) to authenticated;
grant execute on function private.has_role(uuid, text[]) to authenticated;
grant execute on function private.shares_workspace(uuid) to authenticated;
