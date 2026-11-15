-- =====================================================================
-- 20. 녹음 임시 보관함 (노션 모바일 방식)
--   앱이 녹음을 비공개 버킷 stt-uploads에 올림(서명 URL) → /transcribe가 꺼내서 변환
--   → 성공하면 바로 삭제, 실패하면 같은 파일로 다시 시도할 수 있게 3일 보관, 올리고 안 쓴 파일도 3일 뒤 삭제
--   삭제는 Storage API로만 가능해서(SQL로 지우면 실제 파일이 남음) 매시간 cron이 Edge Function stt-cleanup을 부름
--   녹음 내용은 이 표에 없음 (경로·크기·상태만)
-- =====================================================================

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------
-- 버킷: 비공개, 25MB(OpenAI 한도), 오디오만. storage.objects 정책 없음
--   → 앱은 서명 업로드 URL로 올리기만 하고, 읽기·삭제는 Edge Function(service_role)만
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stt-uploads', 'stt-uploads', false, 26214400,
        array['audio/*', 'video/mp4', 'video/webm', 'video/mpeg'])
on conflict (id) do update
   set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- 보관함 기록 (앱에서는 안 보임: private 스키마 + RLS, 함수로만 접근)
-- ---------------------------------------------------------------------
create table private.stt_uploads (
  id                   uuid primary key,              -- upload_id (앱이 만듦, 재시도할 때 같은 값)
  account_id           uuid not null references public.accounts (id) on delete cascade,
  object_path          text not null unique,          -- {account_id}/{upload_id}
  ext                  text not null check (ext in ('flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm')),
  mime_type            text not null check (char_length(mime_type) <= 100),
  declared_size_bytes  bigint not null check (declared_size_bytes between 1 and 26214400),
  status               text not null default 'PENDING' check (status in ('PENDING', 'FAILED', 'DONE')),
  attempts             integer not null default 0,
  object_deleted       boolean not null default false,
  expires_at           timestamptz not null default now() + interval '3 days',  -- 이 시각이 지나면 정리 대상
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table private.stt_uploads is '녹음 임시 보관함 기록. 성공하면 파일 즉시 삭제, 실패·미사용은 expires_at(3일) 뒤 stt-cleanup이 삭제';
create index stt_uploads_expire_idx on private.stt_uploads (expires_at) where not object_deleted;
create index stt_uploads_account_idx on private.stt_uploads (account_id) where not object_deleted;
alter table private.stt_uploads enable row level security;
revoke all on private.stt_uploads from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 준비: 동의 확인, 같은 upload_id면 다시 올리기 허용(끝난 건 거절), 보관 중인 파일 10개까지
-- ---------------------------------------------------------------------
create or replace function public.stt_upload_prepare(
  p_account_id uuid, p_upload_id uuid, p_ext text, p_mime text, p_size bigint
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row  private.stt_uploads%rowtype;
  v_path text := p_account_id::text || '/' || p_upload_id::text;
  v_n    integer;
begin
  if p_account_id is null or p_upload_id is null or p_ext is null or p_mime is null or p_size is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_size < 1 or p_size > 26214400 then
    return jsonb_build_object('ok', false, 'code', 'TOO_LARGE');
  end if;
  if p_ext not in ('flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm') then
    return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_TYPE');
  end if;

  if not exists (select 1 from public.consents c
                  where c.account_id = p_account_id and c.consent_type = 'EXTERNAL_AI' and c.revoked_at is null) then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED');
  end if;

  select * into v_row from private.stt_uploads where id = p_upload_id for update;
  if found then
    if v_row.account_id <> p_account_id then
      return jsonb_build_object('ok', false, 'code', 'UPLOAD_ID_TAKEN');
    elsif v_row.status = 'DONE' then
      return jsonb_build_object('ok', false, 'code', 'UPLOAD_GONE');
    end if;
    update private.stt_uploads
       set ext = p_ext, mime_type = left(p_mime, 100), declared_size_bytes = p_size, status = 'PENDING',
           object_deleted = false, expires_at = now() + interval '3 days', updated_at = now()
     where id = p_upload_id;
  else
    select count(*) into v_n from private.stt_uploads
     where account_id = p_account_id and not object_deleted and status <> 'DONE';
    if v_n >= 10 then
      return jsonb_build_object('ok', false, 'code', 'TOO_MANY_PENDING');
    end if;
    insert into private.stt_uploads (id, account_id, object_path, ext, mime_type, declared_size_bytes)
    values (p_upload_id, p_account_id, v_path, p_ext, left(p_mime, 100), p_size);
  end if;

  return jsonb_build_object('ok', true, 'upload_id', p_upload_id, 'bucket', 'stt-uploads', 'path', v_path,
                            'expires_at', now() + interval '3 days');
end $$;

-- 변환할 때: 내 업로드인지, 아직 파일이 있는지
create or replace function public.stt_upload_get(p_account_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_row private.stt_uploads%rowtype;
begin
  select * into v_row from private.stt_uploads where id = p_upload_id and account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  elsif v_row.status = 'DONE' or v_row.object_deleted or v_row.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'UPLOAD_GONE');
  end if;
  return jsonb_build_object('ok', true, 'bucket', 'stt-uploads', 'path', v_row.object_path, 'ext', v_row.ext,
                            'mime_type', v_row.mime_type, 'declared_size_bytes', v_row.declared_size_bytes,
                            'status', v_row.status, 'attempts', v_row.attempts);
end $$;

-- 변환이 끝난 뒤: 성공이면 DONE(파일은 함수가 바로 지움, 못 지웠으면 정리 대상), 실패면 3일 더 보관
create or replace function public.stt_upload_finish(
  p_account_id uuid, p_upload_id uuid, p_success boolean, p_object_deleted boolean default false
)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.stt_uploads
     set status         = case when p_success then 'DONE' else 'FAILED' end,
         attempts       = attempts + 1,
         object_deleted = object_deleted or coalesce(p_object_deleted, false),
         expires_at     = case when p_success then now() else now() + interval '3 days' end,
         updated_at     = now()
   where id = p_upload_id and account_id = p_account_id and status <> 'DONE';
end $$;

-- 정리 대상: 기한이 지났거나 끝났는데 못 지운 파일 + 기록 없이 3일 넘게 남은 파일(계정 삭제 등)
create or replace function public.stt_upload_expired(p_limit integer default 100)
returns table (object_path text)
language sql stable security definer set search_path = '' as $$
  (select u.object_path from private.stt_uploads u
    where not u.object_deleted and u.expires_at <= now()
    order by u.expires_at)
  union
  (select o.name from storage.objects o
    where o.bucket_id = 'stt-uploads' and o.created_at < now() - interval '3 days'
      and not exists (select 1 from private.stt_uploads u where u.object_path = o.name and u.expires_at > now() and not u.object_deleted))
  limit greatest(1, least(coalesce(p_limit, 100), 1000));
$$;

create or replace function public.stt_upload_mark_deleted(p_paths text[])
returns integer
language sql security definer set search_path = '' as $$
  with d as (
    update private.stt_uploads set object_deleted = true, updated_at = now()
     where object_path = any (p_paths) and not object_deleted
    returning 1)
  select count(*)::integer from d;
$$;

-- stt-cleanup 함수가 cron 호출인지 확인 (비밀값은 Vault에만, 사람이 다룰 필요 없음)
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'stt_cleanup_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                'stt_cleanup_secret', 'cron → Edge Function stt-cleanup 호출 확인용');
  end if;
end $$;

create or replace function public.stt_cleanup_check(p_secret text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_secret) = 64 and p_secret = (select decrypted_secret from vault.decrypted_secrets
                                                         where name = 'stt_cleanup_secret' limit 1), false);
$$;

revoke all on function public.stt_upload_prepare(uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.stt_upload_get(uuid, uuid) from public, anon, authenticated;
revoke all on function public.stt_upload_finish(uuid, uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function public.stt_upload_expired(integer) from public, anon, authenticated;
revoke all on function public.stt_upload_mark_deleted(text[]) from public, anon, authenticated;
revoke all on function public.stt_cleanup_check(text) from public, anon, authenticated;
grant execute on function public.stt_upload_prepare(uuid, uuid, text, text, bigint) to service_role;
grant execute on function public.stt_upload_get(uuid, uuid) to service_role;
grant execute on function public.stt_upload_finish(uuid, uuid, boolean, boolean) to service_role;
grant execute on function public.stt_upload_expired(integer) to service_role;
grant execute on function public.stt_upload_mark_deleted(text[]) to service_role;
grant execute on function public.stt_cleanup_check(text) to service_role;

-- ---------------------------------------------------------------------
-- 매시간 정리: cron → pg_net → Edge Function stt-cleanup (Storage API로 실제 파일 삭제)
-- ---------------------------------------------------------------------
select cron.schedule('stt-uploads-cleanup', '23 * * * *', $cmd$
  select net.http_post(
    url := 'https://zcblwwcukkbcwmgugknl.supabase.co/functions/v1/stt-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$cmd$);
