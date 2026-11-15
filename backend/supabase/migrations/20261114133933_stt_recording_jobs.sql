-- =====================================================================
-- 21. 긴 녹음 처리 (최대 3시간): 녹음 종료 → 약 5분 구간으로 분할 업로드 → 서버가 구간별 전사 → 녹음 삭제
--
--   ① 앱  stt_recording_create   녹음 1건과 구간 목록 등록 (동의·공간 권한·길이·크기 확인) → 구간별 업로드 경로
--   ② 앱  Storage에 직접 업로드 (비공개 버킷 stt-recordings, 자기 계정의 "업로드 대기" 구간 경로에만 쓸 수 있음)
--   ③ 앱  stt_segment_confirm    서버가 실제 파일·크기·소유자 확인 → 전사 작업 등록 → 앱은 그 구간 임시 파일 삭제
--                                 (전체 구간 확인이 끝나면 기기 원본 삭제)
--   ④ 서버 stt-worker(Edge Function)가 대기 구간을 동시에 최대 2개씩 gpt-transcribe로 전사
--         → 전사문을 먼저 저장하고 나서 음성 삭제. 일시 오류는 자동 재시도(최대 3회)
--   ⑤ 앱  stt_recording_status / stt_recording_transcript 로 진행률·전사문 받기
--         → 기기(SQLite)나 공유 공간에 저장한 뒤 stt_recording_ack → 서버 임시 전사문 삭제
--
--   보관 규칙 (음성 파일)
--     업로드 대기·처리 대기·처리 중 : 유지
--     전사 성공(전사문 저장 확인)    : 바로 삭제
--     전사 실패                       : 실패 구간만 "최초 실패"부터 3일 보관 (재시도해도 연장 없음)
--     3일 안에 복구 못 함             : 파일 삭제 + 최종 실패(GAVE_UP)
--     사용자 취소                     : 새 처리 중단, 파일·전사문 정리
--     업로드 안 된 구간               : 등록 후 3일 지나면 최종 실패(UPLOAD_EXPIRED)
--     3일 넘게 처리되지 못한 구간     : 최종 실패(NOT_PROCESSED) — 예: 서버에 OpenAI 키가 없을 때
--   임시 전사문: ack 하면 바로, 안 해도 마지막 변화 후 7일 뒤 기록째 삭제
--   한도: 구간마다 분 단위로 예약·차감(FREE 60분 / PRO 600분). 남은 분을 넘는 구간은 QUOTA_EXCEEDED로 실패
-- =====================================================================

-- ---------------------------------------------------------------------
-- 버킷: 비공개, 구간 하나 25MB(OpenAI 한도), 오디오만
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stt-recordings', 'stt-recordings', false, 26214400,
        array['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
              'audio/webm', 'audio/ogg', 'audio/flac'])
on conflict (id) do update
   set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- 녹음(세션)과 구간. 앱에서는 표를 직접 못 보고 함수로만 접근
