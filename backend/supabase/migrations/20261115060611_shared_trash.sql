-- =====================================================================
-- #32 공유 휴지통 (11/15, 정한 정책: 복구·영구 삭제·30일 뒤 자동 영구 삭제)
--   휴지통 대상 = 버전이 있는 기록 7가지: notes·tasks·events·projects·meetings·agenda_items·project_members
--   sync_push
--     RESTORE: 메모만 → 7가지 모두. 공간 편집자(OWNER·EDITOR)면 됨 (프로젝트·팀원은 #30 팀장 규칙 그대로)
--     PURGE (새로): 휴지통에 있는 것만 영구 삭제. 공간 관리자(OWNER) 또는 휴지통으로 보낸 사람(deleted_by)만
--       → 권한이 없으면 예외가 아니라 충돌(reason PURGE_NOT_ALLOWED, server = 서버 값). 휴지통에 없으면 NOT_DELETED
--       → 연결은 같이 지우고(메모↔프로젝트·첨부 연결·즐겨찾기·프로젝트 파일·팀원·초대), 이 기록을 가리키던
--         할 일·일정·회의는 연결만 끊음(note_id·project_id = null, 이월 원본 = null). 전부 원장에 남겨 다른 기기도 지움
--   cron: 매일 휴지통에 30일 넘게 있던 것을 영구 삭제 (private.trash_purge_expired)
-- =====================================================================

-- 원장에 한 줄 (head 순번을 하나 올림). UPSERT는 행, DELETE는 키만
create or replace function private.log_change(p_ws uuid, p_entity text, p_key text, p_op text, p_data jsonb,
                                              p_actor uuid, p_operation_id uuid)
returns bigint language plpgsql set search_path = '' as $$
declare v_seq bigint;
begin
  update public.workspace_sync_heads set last_seq = last_seq + 1, updated_at = now()
   where workspace_id = p_ws returning last_seq into v_seq;
  insert into public.workspace_changes
    (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
  values
    (p_ws, v_seq, p_entity, p_key, p_op,
     case when p_op = 'UPSERT' then (p_data ->> 'revision')::bigint end,
     case when p_op = 'UPSERT' then p_data end, p_operation_id, p_actor);
  return v_seq;
end $$;

-- 안건 하나 영구 삭제 (다른 회의의 이월 원본 연결 끊기 → 상태 이력 → 안건)
create or replace function private.trash_purge_agenda(p_ws uuid, p_id uuid, p_actor uuid, p_operation_id uuid)
returns void language plpgsql set search_path = '' as $$
declare v_row jsonb;
begin
  for v_row in update public.agenda_items t set carried_from_id = null
                where t.workspace_id = p_ws and t.carried_from_id = p_id returning to_jsonb(t) loop
    perform private.log_change(p_ws, 'agenda_items', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
  end loop;
  for v_row in delete from public.agenda_transitions t
                where t.workspace_id = p_ws and t.agenda_item_id = p_id returning to_jsonb(t) loop
    perform private.log_change(p_ws, 'agenda_transitions', v_row ->> 'id', 'DELETE', null, p_actor, p_operation_id);
  end loop;
  delete from public.agenda_items where workspace_id = p_ws and id = p_id;
  perform private.log_change(p_ws, 'agenda_items', p_id::text, 'DELETE', null, p_actor, p_operation_id);
end $$;

/**
 * 휴지통 기록 하나 영구 삭제 + 연결 정리 + 원장. 부르는 쪽이 공간 head를 잠그고 권한을 확인함
 * 반환: 지웠으면 true (없거나 휴지통이 아니면 false, 아무것도 안 함)
 */
create or replace function private.trash_purge(p_ws uuid, p_entity text, p_id uuid, p_actor uuid, p_operation_id uuid)
returns boolean language plpgsql set search_path = '' as $$
declare
  v_row jsonb;
  v_ok  boolean;
  v_aid uuid;
begin
  if p_entity not in ('notes', 'tasks', 'events', 'projects', 'meetings', 'agenda_items', 'project_members') then
    raise exception 'INVALID_REQUEST: 휴지통 대상이 아닙니다 (%)', p_entity using errcode = '22023';
  end if;
  execute format('select true from public.%I t where t.workspace_id = $1 and t.id = $2 and t.deleted_at is not null for update', p_entity)
     into v_ok using p_ws, p_id;
  if v_ok is null then return false; end if;

  if p_entity = 'notes' then
    for v_row in update public.tasks t set note_id = null where t.workspace_id = p_ws and t.note_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'tasks', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
    end loop;
    for v_row in update public.events t set note_id = null where t.workspace_id = p_ws and t.note_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'events', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
    end loop;
    for v_row in delete from public.note_projects t where t.workspace_id = p_ws and t.note_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'note_projects', (v_row ->> 'note_id') || ':' || (v_row ->> 'project_id'), 'DELETE', null, p_actor, p_operation_id);
    end loop;
    for v_row in delete from public.note_attachments t where t.workspace_id = p_ws and t.note_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'note_attachments', (v_row ->> 'note_id') || ':' || (v_row ->> 'asset_id'), 'DELETE', null, p_actor, p_operation_id);
    end loop;
    delete from public.notes where workspace_id = p_ws and id = p_id;   -- 즐겨찾기는 FK로 같이 지워짐 (원장 밖)

  elsif p_entity = 'projects' then
    for v_row in update public.tasks t set project_id = null where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'tasks', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
    end loop;
    for v_row in update public.events t set project_id = null where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'events', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
    end loop;
    for v_row in update public.meetings t set project_id = null where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'meetings', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
    end loop;
    -- 대기 중인 프로젝트 초대는 공간 초대 코드도 같이 취소 (코드로 공간에만 들어오는 일이 없게)
    update public.workspace_invites w set status = 'REVOKED', revoked_at = now()
     where w.status = 'PENDING'
       and w.id in (select pi.invite_id from public.project_invites pi
                     where pi.workspace_id = p_ws and pi.project_id = p_id and pi.status = 'PENDING');
    for v_row in delete from public.project_invites t where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'project_invites', v_row ->> 'id', 'DELETE', null, p_actor, p_operation_id);
    end loop;
    for v_row in delete from public.project_members t where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'project_members', v_row ->> 'id', 'DELETE', null, p_actor, p_operation_id);
    end loop;
    for v_row in delete from public.project_files t where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'project_files', (v_row ->> 'project_id') || ':' || (v_row ->> 'asset_id'), 'DELETE', null, p_actor, p_operation_id);
    end loop;
    for v_row in delete from public.note_projects t where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'note_projects', (v_row ->> 'note_id') || ':' || (v_row ->> 'project_id'), 'DELETE', null, p_actor, p_operation_id);
    end loop;
    for v_row in delete from public.project_participants t where t.workspace_id = p_ws and t.project_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'project_participants', (v_row ->> 'project_id') || ':' || (v_row ->> 'account_id'), 'DELETE', null, p_actor, p_operation_id);
    end loop;
    delete from public.projects where workspace_id = p_ws and id = p_id;

  elsif p_entity = 'meetings' then
    for v_aid in select a.id from public.agenda_items a where a.workspace_id = p_ws and a.meeting_id = p_id loop
      perform private.trash_purge_agenda(p_ws, v_aid, p_actor, p_operation_id);
    end loop;
    delete from public.meetings where workspace_id = p_ws and id = p_id;

  elsif p_entity = 'agenda_items' then
    perform private.trash_purge_agenda(p_ws, p_id, p_actor, p_operation_id);
    return true;   -- 원장은 위에서 남김

  elsif p_entity = 'project_members' then
    for v_row in update public.project_invites t set member_id = null where t.member_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'project_invites', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
    end loop;
    delete from public.project_members where workspace_id = p_ws and id = p_id;

  else   -- tasks, events
    execute format('delete from public.%I where workspace_id = $1 and id = $2', p_entity) using p_ws, p_id;
  end if;

  perform private.log_change(p_ws, p_entity, p_id::text, 'DELETE', null, p_actor, p_operation_id);
  return true;
