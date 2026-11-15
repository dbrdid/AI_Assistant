-- =====================================================================
-- 16. 공간 초대 · 멤버 관리
--   초대는 이메일 대신 "초대 코드(링크)" 방식 (SMTP 보류 중)
--     - 코드 원문은 만들 때 한 번만 돌려주고, DB에는 sha256 해시(token_hash)만 저장
--     - 코드 하나에 역할(EDITOR/VIEWER) · 유효 기간(1시간~30일) · 사용 횟수(1~50명)를 정해 둠
--     - 다 쓰면 ACCEPTED, 취소하면 REVOKED, 기간이 지나면 EXPIRED
--   RPC (모두 로그인 사용자 전용)
--     create_invite / revoke_invite        : OWNER
--     preview_invite / accept_invite       : 코드를 가진 사람
--     leave_workspace                      : 본인
--     change_member_role / remove_member   : OWNER
--     delete_workspace                     : OWNER (휴지통 처리, 혼자 남은 OWNER가 정리할 때)
--   멤버 변화(참여·역할 변경·나가기·내보내기)는 workspace_changes에 기록 → 다른 기기가 sync_pull로 받음
--   잠금 순서는 sync_push와 같게: workspace_sync_heads → workspace_invites → workspace_members → workspaces
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 테이블 변경
-- ---------------------------------------------------------------------
alter table public.workspace_invites
  alter column invitee_email drop not null,
  add column max_uses  integer not null default 1 check (max_uses between 1 and 50),
  add column use_count integer not null default 0,
  add constraint invites_use_count_range check (use_count between 0 and max_uses),
  add constraint invites_accepted_means_used_up check (status <> 'ACCEPTED' or use_count = max_uses),
  add constraint invites_revoked_fields check ((status = 'REVOKED') = (revoked_at is not null));

comment on column public.workspace_invites.invitee_email is '이메일 초대용(후속). 코드 초대는 null';
comment on column public.workspace_invites.token_hash   is '초대 코드(정규화: 대문자, 기호 제거)의 sha256 hex. 원문은 저장하지 않음';
comment on column public.workspace_invites.accepted_by  is '마지막 사용자 (사용 횟수를 다 써서 ACCEPTED가 될 때 기록)';
comment on column public.workspace_invites.max_uses     is '이 코드로 들어올 수 있는 사람 수';

alter table public.workspace_members
  add column invite_id uuid references public.workspace_invites (id) on delete set null;
comment on column public.workspace_members.invite_id is '마지막으로 참여할 때 쓴 초대';
create index workspace_members_invite_idx on public.workspace_members (invite_id) where invite_id is not null;

create index workspace_invites_invited_by_idx  on public.workspace_invites (invited_by);
create index workspace_invites_accepted_by_idx on public.workspace_invites (accepted_by) where accepted_by is not null;

-- 앱에서 초대 목록을 볼 때 token_hash는 안 보이게 (OWNER 조회 정책은 그대로)
revoke select on public.workspace_invites from authenticated;
grant select (id, workspace_id, invitee_email, role, status, invited_by, expires_at,
              accepted_by, accepted_at, revoked_at, created_at, max_uses, use_count)
  on public.workspace_invites to authenticated;

-- 새 멤버가 들어올 때도 auth_epoch + 1 (기존: 역할·상태 변경 때만)
create or replace function private.bump_auth_epoch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.workspaces set auth_epoch = auth_epoch + 1 where id = old.workspace_id;
    return old;
  end if;
  if tg_op = 'INSERT'
     or new.role is distinct from old.role
     or new.status is distinct from old.status then
    update public.workspaces set auth_epoch = auth_epoch + 1 where id = new.workspace_id;
  end if;
  return new;
end $$;

drop trigger workspace_members_bump_epoch on public.workspace_members;
create trigger workspace_members_bump_epoch
  after insert or update or delete on public.workspace_members
  for each row execute function private.bump_auth_epoch();

-- ---------------------------------------------------------------------
-- 2. 내부 헬퍼
-- ---------------------------------------------------------------------

