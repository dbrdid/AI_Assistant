-- =====================================================================
-- 25. 프로젝트 팀원 · 프로젝트 초대 (프론트 화면 기준, 2026-11-15 결정)
--   화면: 프로젝트 상세 "팀원 N명" → 팀원 관리(이름·역할 수정, 다른 프로젝트로 이동, 삭제) / 팀원 초대(메일·링크, 월 횟수)
--   - project_members: 프로젝트마다 팀원 목록. 이름(20자)·역할(1~12자, 팀장·팀원·직접 입력)은 화면 표시용
--       권한은 지금처럼 공간 역할(OWNER·EDITOR·VIEWER)로만 판단 (화면에도 역할별 권한 없음)
--       계정과 연결(account_id)은 초대로 들어온 사람만. 쓰기는 sync_push(엔티티 project_members)로만
--       "팀장을 모두 지울 수 없음"은 화면처럼 앱에서 검사 (서버는 막지 않음)
--   - project_invites: 프로젝트 초대 (메일·링크). 공간 초대 코드를 그대로 만들어 씀 (EDITOR, 1명)
--       공간 EDITOR 이상이면 만들 수 있음 (공간 초대 create_invite는 그대로 OWNER만)
--       이번 달 초대 횟수 한도 (FREE 10 / PRO 50, private.project_invite_monthly_limit에서 바꿈)
--       메일 실제 발송은 아직 없음 (이메일 초대는 동결 뒤) → 코드를 돌려주고 앱이 공유
--   - join_with_invite(code): accept_invite + 초대받은 프로젝트에 '팀원'으로 추가 (이미 공간 멤버여도)
--   기존 project_participants는 그대로 둠 (앱 화면은 project_members를 씀)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 프로젝트 팀원
-- ---------------------------------------------------------------------
create table public.project_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  project_id    uuid not null,
  account_id    uuid references public.accounts (id) on delete restrict,
  name          text not null check (char_length(btrim(name)) between 1 and 20),
  role          text not null default '팀원' check (char_length(btrim(role)) between 1 and 12),
  position      integer not null default 0,
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.accounts (id) on delete restrict,
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade,
  constraint project_members_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);
comment on table public.project_members is '프로젝트 팀원 (화면 표시용 이름·역할). 권한은 workspace_members 역할로 판단';
comment on column public.project_members.role is '팀장·팀원 또는 직접 입력(예: 디자이너). 권한 아님';
comment on column public.project_members.account_id is '초대로 들어온 계정. null이면 이름만 있는 팀원';
-- 한 프로젝트에 같은 계정은 한 번만 (휴지통에 간 것 제외)
create unique index project_members_account_uidx on public.project_members (project_id, account_id)
  where account_id is not null and deleted_at is null;
create index project_members_project_idx on public.project_members (workspace_id, project_id);
create index project_members_account_idx on public.project_members (account_id) where account_id is not null;
create index project_members_created_by_idx on public.project_members (created_by);
create index project_members_deleted_by_idx on public.project_members (deleted_by) where deleted_by is not null;
create trigger project_members_bump_revision before update on public.project_members
  for each row execute function private.bump_revision();

alter table public.project_members enable row level security;
revoke all on public.project_members from anon;
revoke insert, update, delete on public.project_members from authenticated;
create policy project_members_select_member on public.project_members
  for select to authenticated using (private.is_active_member(workspace_id));

