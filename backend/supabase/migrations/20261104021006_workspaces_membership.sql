-- =====================================================================
-- 02. 워크스페이스 · 멤버 · 초대 (ERD ①)
-- 변경점: owner_account_id → created_by (권한 기준은 workspace_members.role 하나)
--         epoch는 workspaces.auth_epoch 하나로 통일 (멤버 role/status 변경 시 +1)
--         초대: invitee_email · role · status · accepted_* 추가, token_hash UNIQUE
--         마지막 ACTIVE OWNER 강등/이탈 차단 (공간 행 잠금 아래 검사)
--         RLS 재귀 방지용 security definer 헬퍼
--         MVP: 서버에는 SHARED 공간만 생성 (PERSONAL은 향후 개인 동기화용으로 값만 예약)
-- =====================================================================

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'SHARED' check (kind in ('SHARED', 'PERSONAL')),
  name        text not null check (char_length(name) between 1 and 60),
  created_by  uuid not null references public.accounts (id) on delete restrict,
  auth_epoch  bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
comment on column public.workspaces.created_by is '만든 사람 기록용. 소유 권한 판단은 workspace_members.role = OWNER';
comment on column public.workspaces.auth_epoch is '멤버 role/status가 바뀔 때마다 +1. Pull 커서 키에 포함';

create table public.workspace_members (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  account_id    uuid not null references public.accounts (id) on delete restrict,
  role          text not null check (role in ('OWNER', 'EDITOR', 'VIEWER')),
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'LEFT', 'REMOVED')),
  invited_by    uuid references public.accounts (id) on delete restrict,
  joined_at     timestamptz not null default now(),
  ended_at      timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, account_id),
  constraint members_ended_matches_status check ((status = 'ACTIVE') = (ended_at is null))
);
comment on table public.workspace_members is '멤버 제외는 행 삭제가 아니라 status 변경 (project_participants 등이 FK로 참조)';
create index workspace_members_account_active_idx on public.workspace_members (account_id) where status = 'ACTIVE';

create table public.workspace_invites (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  invitee_email  text not null check (invitee_email = lower(invitee_email)),
  role           text not null default 'EDITOR' check (role in ('EDITOR', 'VIEWER')),
  token_hash     text not null unique,
  status         text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  invited_by     uuid not null references public.accounts (id) on delete restrict,
  expires_at     timestamptz not null,
  accepted_by    uuid references public.accounts (id) on delete restrict,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now(),
  constraint invites_expiry_after_create check (expires_at > created_at),
  constraint invites_accepted_fields check ((status = 'ACCEPTED') = (accepted_at is not null and accepted_by is not null))
);
create unique index workspace_invites_one_pending_idx on public.workspace_invites (workspace_id, invitee_email) where status = 'PENDING';

create trigger workspaces_touch        before update on public.workspaces        for each row execute function private.touch_updated_at();
create trigger workspace_members_touch before update on public.workspace_members for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- RLS 헬퍼 (security definer → workspace_members 정책 안에서 자기 참조 재귀 방지)
-- ---------------------------------------------------------------------
create or replace function private.is_active_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
    where m.workspace_id = p_workspace_id
      and m.account_id   = (select auth.uid())
      and m.status       = 'ACTIVE'
      and w.deleted_at is null
  );
$$;

create or replace function private.has_role(p_workspace_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
    where m.workspace_id = p_workspace_id
      and m.account_id   = (select auth.uid())
      and m.status       = 'ACTIVE'
      and m.role         = any (p_roles)
      and w.deleted_at is null
  );
$$;

-- 같은 공간의 ACTIVE 멤버끼리 프로필(이름) 조회 허용
create or replace function private.shares_workspace(p_account_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_members me
    join public.workspace_members other on other.workspace_id = me.workspace_id
    where me.account_id    = (select auth.uid())
      and me.status        = 'ACTIVE'
      and other.account_id = p_account_id
      and other.status     = 'ACTIVE'
  );
$$;

-- ---------------------------------------------------------------------
-- 마지막 ACTIVE OWNER 보호 (같은 공간 잠금 아래 검사 → 동시 강등 경합 방지)
-- 공간 자체가 삭제되며 cascade로 지워지는 경우는 허용
-- ---------------------------------------------------------------------
create or replace function private.guard_last_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'OWNER' and old.status = 'ACTIVE'
     and (tg_op = 'DELETE' or new.role <> 'OWNER' or new.status <> 'ACTIVE') then

    perform 1 from public.workspaces where id = old.workspace_id for update;

    if found and not exists (
      select 1 from public.workspace_members
      where workspace_id = old.workspace_id
        and account_id  <> old.account_id
        and role = 'OWNER' and status = 'ACTIVE'
    ) then
      raise exception 'LAST_OWNER: 공간의 마지막 OWNER는 역할을 바꾸거나 나갈 수 없습니다'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger workspace_members_guard_last_owner
  before update or delete on public.workspace_members
  for each row execute function private.guard_last_owner();

-- 멤버 role/status 변경 → auth_epoch + 1
create or replace function private.bump_auth_epoch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.workspaces set auth_epoch = auth_epoch + 1 where id = old.workspace_id;
    return old;
  end if;
  if new.role is distinct from old.role or new.status is distinct from old.status then
    update public.workspaces set auth_epoch = auth_epoch + 1 where id = new.workspace_id;
  end if;
  return new;
end $$;

create trigger workspace_members_bump_epoch
  after update or delete on public.workspace_members
  for each row execute function private.bump_auth_epoch();

-- ---------------------------------------------------------------------
-- RLS: 클라이언트는 조회만. 생성·초대·역할 변경은 RPC/Edge Function으로
-- ---------------------------------------------------------------------
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;

revoke all on public.workspaces, public.workspace_members, public.workspace_invites from anon;
revoke insert, update, delete on public.workspaces, public.workspace_members, public.workspace_invites from authenticated;

create policy workspaces_select_member on public.workspaces
  for select to authenticated using (private.is_active_member(id));

create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (account_id = (select auth.uid()) or private.is_active_member(workspace_id));

create policy workspace_invites_select_owner on public.workspace_invites
  for select to authenticated using (private.has_role(workspace_id, array['OWNER']));

create policy profiles_select_coworkers on public.profiles
  for select to authenticated using (private.shares_workspace(account_id));

revoke all on all functions in schema private from public, anon;
grant execute on function private.is_active_member(uuid)        to authenticated;
grant execute on function private.has_role(uuid, text[])        to authenticated;
grant execute on function private.shares_workspace(uuid)        to authenticated;
