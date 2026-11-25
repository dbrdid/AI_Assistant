-- =====================================================================
-- 공간 결제 주체 · 멤버 만료 · 감사 기록 (11/25)
--   결제 주체 (Azure 구독 범위 · Notion 공간 구독 참고)
--     - 공간 요금제 = workspaces.billing_account_id 계정의 요금제. 그 계정이 ACTIVE OWNER가 아니면 FREE
--     - 기존 공간: 지금 혜택이 바뀌지 않게 '가장 높은 요금제의 OWNER'로 채움
--     - 새 공간: 처음 들어온 OWNER(만든 사람)
--     - 바꾸기: OWNER가 자기 자신으로만 가져감 (claim_workspace_billing). 다른 사람에게 결제를 떠넘기지 않음
--     - 결제 주체가 OWNER에서 내려오거나 나가면 비움 → FREE (다른 OWNER의 요금제로 조용히 바뀌지 않음)
--   멤버 만료 (Notion space_user.expiration_time 참고)
--     - OWNER가 EDITOR·VIEWER에게 expires_at 지정 (set_member_expiry). OWNER가 되거나 나가면 만료는 지워짐
--     - 매분 cron이 지난 멤버를 REMOVED로 바꿈 (내보내기와 같은 변경 기록·신호). 최대 1분 늦을 수 있음
--   감사 기록 (Azure Activity Log 참고): 결제 주체 지정·해제, 만료 지정·만료 처리. 공간 OWNER만 읽음
--   기기 동기화 계약(workspace_members 변경 기록의 칸)은 그대로
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 표
-- ---------------------------------------------------------------------
alter table public.workspaces
  add column billing_account_id uuid references public.accounts (id) on delete set null;
comment on column public.workspaces.billing_account_id is '공간 결제 주체. 이 계정이 ACTIVE OWNER일 때 그 요금제가 공간 요금제, 아니면 FREE';

alter table public.workspace_members add column expires_at timestamptz;
alter table public.workspace_members
  add constraint members_expiry_not_owner check (expires_at is null or role <> 'OWNER');
comment on column public.workspace_members.expires_at is '이 시각이 지나면 REMOVED (EDITOR·VIEWER만). null이면 만료 없음';
create index workspace_members_expiry_idx on public.workspace_members (expires_at)
  where status = 'ACTIVE' and expires_at is not null;