-- ---------------------------------------------------------------------
create table private.stt_recordings (
  id              uuid primary key,                                  -- 앱이 만듦 (기기 DB에 저장 → 이어 올리기)
  account_id      uuid not null references public.accounts (id) on delete cascade,
  workspace_id    uuid references public.workspaces (id) on delete cascade,   -- null = 개인 녹음
  segment_count   integer not null check (segment_count between 1 and 60),
  total_seconds   numeric(8, 2) not null check (total_seconds > 0 and total_seconds <= 10860),
  languages       text[] not null default '{ko,en}',
  keywords        text[] not null default '{}',
  canceled_at     timestamptz,
  acked_at        timestamptz,                                       -- 앱이 전사문을 저장했다고 알린 시각
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table private.stt_recordings is '긴 녹음 처리 단위. 녹음 내용 없음(구간 경로·상태만). 전사문은 stt_segments에 임시 보관';

create table private.stt_segments (
  id                  uuid primary key default gen_random_uuid(),
  recording_id        uuid not null references private.stt_recordings (id) on delete cascade,
  seq                 integer not null check (seq between 0 and 59),
  account_id          uuid not null,
  object_path         text not null unique,                          -- {account}/{recording}/{seq}.{ext}
  ext                 text not null check (ext in ('m4a', 'mp3', 'wav', 'webm', 'ogg', 'flac')),
  mime_type           text not null,
  declared_size_bytes bigint not null check (declared_size_bytes between 1 and 26214400),
  actual_size_bytes   bigint,
  start_seconds       numeric(8, 2) not null,
  duration_seconds    numeric(8, 2) not null check (duration_seconds > 0 and duration_seconds <= 900),
  status              text not null default 'PENDING_UPLOAD'
                      check (status in ('PENDING_UPLOAD', 'QUEUED', 'PROCESSING', 'DONE', 'FAILED', 'GAVE_UP', 'CANCELED')),
  attempts            integer not null default 0,                    -- OpenAI로 보낸 횟수
  auto_retries        integer not null default 0,                    -- 이번 시도 묶음에서 자동 재시도한 횟수
  error_code          text,
  next_attempt_at     timestamptz not null default now(),
  lease_id            uuid,                                          -- 처리 중인 워커 표시 (늦게 온 결과 거르기)
  locked_at           timestamptz,
  first_failed_at     timestamptz,
  retain_until        timestamptz,                                   -- 최초 실패 + 3일. 재시도해도 안 바뀜
  transcript          text check (char_length(transcript) <= 100000),
  detected_languages  text[],
  transcribed_seconds numeric(8, 2),
  charged_minutes     integer,
  object_deleted      boolean not null default false,
  uploaded_at         timestamptz,
  done_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (recording_id, seq)
);
comment on table private.stt_segments is '녹음 구간. transcript는 앱이 받아 저장할 때까지만 보관(ack 또는 7일)';
create index stt_segments_queue_idx on private.stt_segments (next_attempt_at) where status = 'QUEUED';
create index stt_segments_processing_idx on private.stt_segments (locked_at) where status = 'PROCESSING';
create index stt_segments_files_idx on private.stt_segments (status) where not object_deleted;

alter table private.stt_recordings enable row level security;
alter table private.stt_segments enable row level security;
revoke all on private.stt_recordings, private.stt_segments from public, anon, authenticated;

-- 워커 호출 간격 조절 (짧은 시간에 여러 번 깨우지 않게)
create table private.stt_worker_state (
  id           integer primary key default 1 check (id = 1),
  last_kick_at timestamptz not null default 'epoch'
);
insert into private.stt_worker_state (id) values (1);
alter table private.stt_worker_state enable row level security;
revoke all on private.stt_worker_state from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 공통 도우미
-- ---------------------------------------------------------------------
create or replace function private.stt_audio_ext(p_mime text)
returns text language sql immutable set search_path = '' as $$
  select case lower(split_part(coalesce(p_mime, ''), ';', 1))
           when 'audio/mp4' then 'm4a' when 'audio/m4a' then 'm4a' when 'audio/x-m4a' then 'm4a'
           when 'audio/mpeg' then 'mp3' when 'audio/mp3' then 'mp3'
           when 'audio/wav' then 'wav' when 'audio/x-wav' then 'wav'
           when 'audio/webm' then 'webm' when 'audio/ogg' then 'ogg' when 'audio/flac' then 'flac'
         end;
$$;

-- Edge Function 호출 (Vault 비밀값을 붙여서). pg_net은 트랜잭션이 끝난 뒤 보냄
create or replace function private.stt_call_function(p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://zcblwwcukkbcwmgugknl.supabase.co/functions/v1/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
end $$;

-- 워커 깨우기 (5초 안에 이미 깨웠으면 생략. 놓쳐도 매분 cron이 깨움)
create or replace function private.stt_worker_kick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  update private.stt_worker_state set last_kick_at = now()
   where id = 1 and last_kick_at < now() - interval '5 seconds'
  returning true into v_ok;
  if v_ok then perform private.stt_call_function('stt-worker'); end if;
end $$;

-- 매분: 처리할 구간이 있을 때만 워커 깨우기
create or replace function private.stt_worker_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.stt_segments s
              where (s.status = 'QUEUED' and s.next_attempt_at <= now())
                 or (s.status = 'PROCESSING' and s.locked_at < now() - interval '4 minutes')) then
    perform private.stt_worker_kick();
  end if;
end $$;

-- 이번 달 남은 변환 분
create or replace function private.stt_minutes_left(p_account_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with p as (
    select coalesce((select s.plan from public.subscriptions s
                      where s.account_id = p_account_id and s.status = 'ACTIVE'), 'FREE') as plan),
  l as (select plan, private.ai_monthly_limit(plan, 'stt') as lim from p)
  select jsonb_build_object('plan', l.plan, 'limit_minutes', l.lim,
           'remaining_minutes', greatest(l.lim - coalesce((
             select sum(u.used + u.reserved) from public.usage_counters u
              where u.account_id = p_account_id and u.metric = 'AI_STT'
                and u.period_start = date_trunc('month', now() at time zone 'Asia/Seoul')::date), 0), 0))
    from l;
$$;

-- 업로드 허용 여부 (Storage 정책에서 사용): 내 계정의 "업로드 대기" 구간 경로만
create or replace function private.stt_segment_upload_allowed(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.stt_segments s join private.stt_recordings r on r.id = s.recording_id
     where s.object_path = p_name and s.account_id = (select auth.uid())
       and s.status = 'PENDING_UPLOAD' and r.canceled_at is null);
$$;
revoke all on function private.stt_segment_upload_allowed(text) from public, anon;
grant execute on function private.stt_segment_upload_allowed(text) to authenticated;

-- upsert(끊긴 업로드를 같은 경로에 다시 올리기)에는 insert·select·update가 모두 필요. delete는 없음
create policy stt_recordings_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'stt-recordings' and private.stt_segment_upload_allowed(name));
create policy stt_recordings_select on storage.objects for select to authenticated
  using (bucket_id = 'stt-recordings' and private.stt_segment_upload_allowed(name));
create policy stt_recordings_update on storage.objects for update to authenticated
  using (bucket_id = 'stt-recordings' and private.stt_segment_upload_allowed(name))
  with check (bucket_id = 'stt-recordings' and private.stt_segment_upload_allowed(name));

-- 녹음 진행 상태 (앱 표시용, 전사문 없음)
create or replace function private.stt_recording_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with r as (select * from private.stt_recordings where id = p_id),
  c as (
    select count(*) filter (where status = 'PENDING_UPLOAD') as pending_upload,
           count(*) filter (where status = 'QUEUED')         as queued,
           count(*) filter (where status = 'PROCESSING')     as processing,
           count(*) filter (where status = 'DONE')           as done,
           count(*) filter (where status = 'FAILED')         as failed,
           count(*) filter (where status = 'GAVE_UP')        as gave_up,
           count(*) filter (where status = 'CANCELED')       as canceled,
           coalesce(sum(charged_minutes), 0)                 as charged_minutes,
           min(retain_until) filter (where status = 'FAILED') as retry_until
      from private.stt_segments where recording_id = p_id)
  select jsonb_build_object(
    'ok', true,
    'recording_id', r.id,
    'workspace_id', r.workspace_id,
    'state', case when r.canceled_at is not null then 'CANCELED'
                  when c.pending_upload > 0 then 'UPLOADING'
                  when c.queued + c.processing > 0 then 'PROCESSING'
                  when c.failed > 0 then 'NEEDS_RETRY'
                  when c.done = r.segment_count then 'DONE'
                  when c.done > 0 then 'DONE_WITH_GAPS'
                  else 'FAILED' end,
    'total', r.segment_count,
    'total_seconds', r.total_seconds,
    'counts', jsonb_build_object('pending_upload', c.pending_upload, 'queued', c.queued, 'processing', c.processing,
                                 'done', c.done, 'failed', c.failed, 'gave_up', c.gave_up, 'canceled', c.canceled),
    'charged_minutes', c.charged_minutes,
    'retry_until', c.retry_until,
    'acked_at', r.acked_at,
    'segments', (select coalesce(jsonb_agg(jsonb_build_object(
                   'seq', s.seq, 'status', s.status, 'error_code', s.error_code, 'path', s.object_path,
                   'mime_type', s.mime_type, 'size_bytes', s.declared_size_bytes,
                   'start_seconds', s.start_seconds, 'duration_seconds', s.duration_seconds,
                   'retain_until', s.retain_until, 'has_transcript', s.transcript is not null) order by s.seq), '[]'::jsonb)
                   from private.stt_segments s where s.recording_id = p_id))
  from r, c;
$$;

-- ---------------------------------------------------------------------
-- ① 녹음 등록 (앱이 직접 호출, 로그인 사용자)
--   p_segments: [{ seq, duration_seconds, size_bytes, mime_type }]  seq는 0부터 빈틈없이
-- ---------------------------------------------------------------------
create or replace function public.stt_recording_create(
  p_recording_id uuid, p_segments jsonb, p_workspace_id uuid default null,
  p_languages text[] default null, p_keywords text[] default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_rec   private.stt_recordings%rowtype;
  v_n     integer;
  v_total numeric := 0;
  v_need  integer := 0;
  v_seg   jsonb;
  v_ext   text;
  v_langs text[];
  v_kw    text[];
  v_left  jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_recording_id is null or p_segments is null or jsonb_typeof(p_segments) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  end if;

  -- 같은 id로 다시 부르면(앱 재시작 등) 기존 녹음을 그대로 돌려줌
  select * into v_rec from private.stt_recordings where id = p_recording_id;
  if found then
    if v_rec.account_id <> v_uid then return jsonb_build_object('ok', false, 'code', 'RECORDING_ID_TAKEN'); end if;
    if v_rec.segment_count <> jsonb_array_length(p_segments) then
      return jsonb_build_object('ok', false, 'code', 'RECORDING_EXISTS');
    end if;
    return private.stt_recording_json(p_recording_id) || jsonb_build_object('bucket', 'stt-recordings', 'existing', true)
           || private.stt_minutes_left(v_uid);
  end if;

  if not exists (select 1 from public.consents c
                  where c.account_id = v_uid and c.consent_type = 'EXTERNAL_AI' and c.revoked_at is null) then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED');
  end if;
  if p_workspace_id is not null and not private.account_can_edit(p_workspace_id, v_uid) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;

  -- 구간 확인: 1~60개, seq 0..n-1, 구간 길이 1초~15분, 크기 25MB, 형식, 전체 3시간(+1분 여유)
  v_n := jsonb_array_length(p_segments);
  if v_n < 1 or v_n > 60 then return jsonb_build_object('ok', false, 'code', 'TOO_MANY_SEGMENTS'); end if;
  for v_seg in select e from jsonb_array_elements(p_segments) e loop
    if jsonb_typeof(v_seg->'duration_seconds') is distinct from 'number' or jsonb_typeof(v_seg->'size_bytes') is distinct from 'number'
       or jsonb_typeof(v_seg->'seq') is distinct from 'number'
       or (v_seg->>'duration_seconds')::numeric <= 0 or (v_seg->>'duration_seconds')::numeric > 900 then
      return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'detail', 'duration_seconds');
    end if;
    if (v_seg->>'size_bytes')::numeric < 1 or (v_seg->>'size_bytes')::numeric > 26214400 then
      return jsonb_build_object('ok', false, 'code', 'TOO_LARGE', 'seq', (v_seg->>'seq')::int);
    end if;
    if private.stt_audio_ext(v_seg->>'mime_type') is null then
      return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_TYPE', 'seq', (v_seg->>'seq')::int);
    end if;
    v_total := v_total + (v_seg->>'duration_seconds')::numeric;
    v_need := v_need + ceil((v_seg->>'duration_seconds')::numeric / 60)::int;
  end loop;
  if (select array_agg((e->>'seq')::numeric order by (e->>'seq')::numeric) from jsonb_array_elements(p_segments) e)
     is distinct from (select array_agg(g::numeric) from generate_series(0, v_n - 1) g) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'detail', 'seq');
  end if;
  if v_total > 10860 then return jsonb_build_object('ok', false, 'code', 'RECORDING_TOO_LONG', 'max_seconds', 10800); end if;

  v_langs := coalesce((select array_agg(distinct lower(trim(l))) from unnest(p_languages) l
                        where trim(l) ~ '^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$'), '{ko,en}');
  v_kw := coalesce((select array_agg(distinct trim(k)) from unnest(p_keywords) k
                     where trim(k) <> '' and char_length(trim(k)) <= 60 and trim(k) !~ '[<>\r\n]'), '{}');
  if cardinality(v_langs) > 5 or cardinality(v_kw) > 50 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'detail', 'languages/keywords');
  end if;

  -- 아직 끝나지 않은 녹음은 계정당 3개까지
  if (select count(*) from private.stt_recordings r
       where r.account_id = v_uid and r.canceled_at is null
         and exists (select 1 from private.stt_segments s where s.recording_id = r.id
                      and s.status in ('PENDING_UPLOAD', 'QUEUED', 'PROCESSING'))) >= 3 then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_ACTIVE');
  end if;

  insert into private.stt_recordings (id, account_id, workspace_id, segment_count, total_seconds, languages, keywords)
  values (p_recording_id, v_uid, p_workspace_id, v_n, v_total, v_langs, v_kw);

  insert into private.stt_segments (recording_id, seq, account_id, object_path, ext, mime_type, declared_size_bytes,
                                    start_seconds, duration_seconds)
  select p_recording_id, (e->>'seq')::int, v_uid,
         v_uid::text || '/' || p_recording_id::text || '/' || lpad(e->>'seq', 3, '0') || '.' || private.stt_audio_ext(e->>'mime_type'),
         private.stt_audio_ext(e->>'mime_type'), lower(split_part(e->>'mime_type', ';', 1)), (e->>'size_bytes')::bigint,
         coalesce(sum((e->>'duration_seconds')::numeric) over (order by (e->>'seq')::int
                    rows between unbounded preceding and 1 preceding), 0),
         (e->>'duration_seconds')::numeric
    from jsonb_array_elements(p_segments) e;

  v_left := private.stt_minutes_left(v_uid);
  return private.stt_recording_json(p_recording_id)
         || jsonb_build_object('bucket', 'stt-recordings', 'existing', false, 'minutes_needed', v_need)
         || v_left;