-- ---------------------------------------------------------------------
-- 2. 프로젝트 초대
-- ---------------------------------------------------------------------
create table public.project_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  project_id    uuid not null,
  invite_id     uuid not null unique references public.workspace_invites (id) on delete cascade,
  method        text not null check (method in ('EMAIL', 'LINK')),
  email         text check (email = lower(email) and char_length(email) <= 254),
  status        text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REVOKED')),
  expires_at    timestamptz not null,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  accepted_by   uuid references public.accounts (id) on delete restrict,
  accepted_at   timestamptz,
  member_id     uuid references public.project_members (id) on delete set null,
  revoked_at    timestamptz,
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade,
  constraint project_invites_email_method check ((method = 'EMAIL') = (email is not null)),
  constraint project_invites_accepted_fields check ((status = 'ACCEPTED') = (accepted_at is not null and accepted_by is not null)),
  constraint project_invites_revoked_fields check ((status = 'REVOKED') = (revoked_at is not null))
);
comment on table public.project_invites is '프로젝트 초대 (화면의 "초대 대기"). 코드는 workspace_invites에 해시로만. 기간이 지나면 앱이 EXPIRED로 표시';
create index project_invites_project_idx on public.project_invites (workspace_id, project_id);
create index project_invites_created_by_idx on public.project_invites (created_by, created_at);
create index project_invites_accepted_by_idx on public.project_invites (accepted_by) where accepted_by is not null;
create index project_invites_member_idx on public.project_invites (member_id) where member_id is not null;

alter table public.project_invites enable row level security;
revoke all on public.project_invites from anon;
revoke insert, update, delete on public.project_invites from authenticated;
create policy project_invites_select_member on public.project_invites
  for select to authenticated using (private.is_active_member(workspace_id));

-- 원장에 두 테이블 추가
alter table public.workspace_changes drop constraint workspace_changes_entity_table_check;
alter table public.workspace_changes add constraint workspace_changes_entity_table_check
  check (entity_table in (
    'projects', 'project_participants', 'input_sources', 'source_text_versions',
    'notes', 'note_projects', 'tasks', 'events',
    'meetings', 'agenda_items', 'agenda_transitions', 'workspace_members', 'assets',
    'note_attachments', 'project_members', 'project_invites'));

-- 공간 초대가 다른 경로로 취소되면(OWNER 강등·나가기·내보내기 등) 프로젝트 초대도 취소 표시
--   (원장 기록은 하지 않음: 잠금 순서를 건드리지 않으려고. 다른 기기는 다음 전체 받기 때 반영)
create or replace function private.sync_project_invite_status()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'REVOKED' and old.status is distinct from 'REVOKED' then
    update public.project_invites set status = 'REVOKED', revoked_at = coalesce(new.revoked_at, now())
     where invite_id = new.id and status = 'PENDING';
  end if;
  return new;
end $$;
create trigger workspace_invites_project_status after update of status on public.workspace_invites
  for each row execute function private.sync_project_invite_status();

-- ---------------------------------------------------------------------
-- 3. 도우미
-- ---------------------------------------------------------------------
-- 이번 달 프로젝트 초대 한도 (가짜 결제 요금제 기준). 바꾸려면 여기만
create or replace function private.project_invite_monthly_limit(p_plan text)
returns integer language sql immutable set search_path = '' as $$
  select case p_plan when 'PRO' then 50 else 10 end
$$;