end $$;

/** cron: 휴지통에 p_days일 넘게 있던 기록 영구 삭제 (안건 → 할 일·일정 → 메모 → 회의 → 팀원 → 프로젝트 순). 반환: 지운 개수 */
create or replace function private.trash_purge_expired(p_days integer default 30, p_limit integer default 1000)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
  v_cut timestamptz := now() - make_interval(days => p_days);
begin
  for r in
    select x.workspace_id, x.entity, x.id from (
                select workspace_id, 'agenda_items'::text as entity, id, deleted_at, 1 as ord from public.agenda_items    where deleted_at < v_cut
      union all select workspace_id, 'tasks',           id, deleted_at, 2 from public.tasks           where deleted_at < v_cut
      union all select workspace_id, 'events',          id, deleted_at, 2 from public.events          where deleted_at < v_cut
      union all select workspace_id, 'notes',           id, deleted_at, 3 from public.notes           where deleted_at < v_cut
      union all select workspace_id, 'meetings',        id, deleted_at, 4 from public.meetings        where deleted_at < v_cut
      union all select workspace_id, 'project_members', id, deleted_at, 5 from public.project_members where deleted_at < v_cut
      union all select workspace_id, 'projects',        id, deleted_at, 6 from public.projects        where deleted_at < v_cut
    ) x order by x.ord, x.deleted_at limit p_limit
  loop
    perform 1 from public.workspace_sync_heads h where h.workspace_id = r.workspace_id for update;
    if private.trash_purge(r.workspace_id, r.entity, r.id, null, null) then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke all on function private.log_change(uuid, text, text, text, jsonb, uuid, uuid),
  private.trash_purge_agenda(uuid, uuid, uuid, uuid),
  private.trash_purge(uuid, text, uuid, uuid, uuid),
  private.trash_purge_expired(integer, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- sync_push: RESTORE 전 항목 + PURGE (서버 함수에 바뀐 부분만 적용, 고칠 곳을 정확히 한 번 못 찾으면 전체 실패)
-- ---------------------------------------------------------------------
do $patch$
declare
  d text := pg_get_functiondef('public.sync_push(uuid,uuid,jsonb,uuid)'::regprocedure);
  p text[][] := array[
    array[
$f$    if v_kind is null or v_kind not in ('UPSERT', 'DELETE', 'RESTORE') then
      raise exception 'INVALID_REQUEST: ops[%].op는 UPSERT, DELETE 또는 RESTORE', i using errcode = '22023';$f$,
$t$    if v_kind is null or v_kind not in ('UPSERT', 'DELETE', 'RESTORE', 'PURGE') then
      raise exception 'INVALID_REQUEST: ops[%].op는 UPSERT, DELETE, RESTORE 또는 PURGE', i using errcode = '22023';$t$],
    array[
$f$    if v_kind = 'RESTORE' and (v_entity <> 'notes' or v_data <> '{}'::jsonb) then
      raise exception 'INVALID_REQUEST: RESTORE는 notes에만 지원하며 data는 비어 있어야 합니다' using errcode = '22023';$f$,
$t$    if v_kind in ('RESTORE', 'PURGE') and (v_cls <> 'REV' or v_data <> '{}'::jsonb) then
      raise exception 'INVALID_REQUEST: RESTORE·PURGE는 휴지통 대상(notes·tasks·events·projects·meetings·agenda_items·project_members)에만 쓰고 data는 비어 있어야 합니다' using errcode = '22023';$t$],
    array[
$f$        if v_kind in ('DELETE', 'RESTORE') and v_base is null then
          raise exception 'INVALID_REQUEST: ops[%] DELETE/RESTORE에는 base_revision이 필요합니다', i using errcode = '22023';$f$,
$t$        if v_kind in ('DELETE', 'RESTORE', 'PURGE') and v_base is null then
          raise exception 'INVALID_REQUEST: ops[%] DELETE/RESTORE/PURGE에는 base_revision이 필요합니다', i using errcode = '22023';$t$],
    array[
$f$      elsif v_row ->> 'deleted_at' is not null and v_kind <> 'RESTORE' then$f$,
$t$      elsif v_row ->> 'deleted_at' is not null and v_kind not in ('RESTORE', 'PURGE') then$t$],
    array[
$f$      elsif v_kind = 'RESTORE' and v_row ->> 'deleted_at' is null then$f$,
$t$      elsif v_kind in ('RESTORE', 'PURGE') and v_row ->> 'deleted_at' is null then$t$],
    array[
$f$
    if v_key = any (v_keys) then$f$,
$t$
    -- #32 영구 삭제: 공간 관리자 또는 휴지통으로 보낸 사람만 (이미 다른 충돌이 있는 op는 그대로)
    if v_kind = 'PURGE' and v_row is not null
       and not exists (select 1 from jsonb_array_elements(v_conflicts) c where (c ->> 'index')::int = i)
       and v_role <> 'OWNER' and (v_row ->> 'deleted_by') is distinct from v_uid::text then
      v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'PURGE_NOT_ALLOWED', 'server', v_row);
    end if;

    if v_key = any (v_keys) then$t$],
    array[
$f$    elsif v_kind = 'RESTORE' then
      update public.notes t set deleted_at = null, deleted_by = null
       where t.id = v_id and t.workspace_id = p_workspace_id
      returning to_jsonb(t) into v_row;$f$,
$t$    elsif v_kind = 'RESTORE' then
      execute format('update public.%I t set deleted_at = null, deleted_by = null
                       where t.id = $1 and t.workspace_id = $2 returning to_jsonb(t)', v_entity)
         into v_row using v_id, p_workspace_id;

    elsif v_kind = 'PURGE' then
      -- #32 영구 삭제: 연결 정리·원장은 private.trash_purge가 head 순번을 이어서 씀
      update public.workspace_sync_heads set last_seq = v_seq, updated_at = now() where workspace_id = p_workspace_id;
      perform private.trash_purge(p_workspace_id, v_entity, v_id, v_uid, p_operation_id);
      select h.last_seq into v_seq from public.workspace_sync_heads h where h.workspace_id = p_workspace_id;
      v_results := v_results || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id, 'seq', v_seq, 'purged', true);
      continue;$t$]
  ];
  k int;
begin
  for k in 1 .. array_length(p, 1) loop
    if (length(d) - length(replace(d, p[k][1], ''))) / length(p[k][1]) <> 1 then
      raise exception 'PATCH_FAILED: sync_push 고칠 곳 %번을 정확히 한 번 찾지 못함', k;
    end if;
    d := replace(d, p[k][1], p[k][2]);
  end loop;
  execute d;
end $patch$;

comment on function public.sync_push(uuid, uuid, jsonb, uuid) is
  '기기 변경 올리기. op: UPSERT·DELETE(휴지통)·RESTORE(복구, 휴지통 대상 7가지)·PURGE(영구 삭제: 공간 관리자 또는 지운 사람, #32). '
  '권한 없는 프로젝트 관리(#30)·영구 삭제(#32)는 충돌로 돌려줌';

select cron.schedule('trash-purge-expired', '17 18 * * *', $cmd$ select private.trash_purge_expired() $cmd$);   -- 매일 03:17 (서울)
