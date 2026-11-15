-- 녹음 임시 보관함 테스트 (로컬 전용): 준비·조회·성공/실패 처리·정리 대상·cron
--   실행: ./reset.sh ../migrations/*.sql && psql ... -f test_stt_uploads.sql
\set QUIET on
\pset format unaligned
\pset tuples_only on

drop schema if exists t cascade;
create schema t;
create table t.results (n serial, name text, pass boolean, detail text);
grant usage on schema t to authenticated, anon, service_role;
grant insert, select on t.results to authenticated, anon, service_role;
grant usage on sequence t.results_n_seq to authenticated, anon, service_role;
create function t.ok(p_cond boolean, p_name text, p_detail text default null) returns void
language sql as $$ insert into t.results (name, pass, detail) values (p_name, coalesce(p_cond, false), p_detail) $$;
create function t.err(p_sql text, p_code text, p_name text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t.results (name, pass, detail) values (p_name, false, 'no error');
  exception when others then
    insert into t.results (name, pass, detail) values (p_name, sqlerrm like p_code || '%', sqlerrm);
  end;
end $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set u1 '00000000-0000-4000-8000-0000000000c1'
\set u2 '00000000-0000-4000-8000-0000000000c2'
\set u3 '00000000-0000-4000-8000-0000000000c3'
insert into auth.users (id, email) values (:'u1', 'c1@t.dev'), (:'u2', 'c2@t.dev'), (:'u3', 'c3@t.dev');
insert into public.consents (account_id, consent_type, policy_version) values (:'u1', 'EXTERNAL_AI', 'v1'), (:'u2', 'EXTERNAL_AI', 'v1');

\set as_user 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_svc  'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'
\set up1 '10000000-0000-4000-8000-0000000000e1'
\set up2 '10000000-0000-4000-8000-0000000000e2'

-- 1. 준비
:as_svc
select public.stt_upload_prepare(:'u1', :'up1', 'm4a', 'audio/mp4', 2000000) as p1 \gset
select t.ok((:'p1'::jsonb ->> 'ok')::boolean and :'p1'::jsonb ->> 'bucket' = 'stt-uploads'
        and :'p1'::jsonb ->> 'path' = :'u1' || '/' || :'up1', '1.1 준비 → 비공개 버킷 경로 {계정}/{업로드 id}', :'p1');
select t.ok(public.stt_upload_prepare(:'u3', gen_random_uuid(), 'm4a', 'audio/mp4', 10) ->> 'code' = 'CONSENT_REQUIRED', '1.2 외부 AI 동의 없으면 올리기 전에 거절');
select t.ok(public.stt_upload_prepare(:'u1', gen_random_uuid(), 'aac', 'audio/aac', 10) ->> 'code' = 'UNSUPPORTED_TYPE', '1.3 형식 확인');
select t.ok(public.stt_upload_prepare(:'u1', gen_random_uuid(), 'm4a', 'audio/mp4', 26214401) ->> 'code' = 'TOO_LARGE', '1.4 25MB 넘으면 거절');
select t.ok(public.stt_upload_prepare(:'u2', :'up1', 'm4a', 'audio/mp4', 10) ->> 'code' = 'UPLOAD_ID_TAKEN', '1.5 남의 업로드 id는 못 씀');
select t.ok((public.stt_upload_prepare(:'u1', :'up1', 'wav', 'audio/wav', 3000) ->> 'ok')::boolean, '1.6 같은 id로 다시 준비(다시 올리기) 가능');
:as_admin
select t.ok((select ext = 'wav' and declared_size_bytes = 3000 and status = 'PENDING' and expires_at > now() + interval '71 hours'
             from private.stt_uploads where id = :'up1'), '1.7 다시 준비하면 형식·크기 갱신, 3일 보관');
:as_svc
do $$ begin
  for i in 1..9 loop perform public.stt_upload_prepare('00000000-0000-4000-8000-0000000000c2', gen_random_uuid(), 'm4a', 'audio/mp4', 10); end loop;
end $$;
select t.ok(public.stt_upload_prepare(:'u2', gen_random_uuid(), 'm4a', 'audio/mp4', 10) ->> 'ok' = 'true', '1.8 10번째까지는 됨');
select t.ok(public.stt_upload_prepare(:'u2', gen_random_uuid(), 'm4a', 'audio/mp4', 10) ->> 'code' = 'TOO_MANY_PENDING', '1.9 보관 중 10개 넘으면 거절');

-- 2. 조회·결과 처리
select public.stt_upload_get(:'u1', :'up1') as g1 \gset
select t.ok((:'g1'::jsonb ->> 'ok')::boolean and :'g1'::jsonb ->> 'ext' = 'wav' and :'g1'::jsonb ->> 'status' = 'PENDING', '2.1 조회: 경로·형식', :'g1');
select t.ok(public.stt_upload_get(:'u2', :'up1') ->> 'code' = 'NOT_FOUND', '2.2 남의 업로드는 NOT_FOUND');
:as_admin
update private.stt_uploads set expires_at = now() + interval '1 hour' where id = :'up1';   -- 기한이 거의 다 된 상태에서 실패
:as_svc
select public.stt_upload_finish(:'u1', :'up1', false) \gset
select public.stt_upload_get(:'u1', :'up1') as g2 \gset
select t.ok(:'g2'::jsonb ->> 'status' = 'FAILED' and (:'g2'::jsonb ->> 'attempts')::int = 1, '2.3 실패 → FAILED, 파일은 남아서 다시 시도 가능', :'g2');
:as_admin
select t.ok((select expires_at > now() + interval '71 hours' from private.stt_uploads where id = :'up1'), '2.4 실패하면 그때부터 3일 보관');
:as_svc
select public.stt_upload_finish(:'u1', :'up1', true, true) \gset
select t.ok(public.stt_upload_get(:'u1', :'up1') ->> 'code' = 'UPLOAD_GONE', '2.5 성공 → 파일 지움, 다시 쓰려면 새로 올려야 함');
select t.ok(public.stt_upload_prepare(:'u1', :'up1', 'm4a', 'audio/mp4', 10) ->> 'code' = 'UPLOAD_GONE', '2.6 끝난 업로드 id로 다시 준비 불가');
select public.stt_upload_finish(:'u1', :'up1', false) \gset
:as_admin
select t.ok((select status = 'DONE' and attempts = 2 from private.stt_uploads where id = :'up1'), '2.7 끝난 뒤 실패 처리가 와도 DONE 유지');

-- 3. 정리 대상
:as_svc
select public.stt_upload_prepare(:'u1', :'up2', 'm4a', 'audio/mp4', 10) \gset
select public.stt_upload_finish(:'u1', :'up2', true, false) \gset
select t.ok(exists (select 1 from public.stt_upload_expired(100) e where e.object_path = :'u1' || '/' || :'up2'), '3.1 성공했는데 못 지운 파일 → 바로 정리 대상');
:as_admin
insert into storage.objects (bucket_id, name) values ('stt-uploads', :'u1' || '/' || :'up2');
update private.stt_uploads set expires_at = now() - interval '1 minute'
 where account_id = :'u2' and id in (select id from private.stt_uploads where account_id = :'u2' order by created_at limit 3);
insert into storage.objects (bucket_id, name, created_at) values
  ('stt-uploads', 'orphan/old', now() - interval '4 days'),
  ('stt-uploads', 'orphan/new', now() - interval '1 day'),
  ('attachments', 'ws/old', now() - interval '9 days');
:as_svc
select array_agg(object_path order by object_path) as exp from public.stt_upload_expired(100) \gset
select t.ok(cardinality(:'exp'::text[]) = 5 and 'orphan/old' = any(:'exp'::text[]) and not 'orphan/new' = any(:'exp'::text[])
        and not 'ws/old' = any(:'exp'::text[]), '3.2 기한 지난 3개 + 못 지운 1개 + 기록 없이 3일 넘은 1개 (다른 버킷·최근 파일 제외)', :'exp');
:as_admin
-- 실패 뒤 다시 시도해서 기한이 늘어난 파일은 만든 지 3일이 넘어도 지우면 안 됨
insert into storage.objects (bucket_id, name, created_at)
select 'stt-uploads', object_path, now() - interval '5 days' from private.stt_uploads where account_id = :'u2' and expires_at > now() limit 1;
:as_svc
select t.ok((select count(*) from public.stt_upload_expired(100)) = 5, '3.3 보관 기한이 남은 파일은 오래됐어도 정리 대상 아님');
select t.ok((select count(*) from public.stt_upload_expired(2)) = 2, '3.4 한 번에 정리할 개수 제한');
select public.stt_upload_mark_deleted(:'exp'::text[]) as nd \gset
select t.ok(:'nd'::int = 4 and (select count(*) from public.stt_upload_expired(100)) = 1, '3.5 지운 표시 → 기록 있는 4개 표시, 남은 건 지우지 못한 기록 없는 파일(Storage에서 지워지면 사라짐)', :'nd');

-- 4. 권한·비밀값·cron
:as_user
select t.err(format('select public.stt_upload_prepare(%L, gen_random_uuid(), ''m4a'', ''audio/mp4'', 10)', :'u1'), 'permission denied', '4.1 앱은 준비 함수를 직접 못 부름');
select t.err('select * from private.stt_uploads', 'permission denied', '4.2 앱은 보관함 기록을 못 봄');
select t.err('select public.stt_cleanup_check(''x'')', 'permission denied', '4.3 앱은 비밀값 확인 함수를 못 부름');
:as_admin
select decrypted_secret as sec from vault.decrypted_secrets where name = 'stt_cleanup_secret' \gset
:as_svc
select t.ok(public.stt_cleanup_check(:'sec') and length(:'sec') = 64, '4.4 Vault에 64자 비밀값이 만들어지고 맞으면 통과');
select t.ok(not public.stt_cleanup_check('wrong') and not public.stt_cleanup_check(null) and not public.stt_cleanup_check(''), '4.5 틀리거나 비면 거절');
:as_admin
select t.ok((select schedule = '23 * * * *' and command like '%functions/v1/stt-cleanup%' and command like '%x-cleanup-secret%'
             from cron.job where jobname = 'stt-uploads-cleanup'), '4.6 매시간 정리 cron 등록');
select t.ok((select not public and file_size_limit = 26214400 from storage.buckets where id = 'stt-uploads'), '4.7 버킷: 비공개, 25MB');
select t.ok(not exists (select 1 from pg_policies where tablename = 'objects' and (qual like '%stt-uploads%' or with_check like '%stt-uploads%')), '4.8 앱용 Storage 정책 없음 (서명 URL로만 올림)');

select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
