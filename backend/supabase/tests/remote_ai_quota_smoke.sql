-- 원격 확인: AI 한도 예약·정산 (분 단위 stt + 횟수 단위 organize). DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림
do $test$
declare
  u uuid := gen_random_uuid(); h text := repeat('d', 64); r jsonb; r2 jsonb; res jsonb := '[]'::jsonb; usage text;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stt-smoke@stella.test', '{}'::jsonb, now(), now());
  insert into public.consents (account_id, consent_type, policy_version) values (u, 'EXTERNAL_AI', 'smoke');

  r := public.ai_begin_request(u, gen_random_uuid(), 'stt', null, h, 'openai', 'gpt-transcribe', 10);
  res := res || jsonb_build_object('Q1 stt 10분 예약 (FREE 60분)', (r ->> 'ok')::boolean and (r ->> 'limit')::int = 60 and (r ->> 'remaining')::int = 50);
  perform public.ai_finish_request(p_request_id => (r ->> 'request_id')::uuid, p_status => 'SUCCEEDED', p_charged_units => 7);
  select used || '/' || reserved into usage from public.usage_counters where account_id = u and metric = 'AI_STT';
  res := res || jsonb_build_object('Q2 실제 7분 차감, 예약 풀림', usage = '7/0');

  r := public.ai_begin_request(u, gen_random_uuid(), 'stt', null, h, 'openai', 'gpt-transcribe', 54);
  res := res || jsonb_build_object('Q3 남은 53분보다 길면 거절', r ->> 'code' = 'QUOTA_EXCEEDED' and (r ->> 'remaining')::int = 53);

  r := public.ai_begin_request(u, gen_random_uuid(), 'stt', null, h, 'openai', 'gpt-transcribe', 3);
  perform public.ai_finish_request((r ->> 'request_id')::uuid, 'FAILED', null, null, null, 'PROVIDER_ERROR');
  select used || '/' || reserved into usage from public.usage_counters where account_id = u and metric = 'AI_STT';
  res := res || jsonb_build_object('Q4 실패는 차감 없음', usage = '7/0');

  -- 기존 Gateway v4 호출 모양 (p_units 없이 이름으로)
  r2 := public.ai_begin_request(p_account_id => u, p_client_request_id => gen_random_uuid(), p_endpoint => 'organize',
          p_workspace_id => null, p_input_hash => h, p_provider => 'openai', p_model => 'gpt-5.6-luna');
  perform public.ai_finish_request(p_request_id => (r2 ->> 'request_id')::uuid, p_status => 'SUCCEEDED', p_provider_request_id => 'x',
          p_input_tokens => 1, p_output_tokens => 1, p_error_code => null, p_model => 'gpt-5.6-luna', p_attempts => 1, p_cost_usd_micros => 1);
  select used || '/' || reserved into usage from public.usage_counters where account_id = u and metric = 'AI_ORGANIZE';
  res := res || jsonb_build_object('Q5 organize 기존 호출 그대로 (1회)', (r2 ->> 'remaining')::int = 99 and usage = '1/0');

  res := res || jsonb_build_object('Q6 앱은 예약·정산 함수 못 부름',
    not has_function_privilege('authenticated', 'public.ai_begin_request(uuid,uuid,text,uuid,text,text,text,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.ai_finish_request(uuid,text,text,integer,integer,text,text,integer,bigint,integer)', 'execute'));
  res := res || jsonb_build_object('Q7 10분 정리 cron 그대로', (select count(*) = 1 from cron.job where command like '%ai_reconcile_stale%'));
  raise exception 'SMOKE_RESULT %', res;
end
$test$;