-- 초대 코드: 헷갈리는 글자(0 O 1 I L) 뺀 31자 중 10자 ≈ 8×10^14 가지. 난수는 gen_random_uuid(강한 난수)
create or replace function private.new_invite_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  c_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code  text := '';
  v_b     integer;
  i       integer;
begin
  while char_length(v_code) < 10 loop
    v_bytes := uuid_send(gen_random_uuid());
    for i in 0 .. 15 loop
      continue when i in (6, 8);   -- 버전·변형 비트가 섞인 바이트는 건너뜀
      v_b := get_byte(v_bytes, i);
      continue when v_b >= 248;    -- 31의 배수(248) 미만만 써서 글자별 확률을 같게
      v_code := v_code || substr(c_alpha, (v_b % 31) + 1, 1);
      exit when char_length(v_code) = 10;
    end loop;
  end loop;
  return v_code;
end $$;

-- 사용자가 입력·붙여넣은 코드 정규화: 대문자, 영숫자만. 형식이 틀리면 null
create or replace function private.normalize_invite_code(p_code text)
returns text language sql immutable set search_path = '' as $$
  select case when n ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$' then n end
    from (select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')) as n) s;
$$;

create or replace function private.invite_code_hash(p_normalized text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_normalized, 'UTF8')), 'hex');
$$;

-- 멤버 변화 1건을 동기화 원장에 기록하고 seq를 돌려줌
--   호출 전에 workspace_sync_heads 행을 FOR UPDATE로 잠가 둘 것 (seq 순서 = 커밋 순서)
--   data 형식 = sync_snapshot의 members 항목 + workspace_id·joined_at·ended_at
create or replace function private.log_member_change(p_workspace_id uuid, p_account_id uuid, p_actor uuid)
returns bigint language plpgsql set search_path = '' as $$
declare
  v_seq  bigint;
  v_data jsonb;
