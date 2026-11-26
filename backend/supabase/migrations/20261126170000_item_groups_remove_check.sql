-- 보안 수정: set_item_groups에서 '편집' 권한만 있는 멤버가 공개 그룹을 빼서(빈 목록 포함) 제한된 문서·할 일을
-- 공간 전체에 공개할 수 있었다. 이미 걸린 그룹을 빼려면 그 그룹을 관리할 수 있어야 한다 (20261126060000_project_groups의 함수를 대체).

create or replace function public.set_item_groups(p_workspace_id uuid, p_entity text, p_key uuid, p_group_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_creator uuid; v_access text; v_g uuid; v_project uuid; r record;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_entity = 'notes' then select created_by into v_creator from public.notes where workspace_id = p_workspace_id and id = p_key;
  elsif p_entity = 'tasks' then select created_by into v_creator from public.tasks where workspace_id = p_workspace_id and id = p_key;
  else raise exception 'INVALID_REQUEST: 문서(notes)나 할 일(tasks)만 정할 수 있어요' using errcode = '22023';
  end if;
  if v_creator is null then raise exception 'NOT_FOUND: 항목이 없어요' using errcode = 'P0002'; end if;
  v_access := private.item_access(p_workspace_id, p_entity, p_key, v_creator);
  if v_access is null or v_access = 'view' then
    raise exception 'FORBIDDEN: 이 항목을 고칠 권한이 없어요' using errcode = '42501';
  end if;
  foreach v_g in array coalesce(p_group_ids, '{}') loop
    select project_id into v_project from public.project_groups where workspace_id = p_workspace_id and id = v_g and deleted_at is null;
    if v_project is null then raise exception 'NOT_FOUND: 그룹이 없어요' using errcode = 'P0002'; end if;
    if not private.can_manage_group(p_workspace_id, v_project, v_g) then
      raise exception 'FORBIDDEN: 그룹을 관리할 권한이 없어요' using errcode = '42501';
    end if;
  end loop;
  -- 이미 걸린 공개 그룹을 빼려면 그 그룹도 관리할 수 있어야 함 (편집 권한만으로 제한을 풀 수 없게)
  for v_g in
    select group_id from public.item_group_access
     where workspace_id = p_workspace_id and entity = p_entity and entity_key = p_key and deleted_at is null
       and not (group_id = any (coalesce(p_group_ids, '{}')))
  loop
    select project_id into v_project from public.project_groups where workspace_id = p_workspace_id and id = v_g;
    if v_project is not null and not private.can_manage_group(p_workspace_id, v_project, v_g) then
      raise exception 'FORBIDDEN: 공개 범위에서 그룹을 빼려면 그 그룹을 관리할 수 있어야 해요' using errcode = '42501';
    end if;
  end loop;
  -- 빠진 그룹은 지우고, 새 그룹은 넣음 (지운 적 있으면 되살림)
  for r in update public.item_group_access set deleted_at = now(), revision = revision + 1, updated_at = now()
            where workspace_id = p_workspace_id and entity = p_entity and entity_key = p_key and deleted_at is null
              and not (group_id = any (coalesce(p_group_ids, '{}'))) returning * loop
    perform private.log_row_change(p_workspace_id, 'item_group_access', r.id::text, to_jsonb(r), v_uid);
  end loop;
  for r in insert into public.item_group_access (workspace_id, entity, entity_key, group_id, created_by)
            select p_workspace_id, p_entity, p_key, g, v_uid from unnest(coalesce(p_group_ids, '{}')) g
           on conflict (entity, entity_key, group_id) do update
             set deleted_at = null, revision = public.item_group_access.revision + 1, updated_at = now()
             where public.item_group_access.deleted_at is not null
           returning * loop
    perform private.log_row_change(p_workspace_id, 'item_group_access', r.id::text, to_jsonb(r), v_uid);
  end loop;
  perform private.mark_access_changed(p_workspace_id);
end $$;
