-- =====================================================================
-- 09. 공유 데이터 저장·동기화 RPC (1차: notes)
--   sync_push     : 멱등성 → 권한 → 공간 잠금 → revision 검사 → 저장 → seq·원장·receipt (한 트랜잭션)
--   sync_pull     : 커서 이후 변경 목록 (커서가 보관 범위 밖이면 SNAPSHOT_REQUIRED)
--   sync_snapshot : 공간 전체를 한 시점(as_of_seq)으로 일관되게 반환
--
-- 응답 규칙 (클라이언트 처리 기준)
--   ACCEPTED  : 저장됨. results[]에 항목별 새 revision·seq
--   CONFLICT  : 아무것도 저장 안 됨(전부 아니면 전무). conflicts[]에 이유와 서버 현재 행
--   같은 operation_id + 같은 내용 재전송 → 처음 receipt 그대로 (+ "replayed": true)
--   예외(HTTP 오류): 28000 로그인 필요 / 42501 권한 없음(403) / 22023 잘못된 요청(400)
--
-- 범위 밖 (의도적으로 MVP 제외): 자동 병합, 서버측 기기별 ACK 저장(원장을 지우지 않는 동안 불필요)
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
  v_note       public.notes%rowtype;
  v_ids        uuid[] := '{}';
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
    v_base   := (v_op ->> 'base_revision')::bigint;
    begin
      v_id := (v_op ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'INVALID_REQUEST: ops[%].id가 UUID가 아닙니다', i using errcode = '22023';
    end;

    if v_entity is distinct from 'notes' then
      raise exception 'UNSUPPORTED_ENTITY: ops[%].entity=% (현재 notes만 지원)', i, v_entity using errcode = '22023';
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
    if v_id = any (v_ids) then
      raise exception 'INVALID_REQUEST: 한 요청에 같은 대상이 두 번 있습니다 (ops[%])', i using errcode = '22023';
    end if;
    v_ids := v_ids || v_id;

    select * into v_note
      from public.notes
     where id = v_id and workspace_id = p_workspace_id
       for update;

    if not found then
      if exists (select 1 from public.notes where id = v_id) then
        v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id, 'reason', 'ID_TAKEN');
      elsif v_base is not null then
        v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id, 'reason', 'NOT_FOUND');
      end if;
      -- 그 외: 새로 만들기 (통과)
    elsif v_base is null then
      v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'ALREADY_EXISTS', 'server', to_jsonb(v_note));
    elsif v_note.revision <> v_base then
      v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'REVISION_MISMATCH', 'base_revision', v_base, 'server', to_jsonb(v_note));
    elsif v_note.deleted_at is not null then
      v_conflicts := v_conflicts || jsonb_build_object('index', i, 'entity', v_entity, 'id', v_id,
                       'reason', 'DELETED', 'server', to_jsonb(v_note));
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
    v_op   := p_ops -> i;
    v_kind := v_op ->> 'op';
    v_id   := (v_op ->> 'id')::uuid;
    v_base := (v_op ->> 'base_revision')::bigint;
    v_data := coalesce(v_op -> 'data', '{}'::jsonb);

    if v_kind = 'UPSERT' and v_base is null then
      insert into public.notes (id, workspace_id, title, body, source_id, source_version_id, created_by)
      values (v_id, p_workspace_id,
              v_data ->> 'title',
              coalesce(v_data ->> 'body', ''),
              (v_data ->> 'source_id')::uuid,
              (v_data ->> 'source_version_id')::uuid,
              v_uid)
      returning * into v_note;
    elsif v_kind = 'UPSERT' then
      -- 근거(source)는 만든 뒤 바꾸지 않음. 제목·본문만 수정
      update public.notes
         set title = case when v_data ? 'title' then v_data ->> 'title' else title end,
             body  = case when v_data ? 'body'  then coalesce(v_data ->> 'body', '') else body end
       where id = v_id and workspace_id = p_workspace_id
      returning * into v_note;
    else  -- DELETE = 휴지통으로 (tombstone)
      update public.notes
         set deleted_at = now(), deleted_by = v_uid
       where id = v_id and workspace_id = p_workspace_id
      returning * into v_note;
    end if;

    v_seq := v_seq + 1;
    insert into public.workspace_changes
      (workspace_id, seq, entity_table, entity_key, op, revision, data, operation_id, actor_id)
    values
      (p_workspace_id, v_seq, 'notes', v_id::text, 'UPSERT', v_note.revision, to_jsonb(v_note), p_operation_id, v_uid);

    v_results := v_results || jsonb_build_object(
      'index', i, 'entity', 'notes', 'id', v_id, 'revision', v_note.revision, 'seq', v_seq,
      'deleted', v_note.deleted_at is not null);
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
  'ops: [{"entity":"notes","op":"UPSERT|DELETE","id":"<uuid>","base_revision":<새로 만들면 생략>,"data":{"title","body","source_id","source_version_id"}}]';

