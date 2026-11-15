-- =====================================================================
-- #33 회원 탈퇴 (11/15, 정한 정책)
--   공유 기록은 남기고 작성자를 '탈퇴한 사용자'로 표시(작성자 칸 = null), 나머지(계정·프로필·설정·구독·결제 기록·
--   기기·동의·AI 사용 기록·즐겨찾기·백업·녹음)는 바로 삭제
--   혼자 OWNER인 공간: 다른 ACTIVE 멤버가 있으면 OWNER를 넘김(먼저 들어온 편집자 → 없으면 먼저 들어온 보기 전용)
--                     ACTIVE 멤버가 나뿐이면 공간을 기록째 지움
--   다른 공간은 나가기(LEFT, 원장에 남겨 다른 멤버 기기에서 빠짐). 내가 만든 대기 중 초대는 취소
--   프로젝트 팀원 중 내 계정이 연결된 칸은 이름을 '탈퇴한 사용자'로, 계정 연결은 끊음
--   흐름: Edge Function `account` /delete
--     ① account_withdraw_prepare(계정) → 지울 Storage 객체 목록 (넘기기·나가기도 여기서, 혼자인 공간은 ③에서 삭제)
--     ② Storage 객체 삭제 ③ account_withdraw_finish(계정) → accounts 삭제 ④ Auth 사용자 삭제
--   대시보드에서 사용자를 지워도 같은 정리가 돌도록 accounts 삭제 전에 트리거로 ①을 한 번 더 부름
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 작성자 칸: null 허용 + 계정이 지워지면 null (공유 기록은 남김)
--    개인 기록 칸: 계정과 같이 삭제
-- ---------------------------------------------------------------------
do $fk$
declare
  r record;
  v_con text;
begin
  for r in select * from (values
      ('workspaces', 'created_by', 'set null'), ('workspace_members', 'invited_by', 'set null'),
      ('workspace_invites', 'accepted_by', 'set null'), ('workspace_invites', 'invited_by', 'set null'),
      ('projects', 'created_by', 'set null'), ('projects', 'deleted_by', 'set null'),
      ('input_sources', 'created_by', 'set null'), ('source_text_versions', 'confirmed_by', 'set null'),
      ('notes', 'created_by', 'set null'), ('notes', 'deleted_by', 'set null'),
      ('tasks', 'created_by', 'set null'), ('tasks', 'deleted_by', 'set null'),
      ('events', 'created_by', 'set null'), ('events', 'deleted_by', 'set null'),
      ('meetings', 'created_by', 'set null'), ('meetings', 'deleted_by', 'set null'),
      ('agenda_items', 'created_by', 'set null'), ('agenda_items', 'deleted_by', 'set null'),
      ('agenda_transitions', 'actor_id', 'set null'), ('workspace_changes', 'actor_id', 'set null'),
      ('assets', 'deleted_by', 'set null'), ('assets', 'owner_account_id', 'set null'),
      ('note_attachments', 'added_by', 'set null'), ('project_files', 'added_by', 'set null'),
      ('project_members', 'account_id', 'set null'), ('project_members', 'created_by', 'set null'),
      ('project_members', 'deleted_by', 'set null'),
      ('project_invites', 'accepted_by', 'set null'), ('project_invites', 'created_by', 'set null'),
      ('workspace_members', 'account_id', 'cascade'), ('sync_operations', 'actor_id', 'cascade'),
      ('ai_requests', 'account_id', 'cascade')
    ) v(tbl, col, act)
  loop
    select c.conname into v_con
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.conrelid = format('public.%I', r.tbl)::regclass
       and c.confrelid = 'public.accounts'::regclass and array_length(c.conkey, 1) = 1 and a.attname = r.col;
    if v_con is null then
      raise exception 'PATCH_FAILED: %.% → accounts 외래키를 찾지 못함', r.tbl, r.col;
    end if;
    execute format('alter table public.%I drop constraint %I', r.tbl, v_con);
    execute format('alter table public.%I add constraint %I foreign key (%I) references public.accounts (id) on delete %s',
                   r.tbl, v_con, r.col, r.act);
    if r.act = 'set null' then
      execute format('alter table public.%I alter column %I drop not null', r.tbl, r.col);
    end if;
  end loop;

  -- accounts ↔ Auth 사용자: Auth 사용자를 지우면 계정도 (정리는 아래 트리거)
  select conname into v_con from pg_constraint
   where contype = 'f' and conrelid = 'public.accounts'::regclass and confrelid = 'auth.users'::regclass;
  execute format('alter table public.accounts drop constraint %I', v_con);
  execute format('alter table public.accounts add constraint %I foreign key (id) references auth.users (id) on delete cascade', v_con);
