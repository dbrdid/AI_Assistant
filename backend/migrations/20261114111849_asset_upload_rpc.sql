-- =====================================================================
-- 첨부·백업 업로드 RPC (Edge Function `assets` 전용, service_role만 실행)
--
--   흐름  ① asset_prepare   : 검사 후 PENDING 행 생성 → Edge Function이 서명 업로드 URL 발급
--         ② (앱) 서명 URL로 Storage에 직접 업로드
--         ③ asset_complete  : Edge Function이 실제 객체를 받아 크기·SHA-256·형식을 계산해서 넘김
--                             → 선언값과 같고 권한이 그대로면 AVAILABLE + 동기화 원장 기록(다른 기기에 전달)
--                             → 다르면 FAILED (예외가 아니라 결과로 돌려줘서 FAILED 상태가 저장됨)
--         ④ asset_delete    : DELETED + 원장 기록 → Edge Function이 Storage 객체 삭제
--
--   앱은 이 함수들을 직접 부를 수 없음 (Edge Function이 JWT로 사용자를 확인하고 p_account_id로 넘김)
--   같은 asset_id로 다시 준비하면: 같은 내용이면 이어서(PENDING이면 새 URL, AVAILABLE이면 완료 결과), 다르면 거절
--   잠금 순서는 sync_push와 같게: workspace_sync_heads → assets
--
--   한도 (바꾸려면 private.asset_limits)
--     파일 하나 50MB (버킷 한도와 같음)
--     공유 첨부: 공간마다 합계 500MB (AVAILABLE + 아직 유효한 PENDING)
--     백업: 계정마다 합계 200MB
--     완료 안 된 업로드: 계정마다 20개
-- =====================================================================

create or replace function private.asset_limits()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'max_file_bytes',        52428800,
    'workspace_quota_bytes', 524288000,
    'backup_quota_bytes',    209715200,
    'max_pending',           20,
    'upload_window_minutes', 60);
$$;

