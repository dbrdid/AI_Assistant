-- =====================================================================
-- 13. 리뷰 반영
--  (1) sync_push: 원문(input_sources)·확정 원문 버전(source_text_versions)·메모 첨부(note_attachments) 저장 경로 추가
--      - input_sources / source_text_versions: 만들기만 가능 (원문 불변). 버전 번호는 서버가 잠금 아래에서 배정
--      - input_sources.asset_id / note_attachments: 같은 공간의 ATTACHMENT + AVAILABLE(업로드 검증 완료) 파일만
--  (4) sync_push: 잠금 획득 후 "현재 권한 재확인"을 "기존 receipt 반환"보다 먼저
--  (3) AI 정산: 결과 불명(UNKNOWN)은 공급자 비용이 났을 수 있으므로 사용 횟수에 포함
--      - 사용자 횟수: SUCCEEDED + UNKNOWN / 제외: FAILED
--      - 공급자 비용: 토큰 수로 별도 기록 (FAILED라도 토큰이 쓰였으면 남김)
--      - 오래 RESERVED로 남은 요청(정산 실패 등)은 ai_reconcile_stale()이 UNKNOWN으로 정리
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1)(4) sync_push
-- ---------------------------------------------------------------------
create or replace function public.sync_push(
  p_workspace_id  uuid,
  p_operation_id  uuid,
  p_ops           jsonb,
  p_device_id     uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid         uuid := (select auth.uid());
  v_hash        text;
  v_prev        public.sync_operations%rowtype;
  v_head        public.workspace_sync_heads%rowtype;
  v_role        text;
  v_epoch       bigint;
  v_op          jsonb;
  v_entity      text;
  v_cls         text;   -- REV(revision 대상) / IMMUTABLE(만들기만) / LINK(연결)
  v_kind        text;
  v_id          uuid;
  v_base        bigint;
  v_data        jsonb;
  v_row         jsonb;
  v_tmp         jsonb;
  v_trans       jsonb;
  v_taken       boolean;
  v_key         text;
  v_a           uuid;
  v_b           uuid;
  v_assignee    uuid;
  v_asset       uuid;
  v_meeting     uuid;
  v_carry_from  uuid;
  v_carry_mtg   uuid;
  v_old_status  text;
  v_version     integer;
  v_keys        text[] := '{}';
  v_conflicts   jsonb := '[]'::jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_seq         bigint;
  v_receipt     jsonb;
  v_n           integer;
  i             integer;
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

  -- 3. 잠금 아래에서 현재 권한 재확인 (재전송 receipt 반환보다 먼저)
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

  -- 4. 멱등성: 같은 operation_id는 처음 결과를 그대로
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

    v_cls := case
      when v_entity in ('notes', 'tasks', 'events', 'projects', 'meetings', 'agenda_items') then 'REV'
      when v_entity in ('input_sources', 'source_text_versions') then 'IMMUTABLE'
      when v_entity in ('note_projects', 'project_participants', 'note_attachments') then 'LINK'
    end;
    if v_cls is null then
      raise exception 'UNSUPPORTED_ENTITY: ops[%].entity=%', i, v_entity using errcode = '22023';
    end if;
    if v_kind is null or v_kind not in ('UPSERT', 'DELETE') then
      raise exception 'INVALID_REQUEST: ops[%].op는 UPSERT 또는 DELETE', i using errcode = '22023';
    end if;
    if jsonb_typeof(v_data) is distinct from 'object' then
      raise exception 'INVALID_REQUEST: ops[%].data는 객체여야 합니다', i using errcode = '22023';
    end if;

    if v_cls = 'LINK' then
      -- ---------- 연결 테이블: data의 두 키로 대상 지정 ----------
      begin
        if v_entity = 'note_projects' then
          v_a := (v_data ->> 'note_id')::uuid;    v_b := (v_data ->> 'project_id')::uuid;
        elsif v_entity = 'project_participants' then
          v_a := (v_data ->> 'project_id')::uuid; v_b := (v_data ->> 'account_id')::uuid;
        else
          v_a := (v_data ->> 'note_id')::uuid;    v_b := (v_data ->> 'asset_id')::uuid;
        end if;
      exception when invalid_text_representation then
        raise exception 'INVALID_REQUEST: ops[%] 연결 키 형식이 잘못됐습니다', i using errcode = '22023';
      end;
      if v_a is null or v_b is null then
        raise exception 'INVALID_REQUEST: ops[%] 연결할 두 키가 필요합니다 (note_projects: note_id·project_id / project_participants: project_id·account_id / note_attachments: note_id·asset_id)', i
          using errcode = '22023';
      end if;
      v_key := v_entity || ':' || v_a::text || ':' || v_b::text;

      if v_entity = 'project_participants' and v_kind = 'UPSERT' and not exists (
           select 1 from public.workspace_members
            where workspace_id = p_workspace_id and account_id = v_b and status = 'ACTIVE') then
        raise exception 'INVALID_REQUEST: ops[%] 참여자는 이 공간의 ACTIVE 멤버여야 합니다', i using errcode = '22023';
      end if;
      if v_entity = 'note_attachments' and v_kind = 'UPSERT' and not exists (
           select 1 from public.assets
            where id = v_b and workspace_id = p_workspace_id
              and purpose = 'ATTACHMENT' and status = 'AVAILABLE') then
        raise exception 'INVALID_REQUEST: ops[%] 업로드 검증이 끝난(AVAILABLE) 이 공간의 첨부만 연결할 수 있습니다', i using errcode = '22023';
      end if;

    else
      -- ---------- id 대상 (REV / IMMUTABLE) ----------
      begin
        v_base := (v_op ->> 'base_revision')::bigint;
        v_id   := (v_op ->> 'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'INVALID_REQUEST: ops[%]의 id 또는 base_revision 형식이 잘못됐습니다', i using errcode = '22023';
      end;
      if v_id is null then
        raise exception 'INVALID_REQUEST: ops[%].id가 필요합니다', i using errcode = '22023';
      end if;
      v_key := v_entity || ':' || v_id::text;

      if v_cls = 'IMMUTABLE' then
        if v_kind <> 'UPSERT' or v_base is not null then
          raise exception 'IMMUTABLE: ops[%] 원문과 확정 원문 버전은 만든 뒤 수정·삭제할 수 없습니다', i using errcode = '22023';
        end if;
        if v_entity = 'input_sources' and v_data ->> 'asset_id' is not null then
          v_asset := (v_data ->> 'asset_id')::uuid;
          if not exists (select 1 from public.assets
                          where id = v_asset and workspace_id = p_workspace_id
                            and purpose = 'ATTACHMENT' and status = 'AVAILABLE') then
            raise exception 'INVALID_REQUEST: ops[%] 업로드 검증이 끝난(AVAILABLE) 이 공간의 파일만 원본으로 쓸 수 있습니다', i using errcode = '22023';
          end if;
        end if;
        if v_entity = 'source_text_versions' then
          if v_data ->> 'source_id' is null then
            raise exception 'INVALID_REQUEST: ops[%] source_id가 필요합니다', i using errcode = '22023';
          end if;
          if coalesce(btrim(v_data ->> 'text'), '') = '' then
            raise exception 'INVALID_REQUEST: ops[%] 확정 원문(text)이 비어 있습니다', i using errcode = '22023';
          end if;
        end if;
      else
        if v_kind = 'DELETE' and v_base is null then
          raise exception 'INVALID_REQUEST: ops[%] DELETE에는 base_revision이 필요합니다', i using errcode = '22023';
        end if;
        -- 담당자는 지금 ACTIVE 멤버여야 함
        if v_entity = 'tasks' and v_data ? 'assignee_id' and v_data ->> 'assignee_id' is not null then
          v_assignee := (v_data ->> 'assignee_id')::uuid;
          if not exists (select 1 from public.workspace_members
                          where workspace_id = p_workspace_id and account_id = v_assignee and status = 'ACTIVE') then
            raise exception 'INVALID_REQUEST: ops[%] 담당자는 이 공간의 ACTIVE 멤버여야 합니다', i using errcode = '22023';
          end if;
        end if;
      end if;

      -- 대상 행 잠금 (entity는 위 목록으로 제한했으므로 동적 테이블명 안전)
      execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.workspace_id = $2 for update', v_entity)
         into v_row using v_id, p_workspace_id;

      if v_row is null then
        execute format('select exists (select 1 from public.%I where id = $1)', v_entity) into v_taken using v_id;
        if v_taken then
          v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id, 'reason', 'ID_TAKEN');
        elsif v_base is not null then
          v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id, 'reason', 'NOT_FOUND');
        elsif v_entity = 'agenda_items' and v_data ->> 'carried_from_id' is not null then
          -- 이월 생성 검사
          v_meeting    := (v_data ->> 'meeting_id')::uuid;
          v_carry_from := (v_data ->> 'carried_from_id')::uuid;
          select a.meeting_id into v_carry_mtg
            from public.agenda_items a
           where a.id = v_carry_from and a.workspace_id = p_workspace_id;
          if v_carry_mtg is null then
            raise exception 'INVALID_REQUEST: ops[%] 이월 원본 안건이 이 공간에 없습니다', i using errcode = '22023';
          end if;
          if v_carry_mtg = v_meeting then
            raise exception 'INVALID_REQUEST: ops[%] 같은 회의로는 이월할 수 없습니다', i using errcode = '22023';
          end if;
          select to_jsonb(a) into v_tmp
            from public.agenda_items a
           where a.workspace_id = p_workspace_id and a.meeting_id = v_meeting and a.carried_from_id = v_carry_from;
          if v_tmp is not null then
            v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                             'reason', 'ALREADY_CARRIED', 'server', v_tmp);
          end if;
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
    end if;

    if v_key = any (v_keys) then
      raise exception 'INVALID_REQUEST: 한 요청에 같은 대상이 두 번 있습니다 (ops[%])', i using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
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

  -- 6. 적용 + seq 배정 + 변경 원장 (ops 순서대로: 원문 → 버전 → 메모 순으로 보내야 FK가 맞음)
  v_seq := v_head.last_seq;
  for i in 0 .. v_n - 1 loop
    v_op     := p_ops -> i;
    v_entity := v_op ->> 'entity';
    v_kind   := v_op ->> 'op';
    v_data   := coalesce(v_op -> 'data', '{}'::jsonb);
    v_trans  := null;
    v_version := null;

    -- ---------- 연결 테이블 ----------
    if v_entity in ('note_projects', 'project_participants', 'note_attachments') then
      if v_entity = 'note_projects' then
        v_a := (v_data ->> 'note_id')::uuid; v_b := (v_data ->> 'project_id')::uuid;
        if v_kind = 'UPSERT' then
          insert into public.note_projects as t (workspace_id, note_id, project_id)
          values (p_workspace_id, v_a, v_b)
          on conflict do nothing
          returning to_jsonb(t) into v_row;
        else
          delete from public.note_projects t
           where t.workspace_id = p_workspace_id and t.note_id = v_a and t.project_id = v_b
          returning to_jsonb(t) into v_row;
        end if;
      elsif v_entity = 'project_participants' then
        v_a := (v_data ->> 'project_id')::uuid; v_b := (v_data ->> 'account_id')::uuid;
        if v_kind = 'UPSERT' then
          insert into public.project_participants as t (workspace_id, project_id, account_id)
          values (p_workspace_id, v_a, v_b)
          on conflict do nothing
          returning to_jsonb(t) into v_row;
        else
          delete from public.project_participants t
           where t.workspace_id = p_workspace_id and t.project_id = v_a and t.account_id = v_b
          returning to_jsonb(t) into v_row;
        end if;
      else
        v_a := (v_data ->> 'note_id')::uuid; v_b := (v_data ->> 'asset_id')::uuid;
        if v_kind = 'UPSERT' then
          insert into public.note_attachments as t (workspace_id, note_id, asset_id, position, added_by)
          values (p_workspace_id, v_a, v_b, coalesce((v_data ->> 'position')::integer, 0), v_uid)
          on conflict do nothing
          returning to_jsonb(t) into v_row;
        else
          delete from public.note_attachments t
           where t.workspace_id = p_workspace_id and t.note_id = v_a and t.asset_id = v_b
          returning to_jsonb(t) into v_row;
        end if;
      end if;

      if v_row is null then
        -- 이미 연결돼 있거나 이미 해제된 상태: 변화 없음, seq 소비 안 함
        v_results := v_results || jsonb_build_object(
          'index', i, 'entity', v_entity, 'key', v_a::text || ':' || v_b::text, 'unchanged', true);
        continue;
      end if;

      v_seq := v_seq + 1;
      insert into public.workspace_changes
        (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
      values
        (p_workspace_id, v_seq, v_entity, v_a::text || ':' || v_b::text, v_kind, null,
         case when v_kind = 'UPSERT' then v_row end, p_operation_id, v_uid);
      v_results := v_results || jsonb_build_object(
        'index', i, 'entity', v_entity, 'key', v_a::text || ':' || v_b::text, 'seq', v_seq, 'op', v_kind);
      continue;
    end if;

    v_id   := (v_op ->> 'id')::uuid;
    v_base := (v_op ->> 'base_revision')::bigint;

    -- ---------- 원문 / 확정 원문 버전 (만들기만) ----------
    if v_entity = 'input_sources' then
      insert into public.input_sources as t (id, workspace_id, kind, original_text, asset_id, created_by)
      values (v_id, p_workspace_id,
              v_data ->> 'kind',
              v_data ->> 'original_text',
              (v_data ->> 'asset_id')::uuid,
              v_uid)
      returning to_jsonb(t) into v_row;

    elsif v_entity = 'source_text_versions' then
      -- 버전 번호는 서버가 배정 (공간 잠금 아래라 동시 확정에도 겹치지 않음)
      select coalesce(max(s.version), 0) + 1 into v_version
        from public.source_text_versions s
       where s.workspace_id = p_workspace_id and s.source_id = (v_data ->> 'source_id')::uuid;
      insert into public.source_text_versions as t (id, workspace_id, source_id, version, text, confirmed_by)
      values (v_id, p_workspace_id, (v_data ->> 'source_id')::uuid, v_version, v_data ->> 'text', v_uid)
      returning to_jsonb(t) into v_row;

    -- ---------- revision 대상 ----------
    elsif v_kind = 'DELETE' then
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

    elsif v_entity = 'events' then
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

    elsif v_entity = 'projects' then
      if v_base is null then
        insert into public.projects as t (id, workspace_id, name, description, status, created_by)
        values (v_id, p_workspace_id,
                v_data ->> 'name',
                v_data ->> 'description',
                coalesce(v_data ->> 'status', 'ACTIVE'),
                v_uid)
        returning to_jsonb(t) into v_row;
      else
        update public.projects t
           set name        = case when v_data ? 'name'        then v_data ->> 'name' else t.name end,
               description = case when v_data ? 'description' then v_data ->> 'description' else t.description end,
               status      = case when v_data ? 'status'      then v_data ->> 'status' else t.status end
         where t.id = v_id and t.workspace_id = p_workspace_id
        returning to_jsonb(t) into v_row;
      end if;

    elsif v_entity = 'meetings' then
      if v_base is null then
        insert into public.meetings as t (id, workspace_id, project_id, title, starts_at, ends_at, status, created_by)
        values (v_id, p_workspace_id,
                (v_data ->> 'project_id')::uuid,
                v_data ->> 'title',
                (v_data ->> 'starts_at')::timestamptz,
                (v_data ->> 'ends_at')::timestamptz,
                coalesce(v_data ->> 'status', 'SCHEDULED'),
                v_uid)
        returning to_jsonb(t) into v_row;
      else
        update public.meetings t
           set title      = case when v_data ? 'title'      then v_data ->> 'title' else t.title end,
               project_id = case when v_data ? 'project_id' then (v_data ->> 'project_id')::uuid else t.project_id end,
               starts_at  = case when v_data ? 'starts_at'  then (v_data ->> 'starts_at')::timestamptz else t.starts_at end,
               ends_at    = case when v_data ? 'ends_at'    then (v_data ->> 'ends_at')::timestamptz else t.ends_at end,
               status     = case when v_data ? 'status'     then v_data ->> 'status' else t.status end
         where t.id = v_id and t.workspace_id = p_workspace_id
        returning to_jsonb(t) into v_row;
      end if;

    else  -- agenda_items
      if v_base is null then
        insert into public.agenda_items as t
          (id, workspace_id, meeting_id, title, description, status, position, carried_from_id, created_by)
        values
          (v_id, p_workspace_id,
           (v_data ->> 'meeting_id')::uuid,
           v_data ->> 'title',
           v_data ->> 'description',
           coalesce(v_data ->> 'status', 'OPEN'),
           coalesce((v_data ->> 'position')::integer, 0),
           (v_data ->> 'carried_from_id')::uuid,
           v_uid)
        returning to_jsonb(t) into v_row;
      else
        select a.status into v_old_status
          from public.agenda_items a
         where a.id = v_id and a.workspace_id = p_workspace_id;

        update public.agenda_items t
           set title       = case when v_data ? 'title'       then v_data ->> 'title' else t.title end,
               description = case when v_data ? 'description' then v_data ->> 'description' else t.description end,
               status      = case when v_data ? 'status'      then v_data ->> 'status' else t.status end,
               position    = case when v_data ? 'position'    then coalesce((v_data ->> 'position')::integer, 0) else t.position end
         where t.id = v_id and t.workspace_id = p_workspace_id
        returning to_jsonb(t) into v_row;

        -- 상태가 실제로 바뀌었으면 이력 기록 (행위자 = 로그인 사용자)
        if v_old_status is distinct from (v_row ->> 'status') then
          insert into public.agenda_transitions as t
            (workspace_id, agenda_item_id, from_status, to_status, actor_id, revision)
          values
            (p_workspace_id, v_id, v_old_status, v_row ->> 'status', v_uid, (v_row ->> 'revision')::bigint)
          returning to_jsonb(t) into v_trans;
        end if;
      end if;
    end if;

    v_seq := v_seq + 1;
    insert into public.workspace_changes
      (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
    values
      (p_workspace_id, v_seq, v_entity, v_id::text, 'UPSERT', (v_row ->> 'revision')::bigint, v_row, p_operation_id, v_uid);
    v_results := v_results || jsonb_strip_nulls(jsonb_build_object(
      'index', i, 'entity', v_entity, 'id', v_id, 'revision', (v_row ->> 'revision')::bigint, 'seq', v_seq,
      'deleted', v_row ->> 'deleted_at' is not null, 'version', v_version));

    if v_trans is not null then
      v_seq := v_seq + 1;
      insert into public.workspace_changes
        (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
      values
        (p_workspace_id, v_seq, 'agenda_transitions', v_trans ->> 'id', 'UPSERT', null, v_trans, p_operation_id, v_uid);
      v_results := v_results || jsonb_build_object(
        'index', i, 'entity', 'agenda_transitions', 'id', v_trans ->> 'id', 'seq', v_seq);
    end if;
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
  'ops: [{"entity":..., "op":"UPSERT|DELETE", "id":"<uuid>", "base_revision":<생성 시 생략>, "data":{...}}]  (ops 순서대로 적용)
   notes        data: title, body, source_id*, source_version_id*
   tasks        data: title, description, status(TODO|IN_PROGRESS|DONE|CANCELED), priority(0~3), due_at, all_day, note_id, project_id, assignee_id, source_version_id*
   events       data: title, start_at, end_at, all_day, timezone, location, description, note_id, project_id, source_version_id*
   projects     data: name, description, status(ACTIVE|ARCHIVED)
   meetings     data: title, project_id, starts_at, ends_at, status(SCHEDULED|DONE|CANCELED)
   agenda_items data: meeting_id*, title, description, status(OPEN|DISCUSSED|DEFERRED|CARRIED_OVER|CLOSED), position, carried_from_id*
   만들기만(UPSERT, base_revision 없음):
     input_sources        data: kind(TEXT|VOICE|IMAGE|DOCUMENT), original_text, asset_id(AVAILABLE 첨부)
     source_text_versions data: source_id, text   → 버전 번호는 서버가 배정(results[].version)
   연결(id·base_revision 없음):
     note_projects {note_id, project_id} / project_participants {project_id, account_id} / note_attachments {note_id, asset_id, position}
   (* = 생성 때만 지정 가능)';

revoke all on function public.sync_push(uuid, uuid, jsonb, uuid) from public, anon;
grant execute on function public.sync_push(uuid, uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- (3) AI 정산: UNKNOWN은 사용 횟수에 포함
-- ---------------------------------------------------------------------
comment on column public.ai_requests.charged_units is
  '사용자 이용 횟수에 반영된 수: SUCCEEDED·UNKNOWN 1, FAILED 0. 공급자 비용은 input/output_tokens로 별도 추적';

create or replace function public.ai_finish_request(
  p_request_id           uuid,
  p_status               text,
  p_provider_request_id  text default null,
  p_input_tokens         integer default null,
  p_output_tokens        integer default null,
  p_error_code           text default null
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_req     public.ai_requests%rowtype;
  v_period  date;
  v_counts  boolean := p_status in ('SUCCEEDED', 'UNKNOWN');  -- 결과 불명도 비용이 났을 수 있으므로 포함
begin
  if p_status not in ('SUCCEEDED', 'FAILED', 'UNKNOWN') then
    raise exception 'INVALID_STATUS: %', p_status using errcode = '22023';
  end if;

  update public.ai_requests
     set status              = p_status,
         provider_request_id = p_provider_request_id,
         input_tokens        = p_input_tokens,
         output_tokens       = p_output_tokens,
         error_code          = p_error_code,
         charged_units       = case when v_counts then 1 else 0 end,
         completed_at        = now()
   where id = p_request_id and status = 'RESERVED'
  returning * into v_req;

  if v_req.id is null then
    return;  -- 이미 정산됨 (중복 호출 무시)
  end if;

  v_period := date_trunc('month', v_req.created_at at time zone 'Asia/Seoul')::date;
  update public.usage_counters
     set reserved = greatest(reserved - 1, 0),
         used     = used + case when v_counts then 1 else 0 end
   where account_id = v_req.account_id
     and metric = 'AI_' || upper(v_req.endpoint)
     and period_start = v_period;
end $$;

-- 오래 RESERVED로 남은 요청 정리 (정산 실패, Edge Function 중단 등) → UNKNOWN으로 정산
create or replace function public.ai_reconcile_stale(p_older_than interval default interval '10 minutes')
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_id  uuid;
  v_n   integer := 0;
begin
  for v_id in
    select id from public.ai_requests
     where status = 'RESERVED' and created_at < now() - p_older_than
     order by created_at
     for update skip locked
  loop
    perform public.ai_finish_request(v_id, 'UNKNOWN', null, null, null, 'STALE_RESERVATION');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.ai_begin_request(
  p_account_id         uuid,
  p_client_request_id  uuid,
  p_endpoint           text,
  p_workspace_id       uuid,
  p_input_hash         text,
  p_provider           text,
  p_model              text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_metric   text := 'AI_' || upper(p_endpoint);
  v_period   date := date_trunc('month', now() at time zone 'Asia/Seoul')::date;
  v_consent  uuid;
  v_plan     text;
  v_limit    integer;
  v_prev     public.ai_requests%rowtype;
  v_used     bigint;
  v_reserved bigint;
  v_id       uuid;
begin
  if p_account_id is null or p_client_request_id is null or p_endpoint is null or p_input_hash is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  -- 공유 공간 기록을 보낼 때는 지금도 ACTIVE 멤버여야 함 (개인 기록은 workspace_id 없음)
  if p_workspace_id is not null and not exists (
       select 1 from public.workspace_members m
         join public.workspaces w on w.id = m.workspace_id
        where m.workspace_id = p_workspace_id and m.account_id = p_account_id
          and m.status = 'ACTIVE' and w.deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;

  -- 외부 AI 전송 동의 (로그인 ≠ 외부 전송 동의)
  select c.id into v_consent
    from public.consents c
   where c.account_id = p_account_id and c.consent_type = 'EXTERNAL_AI' and c.revoked_at is null
   order by c.granted_at desc
   limit 1;
  if v_consent is null then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED');
  end if;

  -- 같은 client_request_id 재요청 처리
  select * into v_prev
    from public.ai_requests
   where account_id = p_account_id and client_request_id = p_client_request_id
     for update;
  if found then
    if v_prev.status = 'RESERVED' and v_prev.created_at < now() - interval '10 minutes' then
      -- 정산되지 못하고 남은 예약 → 결과 불명으로 정리
      perform public.ai_finish_request(v_prev.id, 'UNKNOWN', null, null, null, 'STALE_RESERVATION');
      return jsonb_build_object('ok', false, 'code', 'RESULT_UNKNOWN', 'request_id', v_prev.id);
    elsif v_prev.status = 'RESERVED' then
      return jsonb_build_object('ok', false, 'code', 'IN_PROGRESS', 'request_id', v_prev.id);
    elsif v_prev.status = 'UNKNOWN' then
      return jsonb_build_object('ok', false, 'code', 'RESULT_UNKNOWN', 'request_id', v_prev.id);
    elsif v_prev.status = 'SUCCEEDED' then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_DONE', 'request_id', v_prev.id);
    elsif v_prev.input_hash <> p_input_hash then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_REUSED');
    end if;
    -- FAILED → 같은 ID로 재시도 허용 (아래에서 다시 예약)
  end if;

  -- 월 사용량 예약 (한도 초과면 원자적으로 거절)
  select coalesce((select s.plan from public.subscriptions s
                    where s.account_id = p_account_id and s.status = 'ACTIVE'), 'FREE')
    into v_plan;
  v_limit := private.ai_monthly_limit(v_plan, p_endpoint);

  insert into public.usage_counters as u (account_id, metric, period_start, used, reserved)
  values (p_account_id, v_metric, v_period, 0, 1)
  on conflict (account_id, metric, period_start) do update
     set reserved = u.reserved + 1
   where u.used + u.reserved < v_limit
  returning u.used, u.reserved into v_used, v_reserved;

  if v_used is null then
    return jsonb_build_object('ok', false, 'code', 'QUOTA_EXCEEDED', 'limit', v_limit, 'plan', v_plan);
  end if;

  -- 요청 원장 (본문 없이 해시·상태만)
  if v_prev.id is not null then
    update public.ai_requests
       set status = 'RESERVED', reserved_units = 1, charged_units = null, error_code = null,
           provider = p_provider, model = p_model, consent_id = v_consent,
           provider_request_id = null, input_tokens = null, output_tokens = null,
           created_at = now(), completed_at = null
     where id = v_prev.id
    returning id into v_id;
  else
    insert into public.ai_requests
      (account_id, workspace_id, consent_id, client_request_id, endpoint, input_hash,
       provider, model, status, reserved_units)
    values
      (p_account_id, p_workspace_id, v_consent, p_client_request_id, p_endpoint, p_input_hash,
       p_provider, p_model, 'RESERVED', 1)
    returning id into v_id;
  end if;

  -- remaining = 이번 요청 예약까지 반영한 남은 횟수 (Gateway는 그대로 전달)
  return jsonb_build_object(
    'ok', true, 'request_id', v_id, 'consent_id', v_consent,
    'plan', v_plan, 'limit', v_limit, 'remaining', v_limit - v_used - v_reserved);
end $$;

revoke all on function public.ai_begin_request(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_finish_request(uuid, text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.ai_reconcile_stale(interval) from public, anon, authenticated;
grant execute on function public.ai_begin_request(uuid, uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.ai_finish_request(uuid, text, text, integer, integer, text) to service_role;
grant execute on function public.ai_reconcile_stale(interval) to service_role;
