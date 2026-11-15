-- =====================================================================
-- 01. 기반: private 스키마, 공통 트리거 함수, 계정(accounts/profiles/user_settings)
-- 변경점: accounts.id = auth.users.id (auth_subject 별도 컬럼 제거 → RLS에서 auth.uid() 바로 사용)
--         회원탈퇴 정책 미정 → auth.users 삭제는 restrict
-- =====================================================================

-- API로 노출되지 않는 헬퍼 전용 스키마
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

-- updated_at 자동 갱신
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- 동기화 대상 테이블: UPDATE마다 revision + 1 (base_revision 검사 기준)
create or replace function private.bump_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.revision   := old.revision + 1;
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- accounts: 내부 사용자 = Supabase Auth 사용자 (1:1, 같은 uuid)
-- ---------------------------------------------------------------------
create table public.accounts (
  id          uuid primary key references auth.users (id) on delete restrict,
  email       text,
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'DEACTIVATED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.accounts is '내부 계정. id는 auth.users.id와 동일. 탈퇴 정책 미정이라 auth 사용자 삭제는 restrict';

create table public.profiles (
  account_id    uuid primary key references public.accounts (id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 50),
  affiliation   text check (char_length(affiliation) <= 100),
  avatar_path   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.user_settings (
  account_id               uuid primary key references public.accounts (id) on delete cascade,
  timezone                 text not null default 'Asia/Seoul',
  locale                   text not null default 'ko-KR',
  onboarding_completed_at  timestamptz,
  terms_agreed_at          timestamptz,
  preferences              jsonb not null default '{}'::jsonb,  -- 알림 종류별 on/off, 방해 금지 시간 등
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
comment on table public.user_settings is '최초 설정을 계정에 저장해 다른 기기에서도 유지 (슬라이드 29)';

create trigger accounts_touch      before update on public.accounts      for each row execute function private.touch_updated_at();
create trigger profiles_touch      before update on public.profiles      for each row execute function private.touch_updated_at();
create trigger user_settings_touch before update on public.user_settings for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 가입 시 accounts/profiles/user_settings 자동 생성
-- 회원가입 화면의 이름·소속은 signUp options.data 로 { display_name, affiliation } 전달
-- ---------------------------------------------------------------------
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
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 이메일 변경 시 accounts.email 동기화
create or replace function private.handle_user_email_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.accounts set email = new.email where id = new.id;
  return new;
end $$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.handle_user_email_change();

-- ---------------------------------------------------------------------
-- RLS + 컬럼 단위 권한
-- ---------------------------------------------------------------------
alter table public.accounts      enable row level security;
alter table public.profiles      enable row level security;
alter table public.user_settings enable row level security;

revoke all on public.accounts, public.profiles, public.user_settings from anon;
revoke insert, update, delete on public.accounts, public.profiles, public.user_settings from authenticated;
grant update (display_name, affiliation, avatar_path) on public.profiles to authenticated;
grant update (timezone, locale, onboarding_completed_at, terms_agreed_at, preferences) on public.user_settings to authenticated;

create policy accounts_select_own on public.accounts
  for select to authenticated using (id = (select auth.uid()));

create policy profiles_select_own on public.profiles
  for select to authenticated using (account_id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (account_id = (select auth.uid())) with check (account_id = (select auth.uid()));

create policy user_settings_select_own on public.user_settings
  for select to authenticated using (account_id = (select auth.uid()));
create policy user_settings_update_own on public.user_settings
  for update to authenticated
  using (account_id = (select auth.uid())) with check (account_id = (select auth.uid()));

revoke all on all functions in schema private from public, anon;