begin
  update public.workspace_sync_heads
     set last_seq = last_seq + 1, updated_at = now()
   where workspace_id = p_workspace_id
  returning last_seq into v_seq;

  select jsonb_build_object(
           'workspace_id', m.workspace_id, 'account_id', m.account_id,
           'role', m.role, 'status', m.status,
           'joined_at', m.joined_at, 'ended_at', m.ended_at,
           'display_name', p.display_name, 'avatar_path', p.avatar_path)
    into v_data
    from public.workspace_members m
    left join public.profiles p on p.account_id = m.account_id
   where m.workspace_id = p_workspace_id and m.account_id = p_account_id;

  insert into public.workspace_changes
    (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
  values
    (p_workspace_id, v_seq, 'workspace_members', p_account_id::text, 'UPSERT', null, v_data, null, p_actor);
  return v_seq;
end $$;

-- OWNER가 아니게 된 사람(강등·나감·내보냄)이 만든 사용 가능한 초대는 함께 취소
create or replace function private.revoke_invites_by(p_workspace_id uuid, p_account_id uuid)
returns integer language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  update public.workspace_invites
     set status = 'REVOKED', revoked_at = now()
   where workspace_id = p_workspace_id and invited_by = p_account_id and status = 'PENDING';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 공간 잠금 + 존재 확인 (삭제된 공간이면 NOT_FOUND)
create or replace function private.lock_workspace_head(p_workspace_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform 1 from public.workspace_sync_heads h
    join public.workspaces w on w.id = h.workspace_id
   where h.workspace_id = p_workspace_id and w.deleted_at is null
     for update of h;
  if not found then
    raise exception 'NOT_FOUND: 공간이 없습니다' using errcode = '22023';
  end if;
end $$;

revoke all on function private.new_invite_code()                   from public, anon, authenticated;
revoke all on function private.normalize_invite_code(text)         from public, anon, authenticated;
revoke all on function private.invite_code_hash(text)              from public, anon, authenticated;
revoke all on function private.log_member_change(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.revoke_invites_by(uuid, uuid)       from public, anon, authenticated;
revoke all on function private.lock_workspace_head(uuid)           from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. 초대 만들기 / 취소 (OWNER)
-- ---------------------------------------------------------------------
create or replace function public.create_invite(
  p_workspace_id      uuid,
  p_role              text    default 'EDITOR',
  p_expires_in_hours  integer default 168,
  p_max_uses          integer default 1
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := (select auth.uid());
  v_code     text;
  v_inv      public.workspace_invites%rowtype;
  v_pending  integer;
  v_try      integer := 0;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_workspace_id is null then
    raise exception 'INVALID_REQUEST: workspace_id가 필요합니다' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('EDITOR', 'VIEWER') then
    raise exception 'INVALID_REQUEST: 초대 역할은 EDITOR 또는 VIEWER입니다 (OWNER는 참여 후 역할 변경으로)' using errcode = '22023';
  end if;
  if p_expires_in_hours is null or p_expires_in_hours not between 1 and 720 then
    raise exception 'INVALID_REQUEST: 유효 기간은 1~720시간(30일)입니다' using errcode = '22023';
  end if;
  if p_max_uses is null or p_max_uses not between 1 and 50 then
    raise exception 'INVALID_REQUEST: 사용 인원은 1~50명입니다' using errcode = '22023';
  end if;
  if not private.has_role(p_workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: OWNER만 초대할 수 있습니다' using errcode = '42501';
  end if;

  -- 같은 공간의 초대 만들기를 한 줄로 (개수 제한 경합 방지). FK 검사(KEY SHARE)와는 충돌하지 않는 잠금
  perform 1 from public.workspaces where id = p_workspace_id for no key update;

  -- 기간 지난 초대 정리 (수락 중이라 잠긴 행은 건너뜀)
  update public.workspace_invites
     set status = 'EXPIRED'
   where id in (select id from public.workspace_invites
                 where workspace_id = p_workspace_id and status = 'PENDING' and expires_at <= now()
                   for update skip locked);

  select count(*) into v_pending
    from public.workspace_invites
   where workspace_id = p_workspace_id and status = 'PENDING';
  if v_pending >= 20 then
    raise exception 'TOO_MANY_INVITES: 사용 가능한 초대는 20개까지입니다. 안 쓰는 초대를 취소한 뒤 다시 만드세요';
  end if;

  loop
    v_try  := v_try + 1;
    v_code := private.new_invite_code();
    begin
      insert into public.workspace_invites (workspace_id, role, token_hash, invited_by, expires_at, max_uses)
      values (p_workspace_id, p_role, private.invite_code_hash(v_code), v_uid,
              now() + make_interval(hours => p_expires_in_hours), p_max_uses)
      returning * into v_inv;
      exit;
    exception when unique_violation then
      if v_try >= 3 then raise; end if;   -- 해시 충돌(사실상 없음) 시 새 코드로 재시도
    end;
  end loop;

  return jsonb_build_object(
    'invite_id',    v_inv.id,
    'workspace_id', v_inv.workspace_id,
    'code',         substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5),
    'role',         v_inv.role,
    'expires_at',   v_inv.expires_at,
    'max_uses',     v_inv.max_uses);
end $$;

comment on function public.create_invite(uuid, text, integer, integer) is
  '초대 코드 만들기 (OWNER). 반환 code는 이때 한 번만 받을 수 있음 → 잃어버리면 새로 만들기';

create or replace function public.revoke_invite(p_invite_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_inv public.workspace_invites%rowtype;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select * into v_inv from public.workspace_invites where id = p_invite_id for update;
  if not found or not private.is_active_member(v_inv.workspace_id) then
    raise exception 'NOT_FOUND: 초대가 없습니다' using errcode = '22023';
  end if;
  if not private.has_role(v_inv.workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: OWNER만 초대를 취소할 수 있습니다' using errcode = '42501';
  end if;

  if v_inv.status = 'PENDING' then
    update public.workspace_invites
       set status = 'REVOKED', revoked_at = now()
     where id = p_invite_id
    returning * into v_inv;
  end if;
  -- 이미 취소·만료·사용 완료면 그대로 (여러 번 눌러도 같은 결과)
  return jsonb_build_object('invite_id', v_inv.id, 'status', v_inv.status);
end $$;

-- ---------------------------------------------------------------------
-- 4. 초대 미리보기 / 수락 (코드를 가진 로그인 사용자)
-- ---------------------------------------------------------------------

-- 코드로 초대를 찾아 상태를 검사. 쓸 수 없으면 예외. p_lock이면 행을 잠금
create or replace function private.find_usable_invite(p_code text, p_lock boolean)
returns public.workspace_invites language plpgsql set search_path = '' as $$
declare
  v_norm text := private.normalize_invite_code(p_code);
  v_inv  public.workspace_invites%rowtype;
begin
  if v_norm is null then
    raise exception 'INVITE_INVALID: 초대 코드 형식이 올바르지 않습니다' using errcode = '22023';
  end if;

  if p_lock then
    select * into v_inv from public.workspace_invites where token_hash = private.invite_code_hash(v_norm) for update;
  else
    select * into v_inv from public.workspace_invites where token_hash = private.invite_code_hash(v_norm);
  end if;

  if not found or exists (select 1 from public.workspaces where id = v_inv.workspace_id and deleted_at is not null) then
    raise exception 'INVITE_INVALID: 초대를 찾을 수 없습니다' using errcode = '22023';
  end if;
  if v_inv.status = 'REVOKED' then
    raise exception 'INVITE_REVOKED: 취소된 초대입니다' using errcode = '22023';
  end if;
  if v_inv.status = 'ACCEPTED' then
    raise exception 'INVITE_USED_UP: 정해진 인원이 모두 참여한 초대입니다' using errcode = '22023';
  end if;
  if v_inv.status = 'EXPIRED' or v_inv.expires_at <= now() then
    raise exception 'INVITE_EXPIRED: 기간이 지난 초대입니다' using errcode = '22023';
  end if;
  return v_inv;
end $$;
revoke all on function private.find_usable_invite(text, boolean) from public, anon, authenticated;

create or replace function public.preview_invite(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  v_inv  public.workspace_invites%rowtype;
  v_mem  public.workspace_members%rowtype;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  v_inv := private.find_usable_invite(p_code, false);

  select * into v_mem from public.workspace_members
   where workspace_id = v_inv.workspace_id and account_id = v_uid;

  return jsonb_build_object(
    'workspace_id',    v_inv.workspace_id,
    'workspace_name',  (select name from public.workspaces where id = v_inv.workspace_id),
    'role',            v_inv.role,
    'invited_by_name', (select nullif(display_name, '') from public.profiles where account_id = v_inv.invited_by),
    'expires_at',      v_inv.expires_at,
    'member_count',    (select count(*) from public.workspace_members
                         where workspace_id = v_inv.workspace_id and status = 'ACTIVE'),
    'already_member',  coalesce(v_mem.status = 'ACTIVE', false),
    'my_role',         case when v_mem.status = 'ACTIVE' then v_mem.role end,
    'blocked',         coalesce(v_mem.status = 'REMOVED' and v_inv.created_at <= v_mem.ended_at, false));
end $$;

comment on function public.preview_invite(text) is
  '수락 전 확인 화면용: 공간 이름·역할·초대한 사람·현재 인원. blocked=true면 내보내진 뒤 만든 초대가 아니라 참여 불가';

create or replace function public.accept_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_inv   public.workspace_invites%rowtype;
  v_mem   public.workspace_members%rowtype;
  v_seq   bigint;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not exists (select 1 from public.accounts where id = v_uid and status = 'ACTIVE') then
    raise exception 'FORBIDDEN: 사용할 수 없는 계정입니다' using errcode = '42501';
  end if;

  -- 잠금 전에 어느 공간인지 확인 → 잠금 순서(sync_head → invite → member)를 지킨 뒤 다시 검사
  v_inv := private.find_usable_invite(p_code, false);
  perform private.lock_workspace_head(v_inv.workspace_id);
  v_inv := private.find_usable_invite(p_code, true);

  select * into v_mem from public.workspace_members
   where workspace_id = v_inv.workspace_id and account_id = v_uid
     for update;

  -- 이미 멤버면 아무것도 바꾸지 않음 (사용 횟수도 안 씀)
  if found and v_mem.status = 'ACTIVE' then
    return jsonb_build_object(
      'workspace_id', v_inv.workspace_id, 'role', v_mem.role, 'already_member', true);
  end if;

  -- 내보내진 사람은 내보낸 뒤에 새로 만든 초대로만 다시 참여
  if found and v_mem.status = 'REMOVED' and v_inv.created_at <= v_mem.ended_at then
    raise exception 'INVITE_BLOCKED: 이 공간에서 내보내졌습니다. OWNER에게 새 초대를 요청하세요' using errcode = '42501';
  end if;

  if found then
    update public.workspace_members
       set role = v_inv.role, status = 'ACTIVE', ended_at = null, joined_at = now(),
           invited_by = v_inv.invited_by, invite_id = v_inv.id
     where workspace_id = v_inv.workspace_id and account_id = v_uid;
  else
    insert into public.workspace_members (workspace_id, account_id, role, invited_by, invite_id)
    values (v_inv.workspace_id, v_uid, v_inv.role, v_inv.invited_by, v_inv.id);
  end if;

  update public.workspace_invites
     set use_count   = use_count + 1,
         status      = case when use_count + 1 >= max_uses then 'ACCEPTED' else status end,
         accepted_by = case when use_count + 1 >= max_uses then v_uid end,
         accepted_at = case when use_count + 1 >= max_uses then now() end
   where id = v_inv.id;

  v_seq := private.log_member_change(v_inv.workspace_id, v_uid, v_uid);

  return jsonb_build_object(
    'workspace_id',   v_inv.workspace_id,
    'workspace_name', (select name from public.workspaces where id = v_inv.workspace_id),
    'role',           v_inv.role,
    'already_member', false,
    'seq',            v_seq);
end $$;

comment on function public.accept_invite(text) is
  '초대 코드로 참여. 참여 후 sync_snapshot부터 받기. 이미 멤버면 already_member=true (사용 횟수 안 씀)';

-- ---------------------------------------------------------------------
-- 5. 나가기 (본인) / 역할 변경 · 내보내기 (OWNER)
-- ---------------------------------------------------------------------
create or replace function public.leave_workspace(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  v_mem  public.workspace_members%rowtype;
  v_seq  bigint;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  perform private.lock_workspace_head(p_workspace_id);

  select * into v_mem from public.workspace_members
   where workspace_id = p_workspace_id and account_id = v_uid
     for update;
  if not found or v_mem.status = 'REMOVED' then
    raise exception 'FORBIDDEN: 이 공간의 멤버가 아닙니다' using errcode = '42501';
  end if;
  if v_mem.status = 'LEFT' then
    return jsonb_build_object('workspace_id', p_workspace_id, 'status', 'LEFT');  -- 이미 나감
  end if;

  -- 마지막 OWNER면 트리거가 LAST_OWNER로 막음
  update public.workspace_members
     set status = 'LEFT', ended_at = now()
   where workspace_id = p_workspace_id and account_id = v_uid;

  if v_mem.role = 'OWNER' then
    perform private.revoke_invites_by(p_workspace_id, v_uid);
  end if;
  v_seq := private.log_member_change(p_workspace_id, v_uid, v_uid);

  return jsonb_build_object('workspace_id', p_workspace_id, 'status', 'LEFT', 'seq', v_seq);
end $$;

create or replace function public.change_member_role(p_workspace_id uuid, p_account_id uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  v_mem  public.workspace_members%rowtype;
  v_seq  bigint;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_role is null or p_role not in ('OWNER', 'EDITOR', 'VIEWER') then
    raise exception 'INVALID_REQUEST: 역할은 OWNER, EDITOR, VIEWER 중 하나입니다' using errcode = '22023';
  end if;
  perform private.lock_workspace_head(p_workspace_id);
  if not private.has_role(p_workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: OWNER만 역할을 바꿀 수 있습니다' using errcode = '42501';
  end if;

  select * into v_mem from public.workspace_members
   where workspace_id = p_workspace_id and account_id = p_account_id
     for update;
  if not found or v_mem.status <> 'ACTIVE' then
    raise exception 'NOT_FOUND: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '22023';
  end if;
  if v_mem.role = p_role then
    return jsonb_build_object('workspace_id', p_workspace_id, 'account_id', p_account_id,
                              'role', p_role, 'unchanged', true);
  end if;

  -- 마지막 OWNER가 자기 역할을 내리면 트리거가 LAST_OWNER로 막음
  update public.workspace_members
     set role = p_role
   where workspace_id = p_workspace_id and account_id = p_account_id;

  if v_mem.role = 'OWNER' then
    perform private.revoke_invites_by(p_workspace_id, p_account_id);
  end if;
  v_seq := private.log_member_change(p_workspace_id, p_account_id, v_uid);

  return jsonb_build_object('workspace_id', p_workspace_id, 'account_id', p_account_id,
                            'role', p_role, 'seq', v_seq);
end $$;

create or replace function public.remove_member(p_workspace_id uuid, p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  v_mem  public.workspace_members%rowtype;
  v_seq  bigint;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_account_id = v_uid then
    raise exception 'INVALID_REQUEST: 본인은 leave_workspace로 나가세요' using errcode = '22023';
  end if;
  perform private.lock_workspace_head(p_workspace_id);
  if not private.has_role(p_workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: OWNER만 멤버를 내보낼 수 있습니다' using errcode = '42501';
  end if;

  select * into v_mem from public.workspace_members
   where workspace_id = p_workspace_id and account_id = p_account_id
     for update;
  if not found or v_mem.status <> 'ACTIVE' then
    raise exception 'NOT_FOUND: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '22023';
  end if;

  update public.workspace_members
     set status = 'REMOVED', ended_at = now()
   where workspace_id = p_workspace_id and account_id = p_account_id;

  if v_mem.role = 'OWNER' then
    perform private.revoke_invites_by(p_workspace_id, p_account_id);
  end if;
  v_seq := private.log_member_change(p_workspace_id, p_account_id, v_uid);

  return jsonb_build_object('workspace_id', p_workspace_id, 'account_id', p_account_id,
                            'status', 'REMOVED', 'seq', v_seq);
end $$;

-- ---------------------------------------------------------------------
-- 6. 공간 삭제 (OWNER, 휴지통 처리)
--    삭제하면 모든 멤버에게서 공간이 사라지고(sync_* → FORBIDDEN), 남은 초대는 취소됨
--    되살리기는 SQL Editor에서 deleted_at = null (앱 기능은 후속)
-- ---------------------------------------------------------------------
create or replace function public.delete_workspace(p_workspace_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  perform private.lock_workspace_head(p_workspace_id);
  if not private.has_role(p_workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: OWNER만 공간을 삭제할 수 있습니다' using errcode = '42501';
  end if;

  update public.workspace_invites
     set status = 'REVOKED', revoked_at = now()
   where workspace_id = p_workspace_id and status = 'PENDING';

  update public.workspaces
     set deleted_at = now(), auth_epoch = auth_epoch + 1
   where id = p_workspace_id;

  return jsonb_build_object('workspace_id', p_workspace_id, 'deleted', true);
end $$;

-- ---------------------------------------------------------------------
-- 7. 실행 권한: 로그인 사용자만
-- ---------------------------------------------------------------------
revoke all on function public.create_invite(uuid, text, integer, integer) from public, anon;
revoke all on function public.revoke_invite(uuid)                         from public, anon;
revoke all on function public.preview_invite(text)                        from public, anon;
revoke all on function public.accept_invite(text)                         from public, anon;
revoke all on function public.leave_workspace(uuid)                       from public, anon;
revoke all on function public.change_member_role(uuid, uuid, text)        from public, anon;
revoke all on function public.remove_member(uuid, uuid)                   from public, anon;
revoke all on function public.delete_workspace(uuid)                      from public, anon;
grant execute on function public.create_invite(uuid, text, integer, integer) to authenticated;
grant execute on function public.revoke_invite(uuid)                         to authenticated;
grant execute on function public.preview_invite(text)                        to authenticated;
grant execute on function public.accept_invite(text)                         to authenticated;
grant execute on function public.leave_workspace(uuid)                       to authenticated;
grant execute on function public.change_member_role(uuid, uuid, text)        to authenticated;
grant execute on function public.remove_member(uuid, uuid)                   to authenticated;
grant execute on function public.delete_workspace(uuid)                      to authenticated;