-- 이번 달(한국 시간) 내가 만든 프로젝트 초대 수와 한도
create or replace function private.project_invite_quota(p_account uuid)
returns jsonb language sql stable set search_path = '' as $$
  with p as (
    select coalesce((select s.plan from public.subscriptions s where s.account_id = p_account and s.status = 'ACTIVE'), 'FREE') as plan,
           (date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as since
  ), u as (
    select count(*)::int as used from public.project_invites i, p where i.created_by = p_account and i.created_at >= p.since
  )
  select jsonb_build_object('plan', p.plan, 'limit', private.project_invite_monthly_limit(p.plan), 'used', u.used,
                            'remaining', greatest(private.project_invite_monthly_limit(p.plan) - u.used, 0),
                            'period_start', p.since)
    from p, u
$$;

-- RPC가 직접 바꾼 행 1건을 원장에 기록 (호출 전에 공간 잠금 필요). seq를 돌려줌
create or replace function private.log_row_change(p_workspace_id uuid, p_entity text, p_key text, p_data jsonb, p_actor uuid)
returns bigint language plpgsql set search_path = '' as $$
declare v_seq bigint;
begin
  update public.workspace_sync_heads
     set last_seq = last_seq + 1, updated_at = now()
   where workspace_id = p_workspace_id
  returning last_seq into v_seq;
  insert into public.workspace_changes
    (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
  values
    (p_workspace_id, v_seq, p_entity, p_key, 'UPSERT', (p_data ->> 'revision')::bigint, p_data, null, p_actor);
  return v_seq;
end $$;

revoke all on function private.project_invite_monthly_limit(text), private.project_invite_quota(uuid),
  private.log_row_change(uuid, text, text, jsonb, uuid), private.sync_project_invite_status()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. 프로젝트 초대 RPC
-- ---------------------------------------------------------------------

/** 이번 달 프로젝트 초대 횟수 (화면: "이번 달 남은 초대 횟수 n / 한도") */
create or replace function public.get_project_invite_quota()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  return private.project_invite_quota(v_uid);
end $$;

/** 프로젝트 초대 만들기 (공간 OWNER·EDITOR). 반환 code는 이때 한 번만 받을 수 있음 */
create or replace function public.create_project_invite(
  p_project_id        uuid,
  p_method            text,                 -- 'EMAIL' | 'LINK'
  p_email             text    default null, -- EMAIL일 때 필수
  p_expires_in_hours  integer default 168
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := (select auth.uid());
  v_ws      uuid;
  v_email   text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_quota   jsonb;
  v_code    text;
  v_inv     public.workspace_invites%rowtype;
  v_pi      public.project_invites%rowtype;
  v_pending integer;
  v_try     integer := 0;
  v_seq     bigint;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_project_id is null then
    raise exception 'INVALID_REQUEST: project_id가 필요합니다' using errcode = '22023';
  end if;
  if p_method is null or p_method not in ('EMAIL', 'LINK') then
    raise exception 'INVALID_REQUEST: 초대 방법은 EMAIL 또는 LINK입니다' using errcode = '22023';
  end if;
  if p_method = 'EMAIL' and (v_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' or char_length(v_email) > 254) then
    raise exception 'INVALID_EMAIL: 이메일 형식이 올바르지 않습니다' using errcode = '22023';
  end if;
  if p_method = 'LINK' then v_email := null; end if;
  if p_expires_in_hours is null or p_expires_in_hours not between 1 and 720 then
    raise exception 'INVALID_REQUEST: 유효 기간은 1~720시간(30일)입니다' using errcode = '22023';
  end if;

  select workspace_id into v_ws from public.projects where id = p_project_id and deleted_at is null;
  if v_ws is null or not private.is_active_member(v_ws) then
    raise exception 'NOT_FOUND: 프로젝트가 없습니다' using errcode = '22023';
  end if;
  if not private.has_role(v_ws, array['OWNER', 'EDITOR']) then
    raise exception 'FORBIDDEN: 보기 전용 멤버는 초대할 수 없습니다' using errcode = '42501';
  end if;

  -- 잠금 순서: 공간(sync_head) → 초대. 같은 사람의 월 한도 계산은 한 줄로
  perform private.lock_workspace_head(v_ws);
  perform pg_advisory_xact_lock(hashtextextended('project_invite:' || v_uid::text, 0));

  v_quota := private.project_invite_quota(v_uid);
  if (v_quota ->> 'remaining')::int <= 0 then
    raise exception 'INVITE_LIMIT: 이번 달 초대 횟수(%회)를 모두 사용했습니다', v_quota ->> 'limit' using errcode = '22023';
  end if;

  select count(*) into v_pending from public.workspace_invites
   where workspace_id = v_ws and status = 'PENDING' and expires_at > now();
  if v_pending >= 20 then
    raise exception 'TOO_MANY_INVITES: 사용 가능한 초대는 20개까지입니다. 안 쓰는 초대를 취소한 뒤 다시 만드세요' using errcode = '22023';
  end if;
  if v_email is not null and exists (
       select 1 from public.project_invites
        where project_id = p_project_id and email = v_email and status = 'PENDING' and expires_at > now()) then
    raise exception 'ALREADY_INVITED: 이미 초대한 이메일입니다' using errcode = '22023';
  end if;

  loop
    v_try  := v_try + 1;
    v_code := private.new_invite_code();
    begin
      insert into public.workspace_invites (workspace_id, role, token_hash, invited_by, expires_at, max_uses)
      values (v_ws, 'EDITOR', private.invite_code_hash(v_code), v_uid, now() + make_interval(hours => p_expires_in_hours), 1)
      returning * into v_inv;
      exit;
    exception when unique_violation then
      if v_try >= 3 then raise; end if;
    end;
  end loop;

  insert into public.project_invites (workspace_id, project_id, invite_id, method, email, expires_at, created_by)
  values (v_ws, p_project_id, v_inv.id, p_method, v_email, v_inv.expires_at, v_uid)
  returning * into v_pi;
  v_seq := private.log_row_change(v_ws, 'project_invites', v_pi.id::text, to_jsonb(v_pi), v_uid);

  return jsonb_build_object(
    'project_invite_id', v_pi.id,
    'project_id',        p_project_id,
    'workspace_id',      v_ws,
    'code',              substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5),
    'method',            v_pi.method,
    'email',             v_pi.email,
    'expires_at',        v_pi.expires_at,
    'seq',               v_seq,
    'quota',             private.project_invite_quota(v_uid));
end $$;

/** 프로젝트 초대 취소 (만든 사람 또는 OWNER). 여러 번 불러도 같은 결과 */
create or replace function public.revoke_project_invite(p_project_invite_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_pi  public.project_invites%rowtype;
  v_seq bigint;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  select * into v_pi from public.project_invites where id = p_project_invite_id;
  if not found or not private.is_active_member(v_pi.workspace_id) then
    raise exception 'NOT_FOUND: 초대가 없습니다' using errcode = '22023';
  end if;
  if v_pi.created_by <> v_uid and not private.has_role(v_pi.workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: 초대한 사람이나 관리자만 취소할 수 있습니다' using errcode = '42501';
  end if;

  perform private.lock_workspace_head(v_pi.workspace_id);
  select * into v_pi from public.project_invites where id = p_project_invite_id for update;
  if v_pi.status <> 'PENDING' then
    return jsonb_build_object('project_invite_id', v_pi.id, 'status', v_pi.status, 'unchanged', true);
  end if;
  update public.workspace_invites set status = 'REVOKED', revoked_at = now()
   where id = v_pi.invite_id and status = 'PENDING';
  update public.project_invites set status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
   where id = v_pi.id returning * into v_pi;
  v_seq := private.log_row_change(v_pi.workspace_id, 'project_invites', v_pi.id::text, to_jsonb(v_pi), v_uid);
  return jsonb_build_object('project_invite_id', v_pi.id, 'status', v_pi.status, 'seq', v_seq);
end $$;

/**
 * 초대 코드로 참여 + 초대받은 프로젝트에 '팀원'으로 추가
 *   공간 초대 코드도 그대로 받음 (프로젝트가 없으면 accept_invite와 같은 결과)
 *   이미 공간 멤버면 공간은 그대로, 프로젝트에만 추가하고 그 코드는 사용 완료로
 */
create or replace function public.join_with_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_norm   text := private.normalize_invite_code(p_code);
  v_inv_id uuid;
  v_res    jsonb;
  v_pi     public.project_invites%rowtype;
  v_mem    public.project_members%rowtype;
  v_name   text;
  v_out    jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if v_norm is not null then
    select id into v_inv_id from public.workspace_invites where token_hash = private.invite_code_hash(v_norm);
  end if;

  v_res := public.accept_invite(p_code);   -- 코드 검사·공간 참여 (공간 잠금도 여기서 잡힘)

  select left(coalesce(nullif(btrim(p.display_name), ''), split_part(a.email, '@', 1), '팀원'), 20)
    into v_name
    from public.accounts a left join public.profiles p on p.account_id = a.id
   where a.id = v_uid;
  v_name := coalesce(nullif(btrim(v_name), ''), '팀원');

  for v_pi in
    select * from public.project_invites where invite_id = v_inv_id and status = 'PENDING' for update
  loop
    v_mem := null;
    if exists (select 1 from public.projects where id = v_pi.project_id and deleted_at is null) then
      select * into v_mem from public.project_members
       where project_id = v_pi.project_id and account_id = v_uid and deleted_at is null;
      if not found then
        insert into public.project_members (workspace_id, project_id, account_id, name, role, position, created_by)
        values (v_pi.workspace_id, v_pi.project_id, v_uid, v_name, '팀원',
                coalesce((select max(position) + 1 from public.project_members where project_id = v_pi.project_id), 0), v_uid)
        returning * into v_mem;
        perform private.log_row_change(v_pi.workspace_id, 'project_members', v_mem.id::text, to_jsonb(v_mem), v_uid);
      end if;
    end if;
    update public.project_invites
       set status = 'ACCEPTED', accepted_by = v_uid, accepted_at = now(), member_id = v_mem.id
     where id = v_pi.id returning * into v_pi;
    perform private.log_row_change(v_pi.workspace_id, 'project_invites', v_pi.id::text, to_jsonb(v_pi), v_uid);
    v_out := v_out || jsonb_build_object('project_id', v_pi.project_id, 'member_id', v_mem.id);
  end loop;

  -- 이미 공간 멤버라 accept_invite가 코드를 안 썼으면, 프로젝트 초대 코드는 여기서 사용 완료로
  if jsonb_array_length(v_out) > 0 and (v_res ->> 'already_member')::boolean then
    update public.workspace_invites
       set use_count = max_uses, status = 'ACCEPTED', accepted_by = v_uid, accepted_at = now()
     where id = v_inv_id and status = 'PENDING';
  end if;

  return v_res || jsonb_build_object('projects', v_out,
    'last_seq', (select last_seq from public.workspace_sync_heads where workspace_id = (v_res ->> 'workspace_id')::uuid));
end $$;

revoke all on function public.get_project_invite_quota(), public.create_project_invite(uuid, text, text, integer),
  public.revoke_project_invite(uuid), public.join_with_invite(text) from public, anon;
grant execute on function public.get_project_invite_quota(), public.create_project_invite(uuid, text, text, integer),
  public.revoke_project_invite(uuid), public.join_with_invite(text) to authenticated;
comment on function public.create_project_invite(uuid, text, text, integer) is
  '프로젝트 초대 (공간 OWNER·EDITOR, 월 한도). code는 이때 한 번만. 메일 발송은 아직 없음';
comment on function public.join_with_invite(text) is
  '초대 코드로 참여 + 초대받은 프로젝트에 팀원으로 추가. 공간 초대 코드도 받음';

-- ---------------------------------------------------------------------
-- 5. sync_push · sync_snapshot: 서버에 있는 지금 함수(#22·#9)에 바뀐 부분만 적용
--    sync_push: 엔티티 project_members 추가 (계정 연결 검사, 만들기·수정·이동). 나머지는 그대로
--    sync_snapshot: project_members · project_invites 목록 추가
--    고칠 곳을 정확히 한 번 찾지 못하면 migration 전체가 실패 (반쯤 바뀌는 일 없음)
-- ---------------------------------------------------------------------
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.sync_push(uuid,uuid,jsonb,uuid)'::regprocedure);
  n := replace(d, $p$      when v_entity in ('notes', 'tasks', 'events', 'projects', 'meetings', 'agenda_items') then 'REV'$p$,
                 $p$      when v_entity in ('notes', 'tasks', 'events', 'projects', 'meetings', 'agenda_items', 'project_members') then 'REV'$p$);
  if n = d or (length(d) - length(replace(d, $p$      when v_entity in ('notes', 'tasks', 'events', 'projects', 'meetings', 'agenda_items') then 'REV'$p$, ''))) <> length($p$      when v_entity in ('notes', 'tasks', 'events', 'projects', 'meetings', 'agenda_items') then 'REV'$p$) then
    raise exception 'public.sync_push(uuid,uuid,jsonb,uuid) 고칠 곳 1을(를) 정확히 한 번 찾지 못했습니다';
  end if;
  d := n;
  n := replace(d, $p$        -- 담당자는 지금 ACTIVE 멤버여야 함
        if v_entity = 'tasks'$p$,
                 $p$        -- 프로젝트 팀원에 계정을 연결하면 지금 ACTIVE 멤버여야 함
        if v_entity = 'project_members' and v_data ? 'account_id' and v_data ->> 'account_id' is not null then
          v_assignee := (v_data ->> 'account_id')::uuid;
          if not exists (select 1 from public.workspace_members
                          where workspace_id = p_workspace_id and account_id = v_assignee and status = 'ACTIVE') then
            raise exception 'INVALID_REQUEST: ops[%] 팀원으로 연결할 계정은 이 공간의 ACTIVE 멤버여야 합니다', i using errcode = '22023';
          end if;
        end if;
        -- 담당자는 지금 ACTIVE 멤버여야 함
        if v_entity = 'tasks'$p$);
  if n = d or (length(d) - length(replace(d, $p$        -- 담당자는 지금 ACTIVE 멤버여야 함
        if v_entity = 'tasks'$p$, ''))) <> length($p$        -- 담당자는 지금 ACTIVE 멤버여야 함
        if v_entity = 'tasks'$p$) then
    raise exception 'public.sync_push(uuid,uuid,jsonb,uuid) 고칠 곳 2을(를) 정확히 한 번 찾지 못했습니다';
  end if;
  d := n;
  n := replace(d, $p$    else  -- agenda_items
      if v_base is null then$p$,
                 $p$    elsif v_entity = 'project_members' then
      if v_base is null then
        insert into public.project_members as t (id, workspace_id, project_id, account_id, name, role, position, created_by)
        values (v_id, p_workspace_id,
                (v_data ->> 'project_id')::uuid,
                (v_data ->> 'account_id')::uuid,
                btrim(v_data ->> 'name'),
                coalesce(btrim(v_data ->> 'role'), '팀원'),
                coalesce((v_data ->> 'position')::integer, 0),
                v_uid)
        returning to_jsonb(t) into v_row;
      else
        -- project_id를 바꾸면 다른 프로젝트로 이동 (같은 공간 안에서만: 외래키가 검사)
        update public.project_members t
           set name       = case when v_data ? 'name'       then btrim(v_data ->> 'name') else t.name end,
               role       = case when v_data ? 'role'       then btrim(v_data ->> 'role') else t.role end,
               position   = case when v_data ? 'position'   then coalesce((v_data ->> 'position')::integer, 0) else t.position end,
               project_id = case when v_data ? 'project_id' then (v_data ->> 'project_id')::uuid else t.project_id end,
               account_id = case when v_data ? 'account_id' then (v_data ->> 'account_id')::uuid else t.account_id end
         where t.id = v_id and t.workspace_id = p_workspace_id
        returning to_jsonb(t) into v_row;
      end if;

    else  -- agenda_items
      if v_base is null then$p$);
  if n = d or (length(d) - length(replace(d, $p$    else  -- agenda_items
      if v_base is null then$p$, ''))) <> length($p$    else  -- agenda_items
      if v_base is null then$p$) then
    raise exception 'public.sync_push(uuid,uuid,jsonb,uuid) 고칠 곳 3을(를) 정확히 한 번 찾지 못했습니다';
  end if;
  d := n;
  execute d;

  d := pg_get_functiondef('public.sync_snapshot(uuid)'::regprocedure);
  n := replace(d, $p$    'projects',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.projects t             where t.workspace_id = p_workspace_id),$p$,
                 $p$    'projects',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.projects t             where t.workspace_id = p_workspace_id),
    'project_members',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_members t      where t.workspace_id = p_workspace_id),
    'project_invites',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_invites t      where t.workspace_id = p_workspace_id),$p$);
  if n = d or (length(d) - length(replace(d, $p$    'projects',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.projects t             where t.workspace_id = p_workspace_id),$p$, ''))) <> length($p$    'projects',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.projects t             where t.workspace_id = p_workspace_id),$p$) then
    raise exception 'public.sync_snapshot(uuid) 고칠 곳 1을(를) 정확히 한 번 찾지 못했습니다';
  end if;
  d := n;
  execute d;
end
$mig$;
