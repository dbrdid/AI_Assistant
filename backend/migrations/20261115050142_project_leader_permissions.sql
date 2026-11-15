-- =====================================================================
-- #30 프로젝트 팀장 권한 (11/15 결정: "팀장만 프로젝트 관리")
--   프로젝트 관리 = 프로젝트 수정·삭제, 팀원 추가·수정·이동·삭제, 프로젝트 초대 만들기
--   할 수 있는 사람 = 공간 관리자(OWNER) + 그 프로젝트의 '팀장'(project_members.role = '팀장', 계정 연결된 ACTIVE 멤버)
--   팀장(계정 연결된 ACTIVE 멤버)이 아무도 없는 프로젝트는 지금처럼 공간 편집자(OWNER·EDITOR)면 됨
--     → 새 프로젝트를 만들고 자기를 팀장으로 넣는 것은 한 묶음에 가능 (#25 앱 흐름 그대로)
--   메모·할 일·일정·파일과 그 프로젝트 연결은 지금처럼 공간 권한 (EDITOR 이상)
--   sync_push: 권한 없는 수정은 예외가 아니라 충돌(reason NOT_PROJECT_LEADER, server = 서버 값)로 돌려줌
--     → 오프라인에서 고친 것이 보낼 목록을 막지 않고, 앱은 "서버 값 쓰기"로 정리
--   초대 취소는 지금처럼 초대한 사람·공간 관리자 + 그 프로젝트 팀장
-- =====================================================================

-- 이 계정이 그 프로젝트의 팀장인지 (계정 연결 + 휴지통 아님)
create or replace function private.is_project_leader(p_workspace uuid, p_project uuid, p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members pm
     where pm.workspace_id = p_workspace and pm.project_id = p_project and pm.account_id = p_account
       and pm.deleted_at is null and btrim(pm.role) = '팀장')
$$;

-- 프로젝트를 관리할 수 있는지 (부르는 쪽이 공간 편집자(OWNER·EDITOR)인지는 따로 확인)
create or replace function private.can_manage_project(p_workspace uuid, p_project uuid, p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m
                  where m.workspace_id = p_workspace and m.account_id = p_account and m.status = 'ACTIVE' and m.role = 'OWNER')
      or private.is_project_leader(p_workspace, p_project, p_account)
      or not exists (
           select 1 from public.project_members pm
             join public.workspace_members m on m.workspace_id = pm.workspace_id and m.account_id = pm.account_id and m.status = 'ACTIVE'
            where pm.workspace_id = p_workspace and pm.project_id = p_project
              and pm.deleted_at is null and btrim(pm.role) = '팀장')
$$;

revoke all on function private.is_project_leader(uuid, uuid, uuid), private.can_manage_project(uuid, uuid, uuid)
  from public, anon, authenticated;

/** 화면용: 이 공간에서 내가 관리할 수 있는 프로젝트 (버튼 숨기기). { project_id: true|false } */
create or replace function public.get_project_permissions(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_edit boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not private.is_active_member(p_workspace_id) then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;
  v_edit := private.has_role(p_workspace_id, array['OWNER', 'EDITOR']);
  return coalesce((
    select jsonb_object_agg(p.id, v_edit and private.can_manage_project(p_workspace_id, p.id, v_uid))
      from public.projects p
     where p.workspace_id = p_workspace_id and p.deleted_at is null), '{}'::jsonb);
end $$;
revoke all on function public.get_project_permissions(uuid) from public, anon;
grant execute on function public.get_project_permissions(uuid) to authenticated;

do $mig$
declare
  d text;
  pairs text[][];
  k integer;
  v_from text;
  v_to text;
begin
  -- -------------------------------------------------------------------
  -- sync_push: 검사 단계 끝(대상 행을 잠그고 충돌을 본 뒤)에 팀장 권한 확인
  -- -------------------------------------------------------------------
  d := pg_get_functiondef('public.sync_push(uuid,uuid,jsonb,uuid)'::regprocedure);
  v_from := $p$
    if v_key = any (v_keys) then$p$;
  v_to := $p$
    -- #30 프로젝트 팀장 권한: 프로젝트 수정·삭제, 팀원 추가·수정·이동·삭제 (이미 다른 충돌이 있는 op는 그대로)
    if v_cls = 'REV' and v_entity in ('projects', 'project_members')
       and not exists (select 1 from jsonb_array_elements(v_conflicts) c where (c ->> 'index')::int = i)
       and (
         (v_entity = 'projects' and v_row is not null
            and not private.can_manage_project(p_workspace_id, v_id, v_uid))
         or (v_entity = 'project_members' and v_row is not null
            and not private.can_manage_project(p_workspace_id, (v_row ->> 'project_id')::uuid, v_uid))
         or (v_entity = 'project_members' and v_data ? 'project_id' and v_data ->> 'project_id' is not null
            and not private.can_manage_project(p_workspace_id, (v_data ->> 'project_id')::uuid, v_uid))
       ) then
      v_conflicts := v_conflicts || jsonb_strip_nulls(jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'NOT_PROJECT_LEADER', 'server', v_row));
    end if;

    if v_key = any (v_keys) then$p$;
  if (length(d) - length(replace(d, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'patch #30: sync_push 고칠 곳을 정확히 한 번 찾지 못했습니다';
  end if;
  execute replace(d, v_from, v_to);

  -- -------------------------------------------------------------------
  -- 프로젝트 초대: 만들기는 팀장(+공간 관리자), 취소는 초대한 사람·공간 관리자·팀장
  -- -------------------------------------------------------------------
  d := pg_get_functiondef('public.create_project_invite(uuid,text,text,integer)'::regprocedure);
  v_from := $p$  if not private.has_role(v_ws, array['OWNER', 'EDITOR']) then
    raise exception 'FORBIDDEN: 보기 전용 멤버는 초대할 수 없습니다' using errcode = '42501';
  end if;$p$;
  v_to := v_from || $p$
  if not private.can_manage_project(v_ws, p_project_id, v_uid) then
    raise exception 'FORBIDDEN: 프로젝트 팀장만 초대할 수 있습니다' using errcode = '42501';
  end if;$p$;
  if (length(d) - length(replace(d, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'patch #30: create_project_invite 고칠 곳을 정확히 한 번 찾지 못했습니다';
  end if;
  execute replace(d, v_from, v_to);

  d := pg_get_functiondef('public.revoke_project_invite(uuid)'::regprocedure);
  v_from := $p$  if v_pi.created_by <> v_uid and not private.has_role(v_pi.workspace_id, array['OWNER']) then
    raise exception 'FORBIDDEN: 초대한 사람이나 관리자만 취소할 수 있습니다' using errcode = '42501';$p$;
  v_to := $p$  if v_pi.created_by <> v_uid and not private.has_role(v_pi.workspace_id, array['OWNER'])
     and not private.is_project_leader(v_pi.workspace_id, v_pi.project_id, v_uid) then
    raise exception 'FORBIDDEN: 초대한 사람, 관리자, 프로젝트 팀장만 취소할 수 있습니다' using errcode = '42501';$p$;
  if (length(d) - length(replace(d, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'patch #30: revoke_project_invite 고칠 곳을 정확히 한 번 찾지 못했습니다';
  end if;
  execute replace(d, v_from, v_to);
end
$mig$;

comment on table public.project_members is '프로젝트 팀원 (이름·역할). 역할 ''팀장''(계정 연결)은 프로젝트 관리 권한 (#30). 그 밖의 역할은 이름표';
comment on column public.project_members.role is '팀장·팀원 또는 직접 입력(예: 디자이너). 팀장만 권한 있음 (#30)';
