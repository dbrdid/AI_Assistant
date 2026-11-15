-- 긴 녹음 처리 테스트 (로컬 전용): 등록·업로드 정책·확인·워커(가져오기·성공·실패)·재시도·취소·정리·권한
--   실행: ./reset.sh ../migrations/*.sql && psql ... -f test_stt_recordings.sql
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
-- n초 길이 구간 k개 (각 120KB, m4a)
create function t.segs(k int, sec numeric default 300, sz bigint default 120000, mime text default 'audio/mp4') returns jsonb
language sql as $$ select jsonb_agg(jsonb_build_object('seq', g, 'duration_seconds', sec, 'size_bytes', sz, 'mime_type', mime) order by g)
                     from generate_series(0, k - 1) g $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set u1 '00000000-0000-4000-8000-0000000000d1'
\set u2 '00000000-0000-4000-8000-0000000000d2'
\set u3 '00000000-0000-4000-8000-0000000000d3'
insert into auth.users (id, email) values (:'u1', 'd1@t.dev'), (:'u2', 'd2@t.dev'), (:'u3', 'd3@t.dev');
insert into public.consents (account_id, consent_type, policy_version) values (:'u1', 'EXTERNAL_AI', 'v1'), (:'u2', 'EXTERNAL_AI', 'v1');

\set as_u1 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_u2 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d2'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_u3 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d3'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_svc  'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'
\set r1 '20000000-0000-4000-8000-0000000000a1'
\set r2 '20000000-0000-4000-8000-0000000000a2'
\set r3 '20000000-0000-4000-8000-0000000000a3'
\set r4 '20000000-0000-4000-8000-0000000000a4'
\set ws '30000000-0000-4000-8000-0000000000b1'

-- =====================================================================
-- 1. 녹음 등록
-- =====================================================================
:as_u1
select public.stt_recording_create(:'r1', t.segs(3, 300) , null, array['ko'], array['Stella', ' 손주원 ', 'Stella', 'a<b']) as c1 \gset
select t.ok((:'c1'::jsonb ->> 'ok')::boolean and :'c1'::jsonb ->> 'state' = 'UPLOADING' and (:'c1'::jsonb ->> 'total')::int = 3
        and :'c1'::jsonb ->> 'bucket' = 'stt-recordings' and (:'c1'::jsonb ->> 'minutes_needed')::int = 15
        and (:'c1'::jsonb ->> 'remaining_minutes')::int = 60 and :'c1'::jsonb ->> 'plan' = 'FREE',
        '1.1 3구간(15분) 등록 → 업로드 대기, 필요 15분 / 남은 60분', :'c1');
select t.ok((:'c1'::jsonb -> 'segments' -> 2 ->> 'path') = :'u1' || '/' || :'r1' || '/002.m4a'
        and (:'c1'::jsonb -> 'segments' -> 2 ->> 'start_seconds')::numeric = 600, '1.2 구간 경로 {계정}/{녹음}/002.m4a, 시작 시각 누적(600초)');
:as_admin
select t.ok((select languages = '{ko}' and keywords @> '{Stella,손주원}' and cardinality(keywords) = 2
             from private.stt_recordings where id = :'r1'), '1.3 언어·키워드 정리(중복·공백·<> 제거)');
:as_u3
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(1)) ->> 'code' = 'CONSENT_REQUIRED', '1.4 외부 AI 동의 없으면 거절');
:as_u1
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(1), :'ws') ->> 'code' = 'FORBIDDEN', '1.5 편집 권한 없는 공간이면 거절');
select t.ok(public.stt_recording_create(gen_random_uuid(), '[{"seq":0,"duration_seconds":10,"size_bytes":10,"mime_type":"audio/mp4"},{"seq":2,"duration_seconds":10,"size_bytes":10,"mime_type":"audio/mp4"}]') ->> 'detail' = 'seq', '1.6 seq 빈틈 거절');
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(37, 300)) ->> 'code' = 'RECORDING_TOO_LONG', '1.7 3시간 넘으면 거절 (37×5분)');
select t.ok((public.stt_recording_create(gen_random_uuid(), t.segs(36, 300)) ->> 'ok')::boolean, '1.8 정확히 3시간(36×5분)은 됨');
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(1, 300, 26214401)) ->> 'code' = 'TOO_LARGE', '1.9 구간 25MB 넘으면 거절');
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(1, 300, 100, 'audio/aac')) ->> 'code' = 'UNSUPPORTED_TYPE', '1.10 형식 확인 (raw AAC 거절)');
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(1, 901)) ->> 'detail' = 'duration_seconds', '1.11 구간 하나 15분 넘으면 거절');
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(201, 10)) ->> 'code' = 'TOO_MANY_SEGMENTS', '1.12 구간 200개 넘으면 거절');
-- 1분 구간 3시간(180개)·54초 구간 200개는 됨 (#26). 확인 뒤 지워서 아래 '끝나지 않은 녹음 3개' 검사에 영향 없게
select public.stt_recording_create(gen_random_uuid(), t.segs(200, 54)) as c200 \gset
select t.ok((:'c200'::jsonb ->> 'ok')::boolean and (:'c200'::jsonb ->> 'total')::int = 200, '1.12a 구간 200개(54초씩, 3시간) 등록됨');
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(182, 60)) ->> 'code' = 'RECORDING_TOO_LONG', '1.12b 1분 구간 182개(3시간 2분)는 거절');
:as_admin
select t.ok((select max(seq) = 199 and max(object_path) like '%/199.m4a' and max(start_seconds) = 199 * 54
               from private.stt_segments where recording_id = (:'c200'::jsonb ->> 'recording_id')::uuid), '1.12c 마지막 구간 seq 199·경로·시작 시각');
delete from private.stt_recordings where id = (:'c200'::jsonb ->> 'recording_id')::uuid;
:as_u1
select t.ok(public.stt_recording_create(gen_random_uuid(), '[{"seq":0,"size_bytes":10,"mime_type":"audio/mp4"}]') ->> 'code' = 'INVALID_REQUEST', '1.13 길이 없으면 거절');
select t.ok(public.stt_recording_create(:'r1', t.segs(3)) ->> 'existing' = 'true', '1.14 같은 id로 다시 등록 → 기존 녹음 그대로(이어 올리기)');
select t.ok(public.stt_recording_create(:'r1', t.segs(4)) ->> 'code' = 'RECORDING_EXISTS', '1.15 같은 id에 다른 구간 수 → 거절');
:as_u2
select t.ok(public.stt_recording_create(:'r1', t.segs(3)) ->> 'code' = 'RECORDING_ID_TAKEN', '1.16 남의 녹음 id는 못 씀');
:as_u1
select public.stt_recording_create(gen_random_uuid(), t.segs(1)) as c_third \gset
select t.ok(public.stt_recording_create(gen_random_uuid(), t.segs(1)) ->> 'code' = 'TOO_MANY_ACTIVE', '1.17 끝나지 않은 녹음은 3개까지', :'c_third');
-- 공유 공간 (u1이 OWNER)
:as_admin
delete from private.stt_recordings where id not in (:'r1');
:as_u1
select public.create_workspace('W') as ws \gset
select t.ok((public.stt_recording_create(:'r2', t.segs(2, 300), :'ws') ->> 'workspace_id') = :'ws', '1.18 공유 공간 녹음 등록 (편집 권한 있음)');

-- =====================================================================
-- 2. Storage 업로드 정책 (앱이 직접 올림)
-- =====================================================================
:as_u1
insert into storage.objects (bucket_id, name, metadata) values ('stt-recordings', :'u1' || '/' || :'r1' || '/000.m4a', '{"size": 120000}');
select t.ok(true, '2.1 내 업로드 대기 구간 경로에는 올릴 수 있음');
select t.err($$insert into storage.objects (bucket_id, name, metadata) values ('stt-recordings', '00000000-0000-4000-8000-0000000000d1/x/999.m4a', '{"size":1}')$$,
             'new row violates row-level security', '2.2 등록 안 된 경로에는 못 올림');
:as_u2
select t.err(format($$insert into storage.objects (bucket_id, name, metadata) values ('stt-recordings', '%s/%s/001.m4a', '{"size":1}')$$, :'u1', :'r1'),
             'new row violates row-level security', '2.3 남의 녹음 경로에는 못 올림');
select t.ok(not exists (select 1 from storage.objects where bucket_id = 'stt-recordings'), '2.4 남의 녹음 파일은 안 보임');
:as_u1
with u as (update storage.objects set metadata = '{"size": 120000}' where bucket_id = 'stt-recordings' and name = :'u1' || '/' || :'r1' || '/000.m4a' returning 1)
select t.ok(count(*) = 1, '2.5 업로드 대기 중에는 같은 경로에 다시 올리기(upsert) 가능') from u;

-- =====================================================================
-- 3. 업로드 확인 → 작업 등록
-- =====================================================================
:as_admin
update private.stt_worker_state set last_kick_at = 'epoch';
delete from net.calls;
:as_u1
select t.ok(public.stt_segment_confirm(:'r1', 1) ->> 'code' = 'NOT_UPLOADED', '3.1 아직 안 올린 구간 확인 → NOT_UPLOADED');
insert into storage.objects (bucket_id, name, metadata) values ('stt-recordings', :'u1' || '/' || :'r1' || '/001.m4a', '{"size": 99}');
select public.stt_segment_confirm(:'r1', 1) as cf_bad \gset
select t.ok(:'cf_bad'::jsonb ->> 'code' = 'SIZE_MISMATCH' and (:'cf_bad'::jsonb ->> 'actual')::int = 99, '3.2 크기가 다르면 SIZE_MISMATCH (다시 올리기)', :'cf_bad');
update storage.objects set metadata = '{"size": 120000}' where name = :'u1' || '/' || :'r1' || '/001.m4a';
select public.stt_segment_confirm(:'r1', 0) as cf0 \gset
select t.ok((:'cf0'::jsonb ->> 'ok')::boolean and :'cf0'::jsonb ->> 'status' = 'QUEUED' and (:'cf0'::jsonb ->> 'uploads_left')::int = 2
        and not (:'cf0'::jsonb ->> 'all_uploaded')::boolean, '3.3 확인되면 QUEUED(전사 작업 등록), 남은 업로드 2', :'cf0');
select t.ok((public.stt_segment_confirm(:'r1', 1) ->> 'ok')::boolean, '3.4 다시 올린 뒤 확인 → 등록');
select t.ok(public.stt_segment_confirm(:'r1', 0) ->> 'already' = 'true', '3.5 같은 구간 다시 확인 → 이미 등록(앱 재시도 안전)');
update storage.objects set metadata = '{"size":1}' where bucket_id = 'stt-recordings' and name = :'u1' || '/' || :'r1' || '/000.m4a';
:as_admin
select t.ok((select metadata ->> 'size' = '120000' from storage.objects where name = :'u1' || '/' || :'r1' || '/000.m4a'), '3.6 확인된 구간은 덮어쓸 수 없음');
select t.ok((select count(*) from net.calls where url like '%/functions/v1/stt-worker') = 1, '3.7 워커는 5초에 한 번만 깨움 (확인 2건 → 호출 1건)');
select t.ok((select headers ->> 'x-cleanup-secret' = (select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret')
             from net.calls where url like '%stt-worker' limit 1), '3.8 워커 호출에 Vault 비밀값');
:as_u2
select t.ok(public.stt_segment_confirm(:'r1', 2) ->> 'code' = 'NOT_FOUND', '3.9 남의 녹음은 확인 못 함');
select t.ok(public.stt_recording_status(:'r1') ->> 'code' = 'NOT_FOUND', '3.10 남의 녹음 상태도 못 봄');
:as_u1
select public.stt_recording_status(:'r1') as st1 \gset
select t.ok(:'st1'::jsonb ->> 'state' = 'UPLOADING' and (:'st1'::jsonb -> 'counts' ->> 'queued')::int = 2
        and (:'st1'::jsonb -> 'counts' ->> 'pending_upload')::int = 1, '3.11 상태: 업로드 중, 대기 2 / 업로드 대기 1', :'st1');

-- =====================================================================
-- 4. 워커: 가져오기·성공·실패
-- =====================================================================
:as_svc
select public.stt_segment_claim(5, 2) as cl1 \gset
select t.ok(jsonb_array_length(:'cl1'::jsonb) = 2 and (:'cl1'::jsonb -> 0 ->> 'seq')::int = 0
        and :'cl1'::jsonb -> 0 ->> 'prompt' is null and :'cl1'::jsonb -> 0 -> 'keywords' ? 'Stella', '4.1 대기 구간 2개 가져옴(순서대로, 언어·키워드 포함)', :'cl1');
:as_admin
update private.stt_segments set status = 'QUEUED' where recording_id = :'r1' and seq = 2;
:as_svc
select t.ok(jsonb_array_length(public.stt_segment_claim(5, 2)) = 0, '4.2 동시 처리 2개면 대기 구간이 있어도 더 안 줌');
:as_admin
update private.stt_segments set status = 'PENDING_UPLOAD' where recording_id = :'r1' and seq = 2;
:as_svc
select (:'cl1'::jsonb -> 0 ->> 'segment_id') as s0, (:'cl1'::jsonb -> 0 ->> 'lease_id') as l0,
       (:'cl1'::jsonb -> 1 ->> 'segment_id') as s1, (:'cl1'::jsonb -> 1 ->> 'lease_id') as l1 \gset
select t.ok(public.stt_segment_succeed(:'s0', gen_random_uuid(), 'x', '{ko}', 300, 5) ->> 'code' = 'LEASE_LOST', '4.3 다른 처리의 결과는 안 받음');
select t.ok((public.stt_segment_succeed(:'s0', :'l0', '첫 구간 전사문입니다.', '{ko}', 299.5, 5) ->> 'ok')::boolean, '4.4 성공 → 전사문 저장');
:as_admin
select t.ok((select status = 'DONE' and transcript = '첫 구간 전사문입니다.' and charged_minutes = 5 and not object_deleted
             from private.stt_segments where id = :'s0'), '4.5 DONE·전사문·차감 분 기록, 음성은 아직(저장 확인 뒤 워커가 삭제)');
:as_svc
select t.ok(:'u1' || '/' || :'r1' || '/000.m4a' in (select object_path from public.stt_recording_expired(100)), '4.6 전사된 구간 음성은 정리 대상(워커가 못 지웠을 때 대비)');
-- 일시 오류 → 자동 재시도
select public.stt_segment_fail(:'s1', :'l1', 'PROVIDER_ERROR', true) as f1 \gset
select t.ok(:'f1'::jsonb ->> 'status' = 'QUEUED', '4.7 일시 오류 → 자동 재시도 대기', :'f1');
:as_admin
select retain_until as ret1, first_failed_at as ff1 from private.stt_segments where id = :'s1' \gset
select t.ok((select next_attempt_at > now() + interval '20 seconds' and retain_until > now() + interval '71 hours'
             from private.stt_segments where id = :'s1'), '4.8 30초 뒤 재시도, 보관 기한 = 최초 실패 + 3일');
:as_svc
select t.ok(jsonb_array_length(public.stt_segment_claim(5, 2)) = 0, '4.9 재시도 시각 전에는 안 가져감');
:as_admin
update private.stt_segments set next_attempt_at = now() where id = :'s1';
:as_svc
select public.stt_segment_claim(1, 2) as cl2 \gset
select t.ok((:'cl2'::jsonb -> 0 ->> 'seq')::int = 1 and :'cl2'::jsonb -> 0 ->> 'prompt' = '첫 구간 전사문입니다.', '4.10 다시 가져올 때 앞 구간 끝부분을 prompt로', :'cl2');
select public.stt_segment_fail(:'s1', (:'cl2'::jsonb -> 0 ->> 'lease_id')::uuid, 'PROVIDER_ERROR', true) ->> 'status' as f2 \gset
:as_admin
update private.stt_segments set next_attempt_at = now() where id = :'s1';
:as_svc
select public.stt_segment_claim(1, 2) as cl3 \gset
select public.stt_segment_fail(:'s1', (:'cl3'::jsonb -> 0 ->> 'lease_id')::uuid, 'PROVIDER_ERROR', true) as f3 \gset
select t.ok(:'f2' = 'QUEUED' and :'f3'::jsonb ->> 'status' = 'FAILED', '4.11 자동 재시도는 2번까지 → 3번째 실패면 FAILED', :'f3');
:as_admin
select t.ok((select retain_until = :'ret1'::timestamptz and first_failed_at = :'ff1'::timestamptz and attempts = 3
             from private.stt_segments where id = :'s1'), '4.12 재시도해도 보관 기한 그대로(연장 없음)');

-- =====================================================================
-- 5. 상태·재시도·전사문·ack
-- =====================================================================
:as_u1
insert into storage.objects (bucket_id, name, metadata) values ('stt-recordings', :'u1' || '/' || :'r1' || '/002.m4a', '{"size": 120000}');
select public.stt_segment_confirm(:'r1', 2) ->> 'all_uploaded' as allup \gset
select t.ok(:'allup' = 'true', '5.1 마지막 구간 확인 → all_uploaded (앱이 기기 원본 삭제)');
:as_svc
select public.stt_segment_claim(2, 2) as cl4 \gset
select public.stt_segment_fail((:'cl4'::jsonb -> 0 ->> 'segment_id')::uuid, (:'cl4'::jsonb -> 0 ->> 'lease_id')::uuid, 'AUDIO_REJECTED', false) ->> 'status' as f4 \gset
select t.ok(:'f4' = 'FAILED', '5.2 다시 해도 안 되는 오류 → 바로 FAILED');
:as_u1
select public.stt_recording_status(:'r1') as st2 \gset
select t.ok(:'st2'::jsonb ->> 'state' = 'NEEDS_RETRY' and (:'st2'::jsonb -> 'counts' ->> 'done')::int = 1
        and (:'st2'::jsonb -> 'counts' ->> 'failed')::int = 2 and (:'st2'::jsonb ->> 'charged_minutes')::int = 5
        and :'st2'::jsonb ->> 'retry_until' is not null, '5.3 상태: 재시도 필요, 완료 1·실패 2, 차감 5분, 재시도 기한', :'st2');
select public.stt_recording_transcript(:'r1') as tr1 \gset
select t.ok(:'tr1'::jsonb -> 'segments' -> 0 ->> 'text' = '첫 구간 전사문입니다.' and :'tr1'::jsonb -> 'segments' -> 1 ->> 'text' is null
        and :'tr1'::jsonb -> 'segments' -> 1 ->> 'status' = 'FAILED', '5.4 전사문: 순서대로, 실패 구간은 글 없음', :'tr1');
select public.stt_recording_retry(:'r1', array[1]) ->> 'requeued' as rq \gset
select t.ok(:'rq' = '1', '5.5 실패 구간만 골라서 다시 시도');
:as_admin
select t.ok((select status = 'QUEUED' and auto_retries = 0 and retain_until = :'ret1'::timestamptz from private.stt_segments where id = :'s1'),
            '5.6 수동 재시도: 다시 대기, 자동 재시도 횟수 초기화, 보관 기한은 그대로');
update private.stt_segments set retain_until = now() - interval '1 second' where recording_id = :'r1' and seq = 2;
:as_u1
select t.ok(public.stt_recording_retry(:'r1') ->> 'requeued' = '0', '5.7 보관 기한 지난 구간은 재시도 안 됨');
:as_svc
select t.ok(:'u1' || '/' || :'r1' || '/002.m4a' in (select object_path from public.stt_recording_expired(100)), '5.8 기한 지난 실패 구간은 정리 대상');
select public.stt_recording_mark_deleted(array[:'u1' || '/' || :'r1' || '/002.m4a', :'u1' || '/' || :'r1' || '/001.m4a']) as md \gset
:as_admin
select t.ok(:'md' = '1' and (select status = 'GAVE_UP' and object_deleted and error_code = 'AUDIO_REJECTED' from private.stt_segments where recording_id = :'r1' and seq = 2)
        and (select status = 'QUEUED' and not object_deleted from private.stt_segments where recording_id = :'r1' and seq = 1),
        '5.9 정리 후 최종 실패(GAVE_UP), 아직 처리할 구간은 표시 안 바뀜');
:as_u1
select t.ok((public.stt_recording_ack(:'r1') ->> 'cleared')::int = 1, '5.10 ack → 서버 임시 전사문 삭제');
:as_admin
select t.ok(not exists (select 1 from private.stt_segments where recording_id = :'r1' and transcript is not null), '5.11 전사문 없음');

-- =====================================================================
-- 6. 처리 중 멈춘 워커, 취소
-- =====================================================================
:as_svc
select public.stt_segment_claim(1, 2) as cl5 \gset
:as_admin
update private.stt_segments set locked_at = now() - interval '5 minutes' where id = :'s1';
:as_svc
select public.stt_segment_claim(1, 2) as cl6x \gset
:as_admin
select t.ok(:'cl6x' = '[]' and (select status = 'QUEUED' and error_code = 'WORKER_LOST' and auto_retries = 1 and next_attempt_at > now()
             from private.stt_segments where id = :'s1'), '6.1 4분 넘게 응답 없는 처리 → 실패 1회(WORKER_LOST)로 보고 30초 뒤 다시 대기');
update private.stt_segments set next_attempt_at = now() where id = :'s1';
:as_svc
select public.stt_segment_claim(1, 2) as cl6 \gset
:as_admin
select t.ok((select attempts = 5 and status = 'PROCESSING' and lease_id::text = :'cl6'::jsonb -> 0 ->> 'lease_id' from private.stt_segments where id = :'s1'),
            '6.1b 다시 처리할 때 새 lease');
:as_svc
select t.ok(public.stt_segment_succeed(:'s1', (:'cl5'::jsonb -> 0 ->> 'lease_id')::uuid, 'late', '{ko}', 300, 5) ->> 'code' = 'LEASE_LOST', '6.2 늦게 온 옛 결과는 버림');
:as_admin
delete from net.calls;
update private.stt_segments set transcript = '취소 전 전사문' where id = :'s0';
:as_u1
select t.ok((public.stt_recording_cancel(:'r1') ->> 'ok')::boolean, '6.3 취소');
:as_svc
select t.ok(public.stt_segment_succeed(:'s1', (:'cl6'::jsonb -> 0 ->> 'lease_id')::uuid, 'after cancel', '{ko}', 300, 5) ->> 'code' = 'CANCELED', '6.4 취소 뒤 끝난 처리 결과는 저장 안 함');
:as_admin
select t.ok((select bool_and(status in ('CANCELED', 'GAVE_UP', 'DONE') and transcript is null) from private.stt_segments where recording_id = :'r1')
        and exists (select 1 from net.calls where url like '%stt-cleanup'), '6.5 취소: 남은 구간 CANCELED, 전사문 삭제, 바로 정리 함수 호출');
:as_u1
select t.ok(public.stt_segment_confirm(:'r1', 0) ->> 'code' = 'CANCELED' and public.stt_recording_status(:'r1') ->> 'state' = 'CANCELED', '6.6 취소된 녹음: 확인 거절, 상태 CANCELED');
:as_svc
select t.ok(:'u1' || '/' || :'r1' || '/001.m4a' in (select object_path from public.stt_recording_expired(100)), '6.7 취소 구간 음성은 정리 대상');

-- =====================================================================
-- 7. 업로드 안 된 구간·고아 파일·기록 정리
-- =====================================================================
:as_admin
update private.stt_segments set created_at = now() - interval '4 days' where recording_id = :'r2' and seq = 1;
insert into storage.objects (bucket_id, name, metadata, created_at) values ('stt-recordings', 'gone/old/000.m4a', '{"size":1}', now() - interval '4 days');
:as_svc
select array_agg(object_path order by object_path) as ex from public.stt_recording_expired(100) \gset
select t.ok(:'ex'::text[] @> array[:'u1' || '/' || :'r2' || '/001.m4a', 'gone/old/000.m4a']
        and not (:'ex'::text[] @> array[:'u1' || '/' || :'r2' || '/000.m4a']), '7.1 3일 지나도 안 올라온 구간·기록 없는 파일은 정리 대상, 최근 구간은 아님', :'ex');
select public.stt_recording_mark_deleted(:'ex'::text[]) as md2 \gset
:as_admin
select t.ok((select status = 'GAVE_UP' and error_code = 'UPLOAD_EXPIRED' from private.stt_segments where recording_id = :'r2' and seq = 1),
            '7.2 안 올라온 구간 → 최종 실패(UPLOAD_EXPIRED)');
update private.stt_segments set object_deleted = true where recording_id = :'r1';
:as_svc
select public.stt_recording_purge() as pg1 \gset
:as_admin
select t.ok(not exists (select 1 from private.stt_recordings where id = :'r1') and exists (select 1 from private.stt_recordings where id = :'r2'),
            '7.3 파일이 다 지워진 취소 녹음은 기록째 삭제, 진행 중인 녹음은 남김', :'pg1');
-- 3일 넘게 처리 안 된 대기 구간 (예: 키 없음)
update private.stt_segments set status = 'QUEUED', uploaded_at = now() - interval '4 days', object_deleted = false where recording_id = :'r2' and seq = 0;
:as_svc
select public.stt_recording_mark_deleted(array(select object_path from public.stt_recording_expired(100))) as md3 \gset
:as_admin
select t.ok((select status = 'GAVE_UP' and error_code = 'NOT_PROCESSED' and object_deleted from private.stt_segments where recording_id = :'r2' and seq = 0),
            '7.3b 3일 넘게 처리되지 못한 대기 구간 → 최종 실패(NOT_PROCESSED)');
-- 7일 지난 전사문
:as_u1
select public.stt_recording_create(:'r3', t.segs(1, 60)) as c3 \gset
:as_admin
update private.stt_segments set status = 'DONE', transcript = 'old', object_deleted = true, updated_at = now() - interval '8 days' where recording_id = :'r3';
update private.stt_recordings set updated_at = now() - interval '8 days' where id = :'r3';
:as_svc
select public.stt_recording_purge() as pg2 \gset
:as_admin
select t.ok(not exists (select 1 from private.stt_recordings where id = :'r3'), '7.4 ack 안 해도 7일 지나면 전사문·기록 삭제');

-- =====================================================================
-- 8. 권한·일정
-- =====================================================================
:as_u1
select t.err('select public.stt_segment_claim(1, 2)', 'permission denied', '8.1 앱은 워커 함수를 못 부름');
select t.err('select * from private.stt_segments', 'permission denied', '8.2 앱은 구간 표를 직접 못 봄');
select t.err('select public.stt_recording_purge()', 'permission denied', '8.3 앱은 정리 함수를 못 부름');
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
set role anon;
select t.err('select public.stt_recording_create(gen_random_uuid(), ''[]'')', 'permission denied', '8.4 로그인 안 하면 등록 못 함');
:as_admin
select t.ok((select schedule = '* * * * *' from cron.job where jobname = 'stt-worker-tick')
        and (select schedule = '41 * * * *' from cron.job where jobname = 'stt-recordings-purge'), '8.5 cron: 매분 워커 확인, 매시간 기록 정리');
update private.stt_worker_state set last_kick_at = 'epoch';
delete from net.calls;
update private.stt_segments set status = 'GAVE_UP' where status in ('QUEUED', 'PROCESSING');
select private.stt_worker_tick();
select t.ok(not exists (select 1 from net.calls), '8.6 처리할 구간이 없으면 워커를 안 깨움');
update private.stt_segments set status = 'QUEUED', next_attempt_at = now() where recording_id = :'r2' and seq = 0;
select private.stt_worker_tick();
select t.ok((select count(*) from net.calls where url like '%stt-worker') = 1, '8.7 대기 구간이 있으면 깨움');
select t.ok((select not public and file_size_limit = 26214400 from storage.buckets where id = 'stt-recordings'), '8.8 버킷: 비공개, 25MB');
select t.ok((select count(*) from pg_policies where tablename = 'objects' and policyname like 'stt_recordings_%') = 3
        and not exists (select 1 from pg_policies where tablename = 'objects' and policyname like 'stt_recordings_%' and cmd = 'DELETE'),
        '8.9 Storage 정책: 올리기·다시 올리기만 (삭제 없음)');

select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