end $$;

-- ---------------------------------------------------------------------
-- ③ 업로드 확인 → 전사 작업 등록 (앱이 구간마다 호출. 확인되면 그 구간 임시 파일을 지워도 됨)
-- ---------------------------------------------------------------------
create or replace function public.stt_segment_confirm(p_recording_id uuid, p_seq integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_seg  private.stt_segments%rowtype;
  v_rec  private.stt_recordings%rowtype;
  v_size bigint;
  v_left integer;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into v_rec from private.stt_recordings where id = p_recording_id and account_id = v_uid;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_rec.canceled_at is not null then return jsonb_build_object('ok', false, 'code', 'CANCELED'); end if;

  select * into v_seg from private.stt_segments where recording_id = p_recording_id and seq = p_seq for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  if v_seg.status = 'PENDING_UPLOAD' then
    -- 실제 파일: 경로(= 내 계정·이 녹음·이 구간)와 Storage가 기록한 크기
    select (o.metadata->>'size')::bigint into v_size
      from storage.objects o where o.bucket_id = 'stt-recordings' and o.name = v_seg.object_path;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'NOT_UPLOADED', 'seq', p_seq);
    end if;
    if v_size is null or v_size <> v_seg.declared_size_bytes then
      return jsonb_build_object('ok', false, 'code', 'SIZE_MISMATCH', 'seq', p_seq,
                                'expected', v_seg.declared_size_bytes, 'actual', v_size);
    end if;
    update private.stt_segments
       set status = 'QUEUED', actual_size_bytes = v_size, uploaded_at = now(), next_attempt_at = now(), updated_at = now()
     where id = v_seg.id;
    perform private.stt_worker_kick();
  end if;

  select count(*) into v_left from private.stt_segments
   where recording_id = p_recording_id and status = 'PENDING_UPLOAD';
  return jsonb_build_object('ok', true, 'seq', p_seq,
    'status', case when v_seg.status = 'PENDING_UPLOAD' then 'QUEUED' else v_seg.status end,
    'already', v_seg.status <> 'PENDING_UPLOAD', 'uploads_left', v_left, 'all_uploaded', v_left = 0);