-- ---------------------------------------------------------------------
create or replace function public.sync_pull(
  p_workspace_id  uuid,
  p_after_seq     bigint,
  p_limit         integer default 500
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_head     public.workspace_sync_heads%rowtype;
  v_epoch    bigint;
  v_limit    integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_changes  jsonb;
  v_next     bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not private.is_active_member(p_workspace_id) then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;

  select * into v_head from public.workspace_sync_heads where workspace_id = p_workspace_id;
  select auth_epoch into v_epoch from public.workspaces where id = p_workspace_id;

  if p_after_seq is null or p_after_seq < v_head.min_retained_seq or p_after_seq > v_head.last_seq then
    return jsonb_build_object(
      'status', 'SNAPSHOT_REQUIRED',
      'last_seq', v_head.last_seq, 'min_retained_seq', v_head.min_retained_seq, 'auth_epoch', v_epoch);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', c.seq, 'entity', c.entity_table, 'key', c.entity_key, 'op', c.op,
           'revision', c.revision, 'data', c.data, 'operation_id', c.operation_id,
           'actor_id', c.actor_id, 'committed_at', c.committed_at) order by c.seq), '[]'::jsonb),
         max(c.seq)
    into v_changes, v_next
    from (select *
            from public.workspace_changes
           where workspace_id = p_workspace_id and seq > p_after_seq
           order by seq
           limit v_limit) c;

  v_next := coalesce(v_next, p_after_seq);
  return jsonb_build_object(
    'status', 'OK', 'changes', v_changes,
    'next_seq', v_next, 'has_more', v_next < v_head.last_seq,
    'last_seq', v_head.last_seq, 'auth_epoch', v_epoch);
end $$;

-- ---------------------------------------------------------------------
-- 스냅샷: 공간 잠금(공유)을 잡아 진행 중인 push가 끝나길 기다리고, 읽는 동안 새 push를 막음
--         → as_of_seq와 반환 데이터가 같은 시점. 이후 sync_pull(as_of_seq)로 이어서 받으면 됨
-- ---------------------------------------------------------------------
create or replace function public.sync_snapshot(p_workspace_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_head   public.workspace_sync_heads%rowtype;
  v_epoch  bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not private.is_active_member(p_workspace_id) then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;

  select * into v_head from public.workspace_sync_heads where workspace_id = p_workspace_id for share;
  select auth_epoch into v_epoch from public.workspaces where id = p_workspace_id;

  return jsonb_build_object(
    'status', 'OK',
    'as_of_seq', v_head.last_seq,
    'auth_epoch', v_epoch,
    'workspace', (select to_jsonb(w) from public.workspaces w where w.id = p_workspace_id),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                   'account_id', m.account_id, 'role', m.role, 'status', m.status,
                   'display_name', p.display_name, 'avatar_path', p.avatar_path)), '[]'::jsonb)
                  from public.workspace_members m
                  left join public.profiles p on p.account_id = m.account_id
                 where m.workspace_id = p_workspace_id),
    'projects',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.projects t             where t.workspace_id = p_workspace_id),
    'project_participants', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_participants t where t.workspace_id = p_workspace_id),
    'input_sources',        (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.input_sources t        where t.workspace_id = p_workspace_id),
    'source_text_versions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.source_text_versions t where t.workspace_id = p_workspace_id),
    'notes',                (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.notes t                where t.workspace_id = p_workspace_id),
    'note_projects',        (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.note_projects t        where t.workspace_id = p_workspace_id),
    'note_attachments',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.note_attachments t     where t.workspace_id = p_workspace_id),
    'assets',               (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.assets t               where t.workspace_id = p_workspace_id and t.status = 'AVAILABLE'),
    'tasks',                (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.tasks t                where t.workspace_id = p_workspace_id),
    'events',               (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.events t               where t.workspace_id = p_workspace_id),
    'meetings',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.meetings t             where t.workspace_id = p_workspace_id),
    'agenda_items',         (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.agenda_items t         where t.workspace_id = p_workspace_id),
    'agenda_transitions',   (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.agenda_transitions t   where t.workspace_id = p_workspace_id)
  );
end $$;

-- ---------------------------------------------------------------------
-- 실행 권한: 로그인 사용자만
-- ---------------------------------------------------------------------
revoke all on function public.sync_push(uuid, uuid, jsonb, uuid) from public, anon;
revoke all on function public.sync_pull(uuid, bigint, integer)   from public, anon;
revoke all on function public.sync_snapshot(uuid)                from public, anon;
grant execute on function public.sync_push(uuid, uuid, jsonb, uuid) to authenticated;
grant execute on function public.sync_pull(uuid, bigint, integer)   to authenticated;
grant execute on function public.sync_snapshot(uuid)                to authenticated;