create table public.audit_logs (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  actor_id      uuid references public.accounts (id) on delete set null,   -- null = 시스템(cron·탈퇴 처리)
  action        text not null check (action in ('BILLING_ASSIGNED', 'BILLING_CLEARED', 'MEMBER_EXPIRY_SET', 'MEMBER_EXPIRED')),
  target_id     uuid,                                                      -- 대상 계정
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index audit_logs_workspace_idx on public.audit_logs (workspace_id, id desc);
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;
create policy audit_logs_owner_read on public.audit_logs for select to authenticated
  using (private.has_role(workspace_id, array['OWNER']));
comment on table public.audit_logs is '공간 관리 기록 (결제 주체·멤버 만료). 쓰기는 함수만, 읽기는 그 공간 OWNER';

create or replace function private.audit(p_workspace uuid, p_actor uuid, p_action text, p_target uuid, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (workspace_id, actor_id, action, target_id, detail)
  values (p_workspace, p_actor, p_action, p_target, coalesce(p_detail, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------
-- 2. 공간 요금제 = 결제 주체의 요금제
-- ---------------------------------------------------------------------
create or replace function private.workspace_plan(p_workspace uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.account_plan(w.billing_account_id)
      from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id and m.account_id = w.billing_account_id
     where w.id = p_workspace and m.role = 'OWNER' and m.status = 'ACTIVE'), 'FREE')
$$;

-- 기존 공간: 지금 혜택 그대로 (가장 높은 요금제의 OWNER, 같으면 먼저 들어온 사람)
update public.workspaces w
   set billing_account_id = (
         select m.account_id from public.workspace_members m
          where m.workspace_id = w.id and m.role = 'OWNER' and m.status = 'ACTIVE'
          order by private.plan_rank(private.account_plan(m.account_id)) desc, m.joined_at, m.account_id
          limit 1)
 where w.billing_account_id is null;

-- ---------------------------------------------------------------------
-- 3. 멤버 변경 → 결제 주체·만료 정리
-- ---------------------------------------------------------------------
create or replace function private.member_expiry_clear()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.role = 'OWNER' or new.status <> 'ACTIVE' then new.expires_at := null; end if;
  return new;
end $$;
create trigger workspace_members_expiry_clear before insert or update on public.workspace_members
  for each row execute function private.member_expiry_clear();

create or replace function private.member_billing()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- 새 공간의 첫 OWNER가 결제 주체
  if new.role = 'OWNER' and new.status = 'ACTIVE' then
    update public.workspaces set billing_account_id = new.account_id
     where id = new.workspace_id and billing_account_id is null
       and not exists (select 1 from public.workspace_members x
                        where x.workspace_id = new.workspace_id and x.account_id <> new.account_id);
    if found then
      perform private.audit(new.workspace_id, new.account_id, 'BILLING_ASSIGNED', new.account_id, '{"reason":"CREATED"}'::jsonb);
    end if;
  end if;
  -- 결제 주체가 OWNER에서 내려오거나 나감 → 비움 (공간은 FREE, 다른 OWNER가 가져가야 함)
  if tg_op = 'UPDATE' and old.role = 'OWNER' and old.status = 'ACTIVE' and (new.role <> 'OWNER' or new.status <> 'ACTIVE') then
    update public.workspaces set billing_account_id = null
     where id = new.workspace_id and billing_account_id = new.account_id;
    if found then
      perform private.audit(new.workspace_id, (select auth.uid()), 'BILLING_CLEARED', new.account_id,
        jsonb_build_object('reason', case when new.status <> 'ACTIVE' then new.status else 'ROLE_CHANGED' end));
    end if;
  end if;
  return null;
end $$;
create trigger workspace_members_billing after insert or update of role, status on public.workspace_members
  for each row execute function private.member_billing();

-- ---------------------------------------------------------------------
-- 4. 화면용 함수
-- ---------------------------------------------------------------------
/** OWNER가 자기 자신을 이 공간의 결제 주체로 (공간 요금제 = 내 요금제) */
create or replace function public.claim_workspace_billing(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  v_prev uuid;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  perform private.lock_workspace_head(p_workspace_id);
  if not private.has_role(p_workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: OWNER만 결제 주체가 될 수 있습니다' using errcode = '42501';
  end if;
  select billing_account_id into v_prev from public.workspaces where id = p_workspace_id for update;
  if v_prev is distinct from v_uid then
    update public.workspaces set billing_account_id = v_uid where id = p_workspace_id;
    perform private.audit(p_workspace_id, v_uid, 'BILLING_ASSIGNED', v_uid, jsonb_build_object('previous', v_prev));
  end if;
  return jsonb_build_object('workspace_id', p_workspace_id, 'billing_account_id', v_uid,
                            'plan', private.workspace_plan(p_workspace_id), 'unchanged', v_prev is not distinct from v_uid);
end $$;

/** 공간 결제 주체와 공간 요금제 (멤버면 누구나) */
create or replace function public.get_workspace_billing(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not private.has_role(p_workspace_id, array['OWNER', 'EDITOR', 'VIEWER']) then
    raise exception 'FORBIDDEN: 이 공간의 멤버가 아닙니다' using errcode = '42501';
  end if;
  return (select jsonb_build_object(
            'workspace_id', w.id, 'billing_account_id', w.billing_account_id,
            'billing_name', p.display_name, 'plan', private.workspace_plan(w.id),
            'is_me', w.billing_account_id = v_uid)
            from public.workspaces w left join public.profiles p on p.account_id = w.billing_account_id
           where w.id = p_workspace_id);
end $$;

/** OWNER가 EDITOR·VIEWER 멤버의 만료 시각을 정하거나(null이면) 없앰 */
create or replace function public.set_member_expiry(p_workspace_id uuid, p_account_id uuid, p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_mem public.workspace_members%rowtype;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'INVALID_REQUEST: 만료 시각은 지금 이후여야 합니다' using errcode = '22023';
  end if;
  perform private.lock_workspace_head(p_workspace_id);
  if not private.has_role(p_workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: OWNER만 만료를 정할 수 있습니다' using errcode = '42501';
  end if;
  select * into v_mem from public.workspace_members
   where workspace_id = p_workspace_id and account_id = p_account_id for update;
  if not found or v_mem.status <> 'ACTIVE' then
    raise exception 'NOT_FOUND: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '22023';
  end if;
  if v_mem.role = 'OWNER' then
    raise exception 'INVALID_REQUEST: OWNER에게는 만료를 둘 수 없습니다' using errcode = '22023';
  end if;
  update public.workspace_members set expires_at = p_expires_at
   where workspace_id = p_workspace_id and account_id = p_account_id;
  perform private.audit(p_workspace_id, v_uid, 'MEMBER_EXPIRY_SET', p_account_id,
    jsonb_build_object('expires_at', p_expires_at, 'previous', v_mem.expires_at));
  return jsonb_build_object('workspace_id', p_workspace_id, 'account_id', p_account_id, 'expires_at', p_expires_at);
end $$;

-- ---------------------------------------------------------------------
-- 5. 만료 처리 (매분)
-- ---------------------------------------------------------------------
create or replace function private.expire_members()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m record;
  n integer := 0;
begin
  for m in
    select workspace_id, account_id from public.workspace_members
     where status = 'ACTIVE' and expires_at is not null and expires_at <= now()
     order by workspace_id, account_id
  loop
    perform private.lock_workspace_head(m.workspace_id);
    update public.workspace_members set status = 'REMOVED', ended_at = now()
     where workspace_id = m.workspace_id and account_id = m.account_id
       and status = 'ACTIVE' and expires_at is not null and expires_at <= now();
    if found then
      perform private.log_member_change(m.workspace_id, m.account_id, null);
      perform private.audit(m.workspace_id, null, 'MEMBER_EXPIRED', m.account_id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

select cron.schedule('workspace-members-expire', '* * * * *', 'select private.expire_members()');

-- ---------------------------------------------------------------------
-- 6. 실행 권한
-- ---------------------------------------------------------------------
revoke all on function private.audit(uuid, uuid, text, uuid, jsonb), private.member_expiry_clear(), private.member_billing(),
  private.expire_members() from public, anon, authenticated;
revoke all on function public.claim_workspace_billing(uuid), public.get_workspace_billing(uuid),
  public.set_member_expiry(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.claim_workspace_billing(uuid), public.get_workspace_billing(uuid),
  public.set_member_expiry(uuid, uuid, timestamptz) to authenticated;
