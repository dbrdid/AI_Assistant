-- 원격 확인: #26 긴 녹음 구간 한도 200개 (DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림 → 테스트 계정·녹음이 안 남음)
--   결과는 오류 메시지 SMOKE_RESULT {...}에 항목별 true/false로 나옴
do $test$
declare
  u uuid := gen_random_uuid(); r jsonb; res jsonb := '{}'::jsonb;
  segs200 jsonb; segs201 jsonb; segs182 jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'seg-smoke@stella.test', '{}'::jsonb, now(), now());
  insert into public.consents (account_id, consent_type, policy_version) values (u, 'EXTERNAL_AI', 'smoke');

  select jsonb_agg(jsonb_build_object('seq', g, 'duration_seconds', 54, 'size_bytes', 1000, 'mime_type', 'audio/mp4') order by g)
    into segs200 from generate_series(0, 199) g;
  select jsonb_agg(jsonb_build_object('seq', g, 'duration_seconds', 10, 'size_bytes', 1000, 'mime_type', 'audio/mp4') order by g)
    into segs201 from generate_series(0, 200) g;
  select jsonb_agg(jsonb_build_object('seq', g, 'duration_seconds', 60, 'size_bytes', 1000, 'mime_type', 'audio/mp4') order by g)
    into segs182 from generate_series(0, 181) g;

  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.stt_recording_create(gen_random_uuid(), segs200);
  res := res || jsonb_build_object('S1 구간 200개(3시간) 등록', (r ->> 'ok')::boolean and (r ->> 'total')::int = 200);
  res := res || jsonb_build_object('S2 201개는 TOO_MANY_SEGMENTS', public.stt_recording_create(gen_random_uuid(), segs201) ->> 'code' = 'TOO_MANY_SEGMENTS');
  res := res || jsonb_build_object('S3 1분 182개(3시간 2분)는 RECORDING_TOO_LONG', public.stt_recording_create(gen_random_uuid(), segs182) ->> 'code' = 'RECORDING_TOO_LONG');
  execute 'reset role';
  res := res || jsonb_build_object('S4 마지막 구간 seq 199·경로·시작 시각', (
    select max(seq) = 199 and max(object_path) like '%/199.m4a' and max(start_seconds) = 199 * 54
      from private.stt_segments where recording_id = (r ->> 'recording_id')::uuid));

  raise exception 'SMOKE_RESULT %', res;
end
$test$;