end $fk$;

-- "휴지통에 있으면 지운 사람도 있음" → 지운 사람이 탈퇴하면 null이어도 됨
do $ck$
declare r record;
begin
  for r in select c.conrelid::regclass as tbl, c.conname
             from pg_constraint c
            where c.contype = 'c' and c.connamespace = 'public'::regnamespace
              and pg_get_constraintdef(c.oid) ilike '%(deleted_at IS NULL) = (deleted_by IS NULL)%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I check (deleted_by is null or deleted_at is not null)', r.tbl, r.conname);
  end loop;
end $ck$;

-- 수락한 사람이 탈퇴하면 accepted_by = null (수락 시각은 남음)
alter table public.workspace_invites drop constraint invites_accepted_fields,
  add constraint invites_accepted_fields check ((status = 'ACCEPTED') = (accepted_at is not null));
alter table public.project_invites drop constraint project_invites_accepted_fields,
  add constraint project_invites_accepted_fields check ((status = 'ACCEPTED') = (accepted_at is not null));

-- 지워진 공간에는 마지막 OWNER 검사가 필요 없음 (혼자인 공간을 지운 뒤 멤버 행 정리)
create or replace function private.guard_last_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'OWNER' and old.status = 'ACTIVE'
     and (tg_op = 'DELETE' or new.role <> 'OWNER' or new.status <> 'ACTIVE') then

    perform 1 from public.workspaces where id = old.workspace_id and deleted_at is null for update;

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