-- 첨부로 올릴 수 있는 형식 (attachments 버킷 allowed_mime_types와 같게)
create or replace function private.asset_mime_ok(p_purpose text, p_mime text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'ATTACHMENT' then
      p_mime ~ '^(image|audio)/[a-z0-9][a-z0-9.+-]{0,99}$'
      or p_mime in ('application/pdf', 'text/plain',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    when 'BACKUP' then p_mime = 'application/octet-stream'
    else false
  end;
$$;

-- 공간에서 이 계정이 올리기·지우기를 할 수 있는지 (ACTIVE + OWNER/EDITOR, 삭제 안 된 공간)
create or replace function private.account_can_edit(p_workspace_id uuid, p_account_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
     where m.workspace_id = p_workspace_id and m.account_id = p_account_id
       and m.status = 'ACTIVE' and m.role in ('OWNER', 'EDITOR') and w.deleted_at is null);
$$;

create or replace function private.account_role(p_workspace_id uuid, p_account_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
   where m.workspace_id = p_workspace_id and m.account_id = p_account_id
     and m.status = 'ACTIVE' and w.deleted_at is null;
$$;

-- 앱·다른 기기에 보여 줄 첨부 정보 (sync_snapshot의 assets 항목과 같은 모양)
create or replace function private.asset_json(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(a) from public.assets a where a.id = p_id;
$$;

-- 공유 첨부 변화 1건을 원장에 기록 (호출 전에 sync head를 잠가 둘 것). seq를 돌려줌 → Realtime 신호도 나감
create or replace function private.log_asset_change(p_workspace_id uuid, p_asset_id uuid, p_actor uuid)
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
    (p_workspace_id, v_seq, 'assets', p_asset_id::text, 'UPSERT', null, private.asset_json(p_asset_id), null, p_actor);
  return v_seq;
end $$;

-- ---------------------------------------------------------------------
-- ① 업로드 준비
-- ---------------------------------------------------------------------
create or replace function public.asset_prepare(
  p_account_id    uuid,
  p_asset_id      uuid,
  p_purpose       text,
  p_workspace_id  uuid,
  p_original_name text,
  p_mime_type     text,
  p_size_bytes    bigint,
  p_sha256        text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  L        jsonb := private.asset_limits();
  v_mime   text  := lower(trim(coalesce(p_mime_type, '')));
  v_sha    text  := lower(coalesce(p_sha256, ''));
  v_name   text  := nullif(trim(coalesce(p_original_name, '')), '');
  v_bucket text;
  v_path   text;
  v_row    public.assets%rowtype;
  v_used   bigint;
  v_n      integer;
begin
  if p_account_id is null or p_asset_id is null then
    raise exception 'INVALID_REQUEST: account_id·asset_id가 필요합니다' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose not in ('ATTACHMENT', 'BACKUP') then
    raise exception 'INVALID_REQUEST: purpose는 ATTACHMENT 또는 BACKUP' using errcode = '22023';
  end if;
  if p_purpose = 'ATTACHMENT' and p_workspace_id is null then
    raise exception 'INVALID_REQUEST: 공유 첨부는 workspace_id가 필요합니다' using errcode = '22023';
  end if;
  if p_purpose = 'BACKUP' and p_workspace_id is not null then
    raise exception 'INVALID_REQUEST: 백업에는 workspace_id를 넣지 않습니다' using errcode = '22023';
  end if;
  if not private.asset_mime_ok(p_purpose, v_mime) then
    raise exception 'UNSUPPORTED_TYPE: 올릴 수 없는 파일 형식입니다 (%)', v_mime using errcode = '22023';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 then
    raise exception 'INVALID_REQUEST: 파일 크기가 필요합니다' using errcode = '22023';
  end if;
  if p_size_bytes > (L ->> 'max_file_bytes')::bigint then
    raise exception 'TOO_LARGE: 파일은 50MB까지 올릴 수 있습니다' using errcode = '22023';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST: sha256은 64자리 16진수입니다' using errcode = '22023';
  end if;
  if v_name is not null and char_length(v_name) > 255 then
    raise exception 'INVALID_REQUEST: 파일 이름은 255자까지입니다' using errcode = '22023';
  end if;

  -- 잠금: 공유 첨부는 공간 head(한도 계산과 원장 순서), 백업은 계정 단위
  if p_purpose = 'ATTACHMENT' then
    perform private.lock_workspace_head(p_workspace_id);
    if not private.account_can_edit(p_workspace_id, p_account_id) then
      raise exception 'FORBIDDEN: 이 공간에 파일을 올릴 권한이 없습니다' using errcode = '42501';
    end if;
    v_bucket := 'attachments';
    v_path   := p_workspace_id::text || '/' || p_asset_id::text;
  else
    perform pg_advisory_xact_lock(hashtextextended('asset-backup:' || p_account_id::text, 0));
    v_bucket := 'backups';
    v_path   := p_account_id::text || '/' || p_asset_id::text;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('asset-pending:' || p_account_id::text, 0));

  -- 같은 asset_id로 다시 온 경우
  select * into v_row from public.assets where id = p_asset_id for update;
  if found then
    if v_row.owner_account_id is distinct from p_account_id
       or v_row.purpose <> p_purpose
       or v_row.workspace_id is distinct from p_workspace_id
       or v_row.mime_type <> v_mime
       or v_row.declared_size_bytes <> p_size_bytes
       or v_row.declared_sha256 <> v_sha then
      raise exception 'ASSET_ID_TAKEN: 이미 다른 파일에 쓰인 asset_id입니다. 새 id로 다시 시도하세요' using errcode = '22023';
    end if;
    if v_row.status = 'AVAILABLE' then
      return jsonb_build_object('status', 'AVAILABLE', 'asset', private.asset_json(p_asset_id), 'reused', true);
    elsif v_row.status = 'FAILED' then
      raise exception 'ASSET_FAILED: 확인에 실패한 업로드입니다 (%). 새 id로 다시 올려 주세요', v_row.failure_reason using errcode = '22023';
    elsif v_row.status = 'DELETED' then
      raise exception 'ASSET_DELETED: 삭제된 파일입니다' using errcode = '22023';
    end if;
    -- PENDING: 업로드 기한을 다시 늘리고 이어서 진행
    update public.assets
       set upload_expires_at = now() + make_interval(mins => (L ->> 'upload_window_minutes')::int),
           original_name = coalesce(v_name, original_name)
     where id = p_asset_id;
    return jsonb_build_object('status', 'PENDING', 'asset_id', p_asset_id, 'bucket', v_row.bucket_id,
                              'path', v_row.object_path, 'reused', true);
  end if;

  -- 완료 안 된 업로드 수
  select count(*) into v_n from public.assets
   where owner_account_id = p_account_id and status = 'PENDING' and upload_expires_at > now();
  if v_n >= (L ->> 'max_pending')::int then
    raise exception 'TOO_MANY_PENDING: 완료되지 않은 업로드가 너무 많습니다. 잠시 후 다시 시도하세요' using errcode = '22023';
  end if;

  -- 용량 한도
  if p_purpose = 'ATTACHMENT' then
    select coalesce(sum(declared_size_bytes), 0) into v_used from public.assets
     where workspace_id = p_workspace_id
       and (status = 'AVAILABLE' or (status = 'PENDING' and upload_expires_at > now()));
    if v_used + p_size_bytes > (L ->> 'workspace_quota_bytes')::bigint then
      raise exception 'QUOTA_EXCEEDED: 이 공간의 첨부 용량(500MB)을 넘습니다' using errcode = '22023';
    end if;
  else
    select coalesce(sum(declared_size_bytes), 0) into v_used from public.assets
     where purpose = 'BACKUP' and owner_account_id = p_account_id
       and (status = 'AVAILABLE' or (status = 'PENDING' and upload_expires_at > now()));
    if v_used + p_size_bytes > (L ->> 'backup_quota_bytes')::bigint then
      raise exception 'QUOTA_EXCEEDED: 백업 용량(200MB)을 넘습니다' using errcode = '22023';
    end if;
  end if;

  insert into public.assets
    (id, purpose, workspace_id, owner_account_id, bucket_id, object_path, original_name,
     mime_type, declared_size_bytes, declared_sha256, status, upload_expires_at)
  values
    (p_asset_id, p_purpose, p_workspace_id, p_account_id, v_bucket, v_path, v_name,
     v_mime, p_size_bytes, v_sha, 'PENDING', now() + make_interval(mins => (L ->> 'upload_window_minutes')::int));

  return jsonb_build_object('status', 'PENDING', 'asset_id', p_asset_id, 'bucket', v_bucket,
                            'path', v_path, 'reused', false);
end $$;

-- ---------------------------------------------------------------------
-- ③ 업로드 완료 확인 (Edge Function이 실제 객체에서 잰 값을 넘김)
--    p_actual_* 가 null이면 "객체 없음" → NOT_UPLOADED (PENDING 유지, 다시 업로드 가능)
-- ---------------------------------------------------------------------
create or replace function public.asset_complete(
  p_account_id    uuid,
  p_asset_id      uuid,
  p_actual_size   bigint,
  p_actual_sha256 text,
  p_actual_mime   text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row    public.assets%rowtype;
  v_ws     uuid;
  v_reason text;
  v_seq    bigint;
begin
  if p_account_id is null or p_asset_id is null then
    raise exception 'INVALID_REQUEST: account_id·asset_id가 필요합니다' using errcode = '22023';
  end if;

  -- 공간 head를 먼저 잠그기 위해 공간 id만 먼저 읽음 (잠금 순서: head → assets)
  select workspace_id into v_ws from public.assets where id = p_asset_id and owner_account_id = p_account_id;
  if not found then
    raise exception 'NOT_FOUND: 파일이 없습니다' using errcode = '22023';
  end if;
  if v_ws is not null then
    perform 1 from public.workspace_sync_heads where workspace_id = v_ws for update;
  end if;
  select * into v_row from public.assets where id = p_asset_id for update;

  if v_row.status = 'AVAILABLE' then
    return jsonb_build_object('status', 'AVAILABLE', 'asset', private.asset_json(p_asset_id), 'replayed', true);
  elsif v_row.status in ('FAILED', 'DELETED') then
    return jsonb_build_object('status', v_row.status, 'reason', coalesce(v_row.failure_reason, v_row.status),
                              'bucket', v_row.bucket_id, 'path', v_row.object_path, 'replayed', true);
  end if;

  -- PENDING
  if p_actual_size is null then
    return jsonb_build_object('status', 'PENDING', 'reason', 'NOT_UPLOADED',
                              'bucket', v_row.bucket_id, 'path', v_row.object_path);
  end if;

  if v_row.purpose = 'ATTACHMENT' and not private.account_can_edit(v_row.workspace_id, p_account_id) then
    v_reason := 'FORBIDDEN';          -- 업로드하는 사이 공간에서 빠졌거나 VIEWER가 됨
  elsif p_actual_size <> v_row.declared_size_bytes then
    v_reason := 'SIZE_MISMATCH';
  elsif lower(coalesce(p_actual_sha256, '')) <> v_row.declared_sha256 then
    v_reason := 'HASH_MISMATCH';
  elsif p_actual_mime is not null and split_part(lower(p_actual_mime), ';', 1) <> v_row.mime_type then
    v_reason := 'TYPE_MISMATCH';
  end if;

  if v_reason is not null then
    update public.assets set status = 'FAILED', failure_reason = v_reason, actual_size_bytes = nullif(p_actual_size, 0)
     where id = p_asset_id;
    return jsonb_build_object('status', 'FAILED', 'reason', v_reason,
                              'bucket', v_row.bucket_id, 'path', v_row.object_path);
  end if;

  update public.assets
     set status = 'AVAILABLE', actual_size_bytes = p_actual_size, completed_at = now(), failure_reason = null
   where id = p_asset_id;
  if v_row.purpose = 'ATTACHMENT' then
    v_seq := private.log_asset_change(v_row.workspace_id, p_asset_id, p_account_id);
  end if;
  return jsonb_build_object('status', 'AVAILABLE', 'asset', private.asset_json(p_asset_id), 'seq', v_seq);
end $$;

-- ---------------------------------------------------------------------
-- ④ 삭제: 공유 첨부는 올린 사람(EDITOR 이상) 또는 OWNER, 백업은 본인
--    지운 뒤 Storage 객체는 Edge Function이 삭제. 메모 연결(note_attachments)은 남고 앱은 "삭제된 첨부"로 표시
-- ---------------------------------------------------------------------
create or replace function public.asset_delete(p_account_id uuid, p_asset_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row  public.assets%rowtype;
  v_ws   uuid;
  v_role text;
  v_seq  bigint;
begin
  if p_account_id is null or p_asset_id is null then
    raise exception 'INVALID_REQUEST: account_id·asset_id가 필요합니다' using errcode = '22023';
  end if;
  select workspace_id into v_ws from public.assets where id = p_asset_id;
  if not found then
    raise exception 'NOT_FOUND: 파일이 없습니다' using errcode = '22023';
  end if;
  if v_ws is not null then
    perform 1 from public.workspace_sync_heads where workspace_id = v_ws for update;
  end if;
  select * into v_row from public.assets where id = p_asset_id for update;

  if v_row.purpose = 'BACKUP' then
    if v_row.owner_account_id <> p_account_id then
      raise exception 'NOT_FOUND: 파일이 없습니다' using errcode = '22023';
    end if;
  else
    v_role := private.account_role(v_row.workspace_id, p_account_id);
    if v_role is null then
      raise exception 'NOT_FOUND: 파일이 없습니다' using errcode = '22023';   -- 멤버가 아니면 있는지도 알려주지 않음
    end if;
    if not (v_role = 'OWNER' or (v_role = 'EDITOR' and v_row.owner_account_id = p_account_id)) then
      raise exception 'FORBIDDEN: 올린 사람이나 공간 소유자만 지울 수 있습니다' using errcode = '42501';
    end if;
  end if;

  if v_row.status = 'DELETED' then
    return jsonb_build_object('status', 'DELETED', 'bucket', v_row.bucket_id, 'path', v_row.object_path, 'replayed', true);
  end if;

  update public.assets set status = 'DELETED', deleted_at = now(), deleted_by = p_account_id where id = p_asset_id;
  -- 다른 기기에 보였던 것(AVAILABLE)만 원장에 기록
  if v_row.purpose = 'ATTACHMENT' and v_row.status = 'AVAILABLE' then
    v_seq := private.log_asset_change(v_row.workspace_id, p_asset_id, p_account_id);
  end if;
  return jsonb_build_object('status', 'DELETED', 'bucket', v_row.bucket_id, 'path', v_row.object_path, 'seq', v_seq);
end $$;

-- ---------------------------------------------------------------------
-- 기한이 지난 PENDING → FAILED(EXPIRED)  (pg_cron 30분마다)
--   Storage에 올라간 채 남은 객체 정리는 후속 (Storage API가 필요)
-- ---------------------------------------------------------------------
create or replace function private.expire_pending_assets()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update public.assets set status = 'FAILED', failure_reason = 'EXPIRED'
   where status = 'PENDING' and upload_expires_at < now() - interval '10 minutes';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 권한: service_role만 (Edge Function)
-- ---------------------------------------------------------------------
revoke all on function public.asset_prepare(uuid, uuid, text, uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.asset_complete(uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.asset_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.asset_prepare(uuid, uuid, text, uuid, text, text, bigint, text) to service_role;
grant execute on function public.asset_complete(uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.asset_delete(uuid, uuid) to service_role;

revoke all on function private.asset_limits() from public, anon, authenticated;
revoke all on function private.asset_mime_ok(text, text) from public, anon, authenticated;
revoke all on function private.account_can_edit(uuid, uuid) from public, anon, authenticated;
revoke all on function private.account_role(uuid, uuid) from public, anon, authenticated;
revoke all on function private.asset_json(uuid) from public, anon, authenticated;
revoke all on function private.log_asset_change(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.expire_pending_assets() from public, anon, authenticated;

select cron.schedule('assets-expire-pending', '*/30 * * * *', 'select private.expire_pending_assets()');
