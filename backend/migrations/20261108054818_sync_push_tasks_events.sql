-- =====================================================================
-- 10. sync_push 확장: notes + tasks + events
--   - 한 요청(operation)에 세 종류를 섞어 보낼 수 있음 → AI 제안 승인(메모 1 + 할 일 2)을 한 번에 원자 저장
--   - 규칙은 notes와 동일: 멱등성 → 권한 → 공간 잠금 → revision 검사 → 전부 아니면 전무 → seq·원장·receipt
--   - 근거(source_id / source_version_id)는 생성 때만 지정, 이후 수정 불가
--   - tasks: status가 DONE이 되면 completed_at을 서버가 기록, DONE에서 벗어나면 비움
--   - tasks.assignee_id: 현재 ACTIVE 멤버만 지정 가능
-- =====================================================================

create or replace function public.sync_push(
  p_workspace_id  uuid,
  p_operation_id  uuid,
  p_ops           jsonb,
  p_device_id     uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid        uuid := (select auth.uid());
  v_hash       text;
  v_prev       public.sync_operations%rowtype;
  v_head       public.workspace_sync_heads%rowtype;
  v_role       text;
  v_epoch      bigint;
  v_op         jsonb;
  v_entity     text;
  v_kind       text;
  v_id         uuid;
  v_base       bigint;
  v_data       jsonb;
  v_row        jsonb;
  v_taken      boolean;
  v_assignee   uuid;
  v_keys       text[] := '{}';
  v_conflicts  jsonb := '[]'::jsonb;
  v_results    jsonb := '[]'::jsonb;
  v_seq        bigint;
  v_receipt    jsonb;
  v_n          integer;
  i            integer;
begin
  -- 0. 입력 형식
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_workspace_id is null or p_operation_id is null then
    raise exception 'INVALID_REQUEST: workspace_id와 operation_id가 필요합니다' using errcode = '22023';
  end if;
  if jsonb_typeof(p_ops) is distinct from 'array' then
    raise exception 'INVALID_REQUEST: ops는 배열이어야 합니다' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_ops);
  if v_n = 0 or v_n > 100 then
    raise exception 'INVALID_REQUEST: ops는 1~100개' using errcode = '22023';
  end if;

  -- 1. 빠른 권한 거절 (잠금 전)
  if not private.is_active_member(p_workspace_id) then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;

  v_hash := encode(sha256(convert_to(p_ops::text, 'UTF8')), 'hex');

  -- 2. 공간 잠금: 같은 공간의 push를 한 줄로 세움 → seq 순서 = 커밋 순서
  select * into v_head
    from public.workspace_sync_heads
   where workspace_id = p_workspace_id
     for update;
  if not found then
    raise exception 'NOT_FOUND: 공간이 없습니다' using errcode = '22023';
  end if;

  -- 3. 멱등성: 같은 operation_id는 처음 결과를 그대로
  select * into v_prev
    from public.sync_operations
   where workspace_id = p_workspace_id
     and actor_id     = v_uid
     and operation_id = p_operation_id;
  if found then
    if v_prev.payload_hash = v_hash then
      return v_prev.receipt || jsonb_build_object('replayed', true);
    end if;
    raise exception 'OPERATION_ID_REUSED: 같은 operation_id에 다른 내용이 왔습니다' using errcode = '22023';
  end if;

  -- 4. 잠금 아래에서 현재 권한 재확인 (쓰기 가능 역할만)
  select m.role, w.auth_epoch into v_role, v_epoch
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
   where m.workspace_id = p_workspace_id
     and m.account_id   = v_uid
     and m.status       = 'ACTIVE'
     and w.deleted_at is null
     for share of m;
  if v_role is null then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;
  if v_role not in ('OWNER', 'EDITOR') then
    raise exception 'FORBIDDEN: VIEWER는 수정할 수 없습니다' using errcode = '42501';
  end if;

  if p_device_id is not null and not exists (
       select 1 from public.devices
        where id = p_device_id and account_id = v_uid and revoked_at is null) then
    raise exception 'INVALID_REQUEST: 등록되지 않은 기기입니다' using errcode = '22023';
  end if;

  -- 5. 검증·대상 잠금·revision 검사 (아직 아무것도 쓰지 않음)
  for i in 0 .. v_n - 1 loop
    v_op     := p_ops -> i;
    v_entity := v_op ->> 'entity';
    v_kind   := v_op ->> 'op';
    v_data   := coalesce(v_op -> 'data', '{}'::jsonb);
    begin
      v_base := (v_op ->> 'base_revision')::bigint;
      v_id   := (v_op ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'INVALID_REQUEST: ops[%]의 id 또는 base_revision 형식이 잘못됐습니다', i using errcode = '22023';
    end;

    if v_entity is null or v_entity not in ('notes', 'tasks', 'events') then
      raise exception 'UNSUPPORTED_ENTITY: ops[%].entity=% (notes, tasks, events 지원)', i, v_entity using errcode = '22023';
    end if;
    if v_kind is null or v_kind not in ('UPSERT', 'DELETE') then
      raise exception 'INVALID_REQUEST: ops[%].op는 UPSERT 또는 DELETE', i using errcode = '22023';
    end if;
    if v_id is null then
      raise exception 'INVALID_REQUEST: ops[%].id가 필요합니다', i using errcode = '22023';
    end if;
    if v_kind = 'DELETE' and v_base is null then
      raise exception 'INVALID_REQUEST: ops[%] DELETE에는 base_revision이 필요합니다', i using errcode = '22023';
    end if;
    if jsonb_typeof(v_data) is distinct from 'object' then
      raise exception 'INVALID_REQUEST: ops[%].data는 객체여야 합니다', i using errcode = '22023';
    end if;
    if (v_entity || ':' || v_id::text) = any (v_keys) then
      raise exception 'INVALID_REQUEST: 한 요청에 같은 대상이 두 번 있습니다 (ops[%])', i using errcode = '22023';
    end if;
    v_keys := v_keys || (v_entity || ':' || v_id::text);

    -- 담당자는 지금 ACTIVE 멤버여야 함
    if v_entity = 'tasks' and v_data ? 'assignee_id' and v_data ->> 'assignee_id' is not null then
      v_assignee := (v_data ->> 'assignee_id')::uuid;
      if not exists (select 1 from public.workspace_members
                      where workspace_id = p_workspace_id and account_id = v_assignee and status = 'ACTIVE') then
        raise exception 'INVALID_REQUEST: ops[%] 담당자는 이 공간의 ACTIVE 멤버여야 합니다', i using errcode = '22023';
      end if;
    end if;

    -- 대상 행 잠금 (entity는 위에서 3개로 제한했으므로 동적 테이블명 안전)
    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.workspace_id = $2 for update', v_entity)
       into v_row using v_id, p_workspace_id;

    if v_row is null then
      execute format('select exists (select 1 from public.%I where id = $1)', v_entity) into v_taken using v_id;
      if v_taken then
        v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id, 'reason', 'ID_TAKEN');
      elsif v_base is not null then
        v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id, 'reason', 'NOT_FOUND');
      end if;
      -- 그 외: 새로 만들기 (통과)
    elsif v_base is null then
      v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'ALREADY_EXISTS', 'server', v_row);
    elsif (v_row ->> 'revision')::bigint <> v_base then
      v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'REVISION_MISMATCH', 'base_revision', v_base, 'server', v_row);
    elsif v_row ->> 'deleted_at' is not null then
      v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'DELETED', 'server', v_row);
    end if;
  end loop;

  -- 충돌이 하나라도 있으면 전부 거절하고 receipt만 남김 (재전송 시 같은 결과)
  if jsonb_array_length(v_conflicts) > 0 then
    v_receipt := jsonb_build_object(
      'status', 'CONFLICT', 'operation_id', p_operation_id,
      'conflicts', v_conflicts, 'last_seq', v_head.last_seq, 'auth_epoch', v_epoch);
    insert into public.sync_operations (workspace_id, actor_id, device_id, operation_id, payload_hash, status, receipt)
    values (p_workspace_id, v_uid, p_device_id, p_operation_id, v_hash, 'CONFLICT', v_receipt);
    return v_receipt;
  end if;

  -- 6. 적용 + seq 배정 + 변경 원장
  v_seq := v_head.last_seq;
  for i in 0 .. v_n - 1 loop
    v_op     := p_ops -> i;
    v_entity := v_op ->> 'entity';
    v_kind   := v_op ->> 'op';
    v_id     := (v_op ->> 'id')::uuid;
    v_base   := (v_op ->> 'base_revision')::bigint;
    v_data   := coalesce(v_op -> 'data', '{}'::jsonb);

    if v_kind = 'DELETE' then
      -- 휴지통으로 (tombstone)
      execute format('update public.%I t set deleted_at = now(), deleted_by = $1
                       where t.id = $2 and t.workspace_id = $3 returning to_jsonb(t)', v_entity)
         into v_row using v_uid, v_id, p_workspace_id;

    elsif v_entity = 'notes' then
      if v_base is null then
        insert into public.notes as t (id, workspace_id, title, body, source_id, source_version_id, created_by)
        values (v_id, p_workspace_id,
                v_data ->> 'title',
                coalesce(v_data ->> 'body', ''),
                (v_data ->> 'source_id')::uuid,
                (v_data ->> 'source_version_id')::uuid,
                v_uid)
        returning to_jsonb(t) into v_row;
      else
        update public.notes t
           set title = case when v_data ? 'title' then v_data ->> 'title' else t.title end,
               body  = case when v_data ? 'body'  then coalesce(v_data ->> 'body', '') else t.body end
         where t.id = v_id and t.workspace_id = p_workspace_id
        returning to_jsonb(t) into v_row;
      end if;

    elsif v_entity = 'tasks' then
      if v_base is null then
        insert into public.tasks as t
          (id, workspace_id, note_id, project_id, assignee_id, title, description, status, priority,
           due_at, all_day, completed_at, source_version_id, created_by)
        values
          (v_id, p_workspace_id,
           (v_data ->> 'note_id')::uuid,
           (v_data ->> 'project_id')::uuid,
           (v_data ->> 'assignee_id')::uuid,
           v_data ->> 'title',
           v_data ->> 'description',
           coalesce(v_data ->> 'status', 'TODO'),
           coalesce((v_data ->> 'priority')::smallint, 0),
           (v_data ->> 'due_at')::timestamptz,
           coalesce((v_data ->> 'all_day')::boolean, false),
           case when coalesce(v_data ->> 'status', 'TODO') = 'DONE' then now() end,
           (v_data ->> 'source_version_id')::uuid,
           v_uid)
        returning to_jsonb(t) into v_row;
      else
        update public.tasks t
           set title        = case when v_data ? 'title'       then v_data ->> 'title' else t.title end,
               description  = case when v_data ? 'description' then v_data ->> 'description' else t.description end,
               status       = case when v_data ? 'status'      then v_data ->> 'status' else t.status end,
               priority     = case when v_data ? 'priority'    then coalesce((v_data ->> 'priority')::smallint, 0) else t.priority end,
               due_at       = case when v_data ? 'due_at'      then (v_data ->> 'due_at')::timestamptz else t.due_at end,
               all_day      = case when v_data ? 'all_day'     then coalesce((v_data ->> 'all_day')::boolean, false) else t.all_day end,
               note_id      = case when v_data ? 'note_id'     then (v_data ->> 'note_id')::uuid else t.note_id end,
               project_id   = case when v_data ? 'project_id'  then (v_data ->> 'project_id')::uuid else t.project_id end,
               assignee_id  = case when v_data ? 'assignee_id' then (v_data ->> 'assignee_id')::uuid else t.assignee_id end,
               completed_at = case
                                when (case when v_data ? 'status' then v_data ->> 'status' else t.status end) = 'DONE'
                                  then coalesce(t.completed_at, now())
                                else null
                              end
         where t.id = v_id and t.workspace_id = p_workspace_id
        returning to_jsonb(t) into v_row;
      end if;

    else  -- events
      if v_base is null then
        insert into public.events as t
          (id, workspace_id, note_id, project_id, title, description, location,
           start_at, end_at, all_day, timezone, source_version_id, created_by)
        values
          (v_id, p_workspace_id,
           (v_data ->> 'note_id')::uuid,
           (v_data ->> 'project_id')::uuid,
           v_data ->> 'title',
           v_data ->> 'description',
           v_data ->> 'location',
           (v_data ->> 'start_at')::timestamptz,
           (v_data ->> 'end_at')::timestamptz,
           coalesce((v_data ->> 'all_day')::boolean, false),
           coalesce(v_data ->> 'timezone', 'Asia/Seoul'),
           (v_data ->> 'source_version_id')::uuid,
           v_uid)
        returning to_jsonb(t) into v_row;
      else
        update public.events t
           set title       = case when v_data ? 'title'       then v_data ->> 'title' else t.title end,
               description = case when v_data ? 'description' then v_data ->> 'description' else t.description end,
               location    = case when v_data ? 'location'    then v_data ->> 'location' else t.location end,
               start_at    = case when v_data ? 'start_at'    then (v_data ->> 'start_at')::timestamptz else t.start_at end,
               end_at      = case when v_data ? 'end_at'      then (v_data ->> 'end_at')::timestamptz else t.end_at end,
               all_day     = case when v_data ? 'all_day'     then coalesce((v_data ->> 'all_day')::boolean, false) else t.all_day end,
               timezone    = case when v_data ? 'timezone'    then coalesce(v_data ->> 'timezone', 'Asia/Seoul') else t.timezone end,
               note_id     = case when v_data ? 'note_id'     then (v_data ->> 'note_id')::uuid else t.note_id end,
               project_id  = case when v_data ? 'project_id'  then (v_data ->> 'project_id')::uuid else t.project_id end
         where t.id = v_id and t.workspace_id = p_workspace_id
        returning to_jsonb(t) into v_row;
      end if;
    end if;

    v_seq := v_seq + 1;
    insert into public.workspace_changes
      (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
    values
      (p_workspace_id, v_seq, v_entity, v_id::text, 'UPSERT', (v_row ->> 'revision')::bigint, v_row, p_operation_id, v_uid);

    v_results := v_results || jsonb_build_object(
      'index', i, 'entity', v_entity, 'id', v_id, 'revision', (v_row ->> 'revision')::bigint, 'seq', v_seq,
      'deleted', v_row ->> 'deleted_at' is not null);
  end loop;

  update public.workspace_sync_heads
     set last_seq = v_seq, updated_at = now()
   where workspace_id = p_workspace_id;

  v_receipt := jsonb_build_object(
    'status', 'ACCEPTED', 'operation_id', p_operation_id,
    'results', v_results, 'last_seq', v_seq, 'auth_epoch', v_epoch);

  insert into public.sync_operations (workspace_id, actor_id, device_id, operation_id, payload_hash, status, receipt, accepted_seq)
  values (p_workspace_id, v_uid, p_device_id, p_operation_id, v_hash, 'ACCEPTED', v_receipt, v_seq);

  return v_receipt;
end $$;

comment on function public.sync_push(uuid, uuid, jsonb, uuid) is
  'ops: [{"entity":"notes|tasks|events","op":"UPSERT|DELETE","id":"<uuid>","base_revision":<새로 만들면 생략>,"data":{...}}]
   notes  data: title, body, source_id*, source_version_id*
   tasks  data: title, description, status(TODO|IN_PROGRESS|DONE|CANCELED), priority(0~3), due_at, all_day, note_id, project_id, assignee_id, source_version_id*
   events data: title, start_at, end_at, all_day, timezone, location, description, note_id, project_id, source_version_id*
   (* = 생성 때만 지정 가능)';

revoke all on function public.sync_push(uuid, uuid, jsonb, uuid) from public, anon;
grant execute on function public.sync_push(uuid, uuid, jsonb, uuid) to authenticated;