-- ---------------------------------------------------------------------
-- 2. 탈퇴 준비: 공간 정리 + 지울 Storage 객체 목록 (여러 번 불러도 같음)
--    p_delete_solo = false(①): 혼자인 공간은 파일 목록만 주고 남겨 둠 → 파일 삭제가 실패해도 다시 부르면 목록이 그대로
--    p_delete_solo = true(③ 계정 삭제 직전 트리거): 혼자인 공간을 기록째 삭제
-- ---------------------------------------------------------------------
create or replace function private.account_withdraw_cleanup(p_uid uuid, p_delete_solo boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m          record;
  v_next     uuid;
  v_row      jsonb;
  v_objects  jsonb := '[]'::jsonb;
  v_moved    jsonb := '[]'::jsonb;
  v_left     jsonb := '[]'::jsonb;
  v_deleted  jsonb := '[]'::jsonb;
  v_seq      bigint;
begin
  for m in
    select wm.workspace_id, wm.role
      from public.workspace_members wm
      join public.workspaces w on w.id = wm.workspace_id and w.deleted_at is null
     where wm.account_id = p_uid and wm.status = 'ACTIVE'
     order by wm.workspace_id
  loop
    perform private.lock_workspace_head(m.workspace_id);

    if not exists (select 1 from public.workspace_members x
                    where x.workspace_id = m.workspace_id and x.account_id <> p_uid and x.status = 'ACTIVE') then
      -- 혼자인 공간: 첨부 파일 목록을 받아 두고 공간째 삭제
      select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', a.bucket_id, 'path', a.object_path)), '[]'::jsonb)
        into v_objects from public.assets a where a.workspace_id = m.workspace_id and a.status <> 'DELETED';
      select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', 'stt-recordings', 'path', s.object_path)), '[]'::jsonb)
        into v_objects
        from private.stt_segments s join private.stt_recordings r on r.id = s.recording_id
       where r.workspace_id = m.workspace_id and not s.object_deleted;
      if p_delete_solo then
        delete from public.ai_requests where workspace_id = m.workspace_id;   -- 이 외래키만 cascade가 아님
        delete from public.workspaces where id = m.workspace_id;
      end if;
      v_deleted := v_deleted || to_jsonb(m.workspace_id);
      continue;
    end if;

    if m.role = 'OWNER' and not exists (
         select 1 from public.workspace_members x
          where x.workspace_id = m.workspace_id and x.account_id <> p_uid and x.status = 'ACTIVE' and x.role = 'OWNER') then
      select x.account_id into v_next
        from public.workspace_members x
       where x.workspace_id = m.workspace_id and x.account_id <> p_uid and x.status = 'ACTIVE'
       order by (x.role = 'EDITOR') desc, x.joined_at, x.account_id
       limit 1;
      update public.workspace_members set role = 'OWNER'
       where workspace_id = m.workspace_id and account_id = v_next;
      perform private.log_member_change(m.workspace_id, v_next, p_uid);
      v_moved := v_moved || jsonb_build_object('workspace_id', m.workspace_id, 'owner', v_next);
    end if;

    -- 내 계정이 연결된 프로젝트 팀원 칸 → '탈퇴한 사용자'
    for v_row in update public.project_members t set name = '탈퇴한 사용자', account_id = null
                  where t.workspace_id = m.workspace_id and t.account_id = p_uid returning to_jsonb(t) loop
      perform private.log_change(m.workspace_id, 'project_members', v_row ->> 'id', 'UPSERT', v_row, p_uid, null);
    end loop;

    update public.workspace_members set status = 'LEFT', ended_at = now()
     where workspace_id = m.workspace_id and account_id = p_uid;
    perform private.revoke_invites_by(m.workspace_id, p_uid);
    v_seq := private.log_member_change(m.workspace_id, p_uid, p_uid);
    v_left := v_left || to_jsonb(m.workspace_id);
  end loop;

  -- 원장에 남은 내 이름·사진 지우기 (멤버 변경 기록), 마지막 기록에는 '탈퇴' 표시
  update public.workspace_changes c
     set data = (c.data - 'display_name' - 'avatar_path') || jsonb_build_object('display_name', null, 'withdrawn', true)
   where c.entity_table = 'workspace_members' and c.entity_key = p_uid::text and c.data is not null;

  -- 개인 파일: 백업 · 기기 공간 없는 첨부 · 녹음 임시 보관함 · 긴 녹음 구간
  select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', a.bucket_id, 'path', a.object_path)), '[]'::jsonb)
    into v_objects from public.assets a
   where a.owner_account_id = p_uid and a.workspace_id is null and a.status <> 'DELETED';
  select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', 'stt-uploads', 'path', u.object_path)), '[]'::jsonb)
    into v_objects from private.stt_uploads u where u.account_id = p_uid and not u.object_deleted;
  select v_objects || coalesce(jsonb_agg(jsonb_build_object('bucket', 'stt-recordings', 'path', s.object_path)), '[]'::jsonb)
    into v_objects from private.stt_segments s where s.account_id = p_uid and not s.object_deleted;

  return jsonb_build_object('objects', v_objects, 'owner_moved', v_moved, 'left', v_left, 'deleted_workspaces', v_deleted);
end $$;

revoke all on function private.account_withdraw_cleanup(uuid, boolean) from public, anon, authenticated;

-- 계정이 지워지기 직전에 공간 정리 (대시보드 삭제도 안전하게) + 개인 첨부 행 삭제 (백업 목록은 FK로)
create or replace function private.accounts_before_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.account_withdraw_cleanup(old.id, true);
  delete from public.assets where owner_account_id = old.id and workspace_id is null;
  return old;
end $$;
revoke all on function private.accounts_before_delete() from public, anon, authenticated;
drop trigger if exists accounts_withdraw_cleanup on public.accounts;
create trigger accounts_withdraw_cleanup before delete on public.accounts
  for each row execute function private.accounts_before_delete();

-- ---------------------------------------------------------------------
-- 3. Edge Function용 (service_role만)
-- ---------------------------------------------------------------------
/** ① 탈퇴 준비: 공간 정리(넘기기·나가기) 후 지울 Storage 객체 목록. 혼자인 공간은 ③에서 삭제 (deleted_workspaces = 지울 공간) */
create or replace function public.account_withdraw_prepare(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts where id = p_account_id) then
    raise exception 'NOT_FOUND: 계정이 없습니다' using errcode = '22023';
  end if;
  return private.account_withdraw_cleanup(p_account_id, false);
end $$;

/** ③ 탈퇴 마무리: 계정 삭제 (프로필·설정·구독·결제·기기·동의·AI 기록·즐겨찾기·백업 목록은 같이, 공유 기록은 작성자 null) */
create or replace function public.account_withdraw_finish(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  delete from public.accounts where id = p_account_id;
  return jsonb_build_object('ok', true, 'deleted', found);
end $$;

revoke all on function public.account_withdraw_prepare(uuid), public.account_withdraw_finish(uuid) from public, anon, authenticated;
grant execute on function public.account_withdraw_prepare(uuid), public.account_withdraw_finish(uuid) to service_role;

comment on function public.account_withdraw_prepare(uuid) is '회원 탈퇴 ①: 혼자인 공간 삭제·OWNER 넘기기·나가기·초대 취소, 지울 Storage 객체 목록 (service_role, Edge Function account)';
comment on function public.account_withdraw_finish(uuid) is '회원 탈퇴 ③: 계정 삭제. 공유 기록은 남고 작성자 칸은 null(앱: 탈퇴한 사용자)';

-- ---------------------------------------------------------------------
-- 4. 화면용 미리 보기: 탈퇴하면 내 공간들이 어떻게 되는지 (바꾸는 것 없음)
--    [{ workspace_id, name, action: 'DELETE'(혼자라 삭제) | 'TRANSFER'(OWNER 넘김) | 'LEAVE'(나가기만), next_owner_id, next_owner_name }]
-- ---------------------------------------------------------------------
create or replace function public.account_withdraw_preview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'workspace_id', w.id, 'name', w.name, 'action', x.action,
             'next_owner_id', x.next_owner, 'next_owner_name', p.display_name) order by w.name, w.id)
      from public.workspace_members wm
      join public.workspaces w on w.id = wm.workspace_id and w.deleted_at is null
      cross join lateral (
        select case
                 when not exists (select 1 from public.workspace_members o
                                   where o.workspace_id = w.id and o.account_id <> v_uid and o.status = 'ACTIVE') then 'DELETE'
                 when wm.role = 'OWNER' and not exists (select 1 from public.workspace_members o
                                   where o.workspace_id = w.id and o.account_id <> v_uid and o.status = 'ACTIVE' and o.role = 'OWNER') then 'TRANSFER'
                 else 'LEAVE' end as action,
               (select o.account_id from public.workspace_members o
                 where o.workspace_id = w.id and o.account_id <> v_uid and o.status = 'ACTIVE'
                 order by (o.role = 'EDITOR') desc, o.joined_at, o.account_id limit 1) as next_owner_raw
      ) a
      cross join lateral (select a.action, case when a.action = 'TRANSFER' then a.next_owner_raw end as next_owner) x
      left join public.profiles p on p.account_id = x.next_owner
     where wm.account_id = v_uid and wm.status = 'ACTIVE'), '[]'::jsonb);
end $$;
revoke all on function public.account_withdraw_preview() from public, anon;
grant execute on function public.account_withdraw_preview() to authenticated;
comment on function public.account_withdraw_preview() is '탈퇴 화면: 공간별로 삭제(혼자)·OWNER 넘김(누구에게)·나가기 미리 보기';
