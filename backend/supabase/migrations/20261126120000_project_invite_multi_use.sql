-- 프로젝트 링크 초대를 코드 하나로 여러 명이 (1~50명)
-- create_project_invite: p_max_uses 추가 (기본 1, 메일 초대는 1만). 공간 초대 create_invite와 같은 한도
-- join_with_invite: 사람마다 프로젝트 팀원으로 넣고 한 자리씩 씀. 같은 사람이 다시 쓰면 자리를 쓰지 않음.
--   코드를 다 쓰기 전까지 프로젝트 초대는 '대기'로 남아 다른 사람이 계속 쓸 수 있음
-- 두 함수 모두 서버의 현재 정의(20261114162335_project_team 이후)를 그대로 두고 위 부분만 바꿈

drop function public.create_project_invite(uuid, text, text, integer);
CREATE OR REPLACE FUNCTION public.create_project_invite(p_project_id uuid, p_method text, p_email text DEFAULT NULL::text, p_expires_in_hours integer DEFAULT 168, p_max_uses integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 링크 초대는 코드 하나를 여러 명(1~50)이 쓸 수 있음. 메일 초대는 받는 사람 한 명
  if p_max_uses is null or p_max_uses not between 1 and 50 or (p_method = 'EMAIL' and p_max_uses <> 1) then
    raise exception 'INVALID_REQUEST: 사용 인원은 링크 초대 1~50명, 메일 초대 1명입니다' using errcode = '22023';
  end if;

  select workspace_id into v_ws from public.projects where id = p_project_id and deleted_at is null;
  if v_ws is null or not private.is_active_member(v_ws) then
    raise exception 'NOT_FOUND: 프로젝트가 없습니다' using errcode = '22023';
  end if;
  if not private.has_role(v_ws, array['OWNER', 'EDITOR']) then
    raise exception 'FORBIDDEN: 보기 전용 멤버는 초대할 수 없습니다' using errcode = '42501';
  end if;
  if not private.can_manage_project(v_ws, p_project_id, v_uid) then
    raise exception 'FORBIDDEN: 프로젝트 팀장만 초대할 수 있습니다' using errcode = '42501';
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
      values (v_ws, 'EDITOR', private.invite_code_hash(v_code), v_uid, now() + make_interval(hours => p_expires_in_hours), p_max_uses)
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
end $function$;
revoke all on function public.create_project_invite(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.create_project_invite(uuid, text, text, integer, integer) to authenticated;

CREATE OR REPLACE FUNCTION public.join_with_invite(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid    uuid := (select auth.uid());
  v_norm   text := private.normalize_invite_code(p_code);
  v_inv_id uuid;
  v_res    jsonb;
  v_pi     public.project_invites%rowtype;
  v_mem    public.project_members%rowtype;
  v_name   text;
  v_out    jsonb := '[]'::jsonb;
  v_added  boolean := false;   -- 이번에 새로 프로젝트 팀원이 됐는지 (같은 사람이 다시 쓰면 자리를 쓰지 않음)
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
        v_added := true;
      end if;
    end if;
    v_out := v_out || jsonb_build_object('project_id', v_pi.project_id, 'member_id', v_mem.id);
  end loop;

  -- 이미 공간 멤버면 accept_invite가 자리를 안 썼으므로 여기서 한 자리 (새로 팀원이 된 경우만)
  if v_added and (v_res ->> 'already_member')::boolean then
    update public.workspace_invites
       set use_count   = use_count + 1,
           status      = case when use_count + 1 >= max_uses then 'ACCEPTED' else status end,
           accepted_by = case when use_count + 1 >= max_uses then v_uid else accepted_by end,
           accepted_at = case when use_count + 1 >= max_uses then now() else accepted_at end
     where id = v_inv_id and status = 'PENDING';
  end if;

  -- 코드를 다 쓴 때만 프로젝트 초대를 '수락됨'으로 (남은 자리가 있으면 다른 사람이 계속 쓸 수 있게 대기 유지)
  if v_inv_id is not null and coalesce((select status from public.workspace_invites where id = v_inv_id), 'ACCEPTED') <> 'PENDING' then
    for v_pi in
      update public.project_invites
         set status = 'ACCEPTED', accepted_by = v_uid, accepted_at = now(),
             member_id = (select id from public.project_members m where m.project_id = project_invites.project_id and m.account_id = v_uid and m.deleted_at is null)
       where invite_id = v_inv_id and status = 'PENDING'
      returning *
    loop
      perform private.log_row_change(v_pi.workspace_id, 'project_invites', v_pi.id::text, to_jsonb(v_pi), v_uid);
    end loop;
  end if;

  return v_res || jsonb_build_object('projects', v_out,
    'last_seq', (select last_seq from public.workspace_sync_heads where workspace_id = (v_res ->> 'workspace_id')::uuid));
end $function$;