end $$;

-- ⑤ 진행 상태 (전사문 제외)
create or replace function public.stt_recording_status(p_recording_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from private.stt_recordings where id = p_recording_id and account_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  return private.stt_recording_json(p_recording_id);
end $$;

-- ⑤ 전사문 (구간 순서대로, 실패 구간은 text 없음)
create or replace function public.stt_recording_transcript(p_recording_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from private.stt_recordings where id = p_recording_id and account_id = auth.uid()) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  return private.stt_recording_json(p_recording_id) - 'segments' || jsonb_build_object(
    'segments', (select coalesce(jsonb_agg(jsonb_build_object(
        'seq', s.seq, 'status', s.status, 'error_code', s.error_code,
        'start_seconds', s.start_seconds, 'duration_seconds', s.duration_seconds,
        'text', s.transcript, 'languages', coalesce(s.detected_languages, '{}')) order by s.seq), '[]'::jsonb)
      from private.stt_segments s where s.recording_id = p_recording_id));
end $$;

-- ⑤ 앱이 전사문을 저장함 → 서버 임시 전사문 삭제 (그 뒤에 전사된 구간은 다음 ack 때)
create or replace function public.stt_recording_ack(p_recording_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  update private.stt_recordings set acked_at = now(), updated_at = now()
   where id = p_recording_id and account_id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  update private.stt_segments set transcript = null, updated_at = now()
   where recording_id = p_recording_id and transcript is not null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'cleared', v_n);
end $$;

-- 사용자 취소: 새 처리 중단, 남은 파일·전사문 정리(곧바로 정리 함수 호출)
create or replace function public.stt_recording_cancel(p_recording_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  update private.stt_recordings set canceled_at = coalesce(canceled_at, now()), updated_at = now()
   where id = p_recording_id and account_id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  update private.stt_segments
     set status = case when status in ('DONE', 'GAVE_UP') then status else 'CANCELED' end,
         lease_id = null, transcript = null, updated_at = now()
   where recording_id = p_recording_id;
  get diagnostics v_n = row_count;
  perform private.stt_call_function('stt-cleanup');
  return jsonb_build_object('ok', true, 'segments', v_n);
end $$;

-- 실패 구간 다시 시도 (보관 기한 안에서만, 기한은 연장 안 함)
create or replace function public.stt_recording_retry(p_recording_id uuid, p_seqs integer[] default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if not exists (select 1 from private.stt_recordings
                  where id = p_recording_id and account_id = auth.uid() and canceled_at is null) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  update private.stt_segments
     set status = 'QUEUED', auto_retries = 0, error_code = null, next_attempt_at = now(), updated_at = now()
   where recording_id = p_recording_id and status = 'FAILED' and not object_deleted
     and retain_until > now() and (p_seqs is null or seq = any (p_seqs));
  get diagnostics v_n = row_count;
  if v_n > 0 then perform private.stt_worker_kick(); end if;
  return jsonb_build_object('ok', true, 'requeued', v_n);
end $$;

-- ---------------------------------------------------------------------
-- ④ 워커 전용 (service_role)
-- ---------------------------------------------------------------------
-- 처리할 구간 가져오기: 전체 동시 처리 p_max_processing개까지, 4분 넘게 응답 없는 처리는 실패 1회로 보고 다시 대기
create or replace function public.stt_segment_claim(p_limit integer default 2, p_max_processing integer default 2)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_slots integer;
  v_out   jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('stt_segment_claim'));

  update private.stt_segments
     set status = case when auto_retries + 1 <= 2 and coalesce(retain_until, now() + interval '3 days') > now() + interval '10 minutes'
                       then 'QUEUED' else 'FAILED' end,
         error_code = 'WORKER_LOST', lease_id = null, locked_at = null,
         auto_retries = auto_retries + 1,
         first_failed_at = coalesce(first_failed_at, now()),
         retain_until = coalesce(retain_until, now() + interval '3 days'),
         next_attempt_at = now() + interval '30 seconds', updated_at = now()
   where status = 'PROCESSING' and locked_at < now() - interval '4 minutes';

  select greatest(0, least(coalesce(p_limit, 2), coalesce(p_max_processing, 2)
                           - (select count(*) from private.stt_segments where status = 'PROCESSING')))
    into v_slots;
  if v_slots = 0 then return '[]'::jsonb; end if;

  with picked as (
    select s.id from private.stt_segments s join private.stt_recordings r on r.id = s.recording_id
     where s.status = 'QUEUED' and s.next_attempt_at <= now() and r.canceled_at is null
     order by r.created_at, s.seq
     limit v_slots
     for update of s skip locked),
  upd as (
    update private.stt_segments s
       set status = 'PROCESSING', lease_id = gen_random_uuid(), locked_at = now(),
           attempts = attempts + 1, updated_at = now()
      from picked where s.id = picked.id
    returning s.*)
  select coalesce(jsonb_agg(jsonb_build_object(
           'segment_id', u.id, 'lease_id', u.lease_id, 'recording_id', u.recording_id, 'seq', u.seq,
           'account_id', u.account_id, 'workspace_id', r.workspace_id,
           'bucket', 'stt-recordings', 'path', u.object_path, 'ext', u.ext, 'mime_type', u.mime_type,
           'duration_seconds', u.duration_seconds, 'languages', r.languages, 'keywords', r.keywords,
           -- 앞 구간 끝부분 (이미 전사됐으면): 말이 이어지게
           'prompt', (select right(p.transcript, 300) from private.stt_segments p
                       where p.recording_id = u.recording_id and p.seq = u.seq - 1 and p.transcript is not null))
           order by u.seq), '[]'::jsonb)
    into v_out
    from upd u join private.stt_recordings r on r.id = u.recording_id;
  return v_out;
end $$;

-- 전사 성공: 전사문 저장 (이 처리의 lease가 맞을 때만). 저장 확인 뒤에 워커가 음성을 지움
create or replace function public.stt_segment_succeed(
  p_segment_id uuid, p_lease_id uuid, p_text text, p_languages text[], p_seconds numeric, p_charged_minutes integer
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  update private.stt_segments
     set status = 'DONE', transcript = left(coalesce(p_text, ''), 100000), detected_languages = p_languages,
         transcribed_seconds = p_seconds, charged_minutes = p_charged_minutes, error_code = null,
         lease_id = null, locked_at = null, done_at = now(), updated_at = now()
   where id = p_segment_id and lease_id = p_lease_id and status = 'PROCESSING';
  if found then
    update private.stt_recordings set updated_at = now()
     where id = (select recording_id from private.stt_segments where id = p_segment_id);
    return jsonb_build_object('ok', true);
  end if;
  select status into v_status from private.stt_segments where id = p_segment_id;
  return jsonb_build_object('ok', false, 'code', case when v_status = 'CANCELED' then 'CANCELED' else 'LEASE_LOST' end);
end $$;

-- 전사 실패: 일시 오류면 자동 재시도(최대 2번 더, 30초·60초 뒤), 아니면 FAILED. 보관 기한은 최초 실패 기준
create or replace function public.stt_segment_fail(
  p_segment_id uuid, p_lease_id uuid, p_code text, p_retryable boolean
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row private.stt_segments%rowtype;
begin
  update private.stt_segments
     set auto_retries = auto_retries + 1,
         first_failed_at = coalesce(first_failed_at, now()),
         retain_until = coalesce(retain_until, now() + interval '3 days'),
         error_code = left(p_code, 60), lease_id = null, locked_at = null, updated_at = now()
   where id = p_segment_id and lease_id = p_lease_id and status = 'PROCESSING'
  returning * into v_row;
  if not found then return jsonb_build_object('ok', false, 'code', 'LEASE_LOST'); end if;

  if coalesce(p_retryable, false) and v_row.auto_retries <= 2 and v_row.retain_until > now() + interval '10 minutes' then
    update private.stt_segments
       set status = 'QUEUED', next_attempt_at = now() + (interval '30 seconds' * power(2, v_row.auto_retries - 1))
     where id = p_segment_id;
    return jsonb_build_object('ok', true, 'status', 'QUEUED');
  end if;
  update private.stt_segments set status = 'FAILED' where id = p_segment_id;
  update private.stt_recordings set updated_at = now() where id = v_row.recording_id;
  return jsonb_build_object('ok', true, 'status', 'FAILED');
end $$;

-- ---------------------------------------------------------------------
-- 정리 (stt-cleanup 함수가 Storage API로 실제 파일 삭제 → 표시)
-- ---------------------------------------------------------------------
create or replace function public.stt_recording_expired(p_limit integer default 100)
returns table (object_path text)
language sql stable security definer set search_path = '' as $$
  (select s.object_path from private.stt_segments s
    where not s.object_deleted
      and (s.status in ('DONE', 'CANCELED', 'GAVE_UP')
           or (s.status = 'FAILED' and s.retain_until <= now())
           or (s.status = 'PENDING_UPLOAD' and s.created_at <= now() - interval '3 days')
           or (s.status = 'QUEUED' and s.uploaded_at <= now() - interval '3 days'))
    order by s.updated_at)
  union
  (select o.name from storage.objects o
    where o.bucket_id = 'stt-recordings' and o.created_at < now() - interval '3 days'
      and not exists (select 1 from private.stt_segments s where s.object_path = o.name and not s.object_deleted))
  limit greatest(1, least(coalesce(p_limit, 100), 1000));
$$;

create or replace function public.stt_recording_mark_deleted(p_paths text[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update private.stt_segments
     set object_deleted = true,
         status = case when status = 'FAILED' and retain_until <= now() then 'GAVE_UP'
                       when status = 'PENDING_UPLOAD' and created_at <= now() - interval '3 days' then 'GAVE_UP'
                       when status = 'QUEUED' and uploaded_at <= now() - interval '3 days' then 'GAVE_UP'
                       else status end,
         error_code = case when status = 'PENDING_UPLOAD' and created_at <= now() - interval '3 days' then 'UPLOAD_EXPIRED'
                           when status = 'QUEUED' and uploaded_at <= now() - interval '3 days' then 'NOT_PROCESSED'
                           else error_code end,
         updated_at = now()
   where object_path = any (p_paths) and not object_deleted
     and status in ('DONE', 'CANCELED', 'GAVE_UP', 'FAILED', 'PENDING_UPLOAD', 'QUEUED')
     and not (status = 'FAILED' and retain_until > now())
     and not (status = 'PENDING_UPLOAD' and created_at > now() - interval '3 days')
     and not (status = 'QUEUED' and uploaded_at > now() - interval '3 days');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 기록 정리: 파일이 모두 지워졌고 (ack·취소했거나 7일 동안 변화 없음) → 녹음 기록째 삭제
--          ack 안 한 전사문도 마지막 변화 후 7일 지나면 삭제
create or replace function public.stt_recording_purge()
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update private.stt_segments set transcript = null
   where transcript is not null and updated_at < now() - interval '7 days';
  delete from private.stt_recordings r
   where not exists (select 1 from private.stt_segments s where s.recording_id = r.id and not s.object_deleted)
     and (r.acked_at is not null or r.canceled_at is not null
          or greatest(r.updated_at, (select max(s.updated_at) from private.stt_segments s where s.recording_id = r.id))
             < now() - interval '7 days');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 권한: 앱(로그인 사용자) 5개 + 등록·확인, 나머지는 service_role만
-- ---------------------------------------------------------------------
revoke all on function public.stt_recording_create(uuid, jsonb, uuid, text[], text[]) from public, anon;
revoke all on function public.stt_segment_confirm(uuid, integer) from public, anon;
revoke all on function public.stt_recording_status(uuid) from public, anon;
revoke all on function public.stt_recording_transcript(uuid) from public, anon;
revoke all on function public.stt_recording_ack(uuid) from public, anon;
revoke all on function public.stt_recording_cancel(uuid) from public, anon;
revoke all on function public.stt_recording_retry(uuid, integer[]) from public, anon;
grant execute on function public.stt_recording_create(uuid, jsonb, uuid, text[], text[]) to authenticated;
grant execute on function public.stt_segment_confirm(uuid, integer) to authenticated;
grant execute on function public.stt_recording_status(uuid) to authenticated;
grant execute on function public.stt_recording_transcript(uuid) to authenticated;
grant execute on function public.stt_recording_ack(uuid) to authenticated;
grant execute on function public.stt_recording_cancel(uuid) to authenticated;
grant execute on function public.stt_recording_retry(uuid, integer[]) to authenticated;

revoke all on function public.stt_segment_claim(integer, integer) from public, anon, authenticated;
revoke all on function public.stt_segment_succeed(uuid, uuid, text, text[], numeric, integer) from public, anon, authenticated;
revoke all on function public.stt_segment_fail(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.stt_recording_expired(integer) from public, anon, authenticated;
revoke all on function public.stt_recording_mark_deleted(text[]) from public, anon, authenticated;
revoke all on function public.stt_recording_purge() from public, anon, authenticated;
grant execute on function public.stt_segment_claim(integer, integer) to service_role;
grant execute on function public.stt_segment_succeed(uuid, uuid, text, text[], numeric, integer) to service_role;
grant execute on function public.stt_segment_fail(uuid, uuid, text, boolean) to service_role;
grant execute on function public.stt_recording_expired(integer) to service_role;
grant execute on function public.stt_recording_mark_deleted(text[]) to service_role;
grant execute on function public.stt_recording_purge() to service_role;

revoke all on function private.stt_call_function(text) from public, anon, authenticated;
revoke all on function private.stt_worker_kick() from public, anon, authenticated;
revoke all on function private.stt_worker_tick() from public, anon, authenticated;
revoke all on function private.stt_minutes_left(uuid) from public, anon, authenticated;
revoke all on function private.stt_recording_json(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 일정: 매분 대기 구간이 있으면 워커 깨우기 / 매시간 기록 정리 (파일 정리는 기존 stt-uploads-cleanup이 함께)
-- ---------------------------------------------------------------------
select cron.schedule('stt-worker-tick', '* * * * *', $cmd$ select private.stt_worker_tick() $cmd$);
select cron.schedule('stt-recordings-purge', '41 * * * *', $cmd$ select public.stt_recording_purge() $cmd$);
