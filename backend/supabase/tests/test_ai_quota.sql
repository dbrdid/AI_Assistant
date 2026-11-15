-- AI 월 한도 예약·정산 테스트 (로컬 전용): 횟수 단위(organize·analyze) + 분 단위(stt)
--   실행: ./reset.sh ../migrations/*.sql && psql ... -f test_ai_quota.sql
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
-- 이번 달 사용량 (used, reserved)
create function t.usage(p_account uuid, p_metric text) returns text language sql as $$
  select coalesce((select used || '/' || reserved from public.usage_counters
                    where account_id = p_account and metric = p_metric
                      and period_start = date_trunc('month', now() at time zone 'Asia/Seoul')::date), 'none')
$$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set u1 '00000000-0000-4000-8000-0000000000b1'
\set u2 '00000000-0000-4000-8000-0000000000b2'
\set u3 '00000000-0000-4000-8000-0000000000b3'
\set u4 '00000000-0000-4000-8000-0000000000b4'
insert into auth.users (id, email) values (:'u1', 'u1@t.dev'), (:'u2', 'u2@t.dev'), (:'u3', 'u3@t.dev'), (:'u4', 'u4@t.dev');
insert into public.consents (account_id, consent_type, policy_version)
select id, 'EXTERNAL_AI', 'v1' from (values (:'u1'::uuid), (:'u2'::uuid), (:'u3'::uuid)) v(id);   -- u4는 동의 없음
update public.subscriptions set plan = 'PRO', current_period_start = now(), current_period_end = now() + interval '1 month' where account_id = :'u3';  -- PRO는 기간이 있어야 함 (migration 24)

\set as_user 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000b1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_svc  'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'
\set h 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

-- =====================================================================
-- 1. 횟수 단위 (기존 organize 호출 그대로: p_units 없이 이름으로 호출)
-- =====================================================================
:as_svc
select public.ai_begin_request(p_account_id => :'u1', p_client_request_id => '10000000-0000-4000-8000-000000000001',
  p_endpoint => 'organize', p_workspace_id => null, p_input_hash => :'h', p_provider => 'openai', p_model => 'm') as b1 \gset
select t.ok((:'b1'::jsonb ->> 'ok')::boolean and (:'b1'::jsonb ->> 'remaining')::int = 99 and (:'b1'::jsonb ->> 'units')::int = 1,
  '1.1 organize: p_units 없이 불러도 1회 예약 (기존 Gateway v4 호출 그대로)', :'b1');
select t.ok(t.usage(:'u1', 'AI_ORGANIZE') = '0/1', '1.2 예약 1', t.usage(:'u1', 'AI_ORGANIZE'));
select public.ai_finish_request(p_request_id => (:'b1'::jsonb ->> 'request_id')::uuid, p_status => 'SUCCEEDED',
  p_provider_request_id => 'r', p_input_tokens => 10, p_output_tokens => 5, p_error_code => null,
  p_model => 'm', p_attempts => 1, p_cost_usd_micros => 12) \gset
select t.ok(t.usage(:'u1', 'AI_ORGANIZE') = '1/0', '1.3 성공 → 사용 1, 예약 0 (기존 9개 인자 호출 그대로)', t.usage(:'u1', 'AI_ORGANIZE'));
:as_admin
select t.ok((select charged_units = 1 and reserved_units = 1 from public.ai_requests where id = (:'b1'::jsonb ->> 'request_id')::uuid), '1.4 원장: 예약 1, 차감 1');
:as_svc
select public.ai_finish_request((:'b1'::jsonb ->> 'request_id')::uuid, 'SUCCEEDED') \gset
select t.ok(t.usage(:'u1', 'AI_ORGANIZE') = '1/0', '1.5 같은 정산을 또 불러도 두 번 차감 안 함');

select public.ai_begin_request(:'u1', '10000000-0000-4000-8000-000000000002', 'organize', null, :'h', 'openai', 'm') as b2 \gset
select public.ai_finish_request((:'b2'::jsonb ->> 'request_id')::uuid, 'FAILED', null, null, null, 'PROVIDER_ERROR') \gset
select t.ok(t.usage(:'u1', 'AI_ORGANIZE') = '1/0', '1.6 실패 → 예약만 풀고 차감 없음', t.usage(:'u1', 'AI_ORGANIZE'));
select public.ai_begin_request(:'u1', '10000000-0000-4000-8000-000000000003', 'organize', null, :'h', 'openai', 'm') as b3 \gset
select public.ai_finish_request((:'b3'::jsonb ->> 'request_id')::uuid, 'UNKNOWN', null, null, null, 'PROVIDER_TIMEOUT') \gset
select t.ok(t.usage(:'u1', 'AI_ORGANIZE') = '2/0', '1.7 결과 불명 → 예약한 만큼(1) 차감', t.usage(:'u1', 'AI_ORGANIZE'));

-- =====================================================================
-- 2. 분 단위 (stt): 예약은 앱이 보낸 길이, 차감은 실제 길이
-- =====================================================================
select public.ai_begin_request(:'u1', '20000000-0000-4000-8000-000000000001', 'stt', null, :'h', 'openai', 'gpt-transcribe', 10) as s1 \gset
select t.ok((:'s1'::jsonb ->> 'ok')::boolean and (:'s1'::jsonb ->> 'limit')::int = 60 and (:'s1'::jsonb ->> 'remaining')::int = 50,
  '2.1 stt 10분 예약 → FREE 60분 중 50분 남음', :'s1');
select t.ok(t.usage(:'u1', 'AI_STT') = '0/10', '2.2 예약 10분', t.usage(:'u1', 'AI_STT'));
select public.ai_finish_request(p_request_id => (:'s1'::jsonb ->> 'request_id')::uuid, p_status => 'SUCCEEDED',
  p_model => 'gpt-transcribe', p_attempts => 1, p_cost_usd_micros => 31500, p_charged_units => 7) \gset
select t.ok(t.usage(:'u1', 'AI_STT') = '7/0', '2.3 실제 7분 → 7분 차감, 예약 10분은 모두 풀림', t.usage(:'u1', 'AI_STT'));
:as_admin
select t.ok((select reserved_units = 10 and charged_units = 7 from public.ai_requests where id = (:'s1'::jsonb ->> 'request_id')::uuid), '2.4 원장: 예약 10, 차감 7');
:as_svc

select public.ai_begin_request(:'u1', '20000000-0000-4000-8000-000000000002', 'stt', null, :'h', 'openai', 'gpt-transcribe', 1) as s2 \gset
select public.ai_finish_request(p_request_id => (:'s2'::jsonb ->> 'request_id')::uuid, p_status => 'SUCCEEDED', p_charged_units => 5) \gset
select t.ok(t.usage(:'u1', 'AI_STT') = '12/0', '2.5 길이를 적게 보내도(1분) 실제 길이(5분)만큼 차감', t.usage(:'u1', 'AI_STT'));

select public.ai_begin_request(:'u1', '20000000-0000-4000-8000-000000000003', 'stt', null, :'h', 'openai', 'gpt-transcribe', 48) as s3 \gset
select t.ok((:'s3'::jsonb ->> 'ok')::boolean and (:'s3'::jsonb ->> 'remaining')::int = 0, '2.6 딱 한도까지(12+48=60) 예약 가능', :'s3');
select public.ai_begin_request(:'u1', '20000000-0000-4000-8000-000000000004', 'stt', null, :'h', 'openai', 'gpt-transcribe', 1) as s4 \gset
select t.ok(:'s4'::jsonb ->> 'code' = 'QUOTA_EXCEEDED' and (:'s4'::jsonb ->> 'remaining')::int = 0 and (:'s4'::jsonb ->> 'requested')::int = 1,
  '2.7 예약 중인 분까지 세서 1분도 초과 → QUOTA_EXCEEDED (남은 0분)', :'s4');
select public.ai_finish_request((:'s3'::jsonb ->> 'request_id')::uuid, 'FAILED', null, null, null, 'PROVIDER_ERROR') \gset
select t.ok(t.usage(:'u1', 'AI_STT') = '12/0', '2.8 실패 → 48분 예약이 돌아옴', t.usage(:'u1', 'AI_STT'));
select public.ai_begin_request(:'u1', '20000000-0000-4000-8000-000000000005', 'stt', null, :'h', 'openai', 'gpt-transcribe', 49) as s5 \gset
select t.ok(:'s5'::jsonb ->> 'code' = 'QUOTA_EXCEEDED' and (:'s5'::jsonb ->> 'remaining')::int = 48 and (:'s5'::jsonb ->> 'limit')::int = 60,
  '2.9 남은 48분보다 긴 49분 → 거절하고 남은 분 알려줌', :'s5');
select t.ok(t.usage(:'u1', 'AI_STT') = '12/0', '2.10 거절된 요청은 예약도 안 남김');
:as_admin
select t.ok(not exists (select 1 from public.ai_requests where client_request_id = '20000000-0000-4000-8000-000000000005'), '2.11 거절된 요청은 원장에도 없음');
:as_svc

-- 첫 요청부터 한도보다 큼 (사용량 행이 없을 때)
select public.ai_begin_request(:'u2', '20000000-0000-4000-8000-000000000006', 'stt', null, :'h', 'openai', 'gpt-transcribe', 61) as s6 \gset
select t.ok(:'s6'::jsonb ->> 'code' = 'QUOTA_EXCEEDED' and (:'s6'::jsonb ->> 'remaining')::int = 60, '2.12 첫 요청이 61분 → 거절 (남은 60분)', :'s6');
select t.ok(t.usage(:'u2', 'AI_STT') = 'none', '2.13 사용량 행도 안 만듦');

-- PRO 600분
select public.ai_begin_request(:'u3', '20000000-0000-4000-8000-000000000007', 'stt', null, :'h', 'openai', 'gpt-transcribe', 61) as s7 \gset
select t.ok((:'s7'::jsonb ->> 'ok')::boolean and (:'s7'::jsonb ->> 'limit')::int = 600 and (:'s7'::jsonb ->> 'plan') = 'PRO', '2.14 PRO는 600분', :'s7');

-- 결과 불명(타임아웃) → 예약한 만큼 차감, 오래 남은 예약 정리
select public.ai_begin_request(:'u2', '20000000-0000-4000-8000-000000000008', 'stt', null, :'h', 'openai', 'gpt-transcribe', 9) as s8 \gset
select public.ai_finish_request((:'s8'::jsonb ->> 'request_id')::uuid, 'UNKNOWN', null, null, null, 'PROVIDER_TIMEOUT') \gset
select t.ok(t.usage(:'u2', 'AI_STT') = '9/0', '2.15 결과 불명 → 예약한 9분 차감', t.usage(:'u2', 'AI_STT'));
select public.ai_begin_request(:'u2', '20000000-0000-4000-8000-000000000009', 'stt', null, :'h', 'openai', 'gpt-transcribe', 4) as s9 \gset
:as_admin
update public.ai_requests set created_at = now() - interval '11 minutes' where id = (:'s9'::jsonb ->> 'request_id')::uuid;
:as_svc
select public.ai_reconcile_stale() as n \gset
select t.ok(:'n'::int = 1 and t.usage(:'u2', 'AI_STT') = '13/0', '2.16 10분 넘게 남은 예약 정리 → UNKNOWN, 4분 차감', t.usage(:'u2', 'AI_STT'));

-- =====================================================================
-- 3. 재시도·입력 확인
-- =====================================================================
select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000001', 'stt', null, :'h', 'openai', 'gpt-transcribe', 3) as r1 \gset
select public.ai_finish_request((:'r1'::jsonb ->> 'request_id')::uuid, 'FAILED', null, null, null, 'PROVIDER_ERROR') \gset
select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000001', 'stt', null, :'h', 'openai', 'gpt-transcribe', 3) as r2 \gset
select t.ok((:'r2'::jsonb ->> 'ok')::boolean and :'r2'::jsonb ->> 'request_id' = :'r1'::jsonb ->> 'request_id' and t.usage(:'u2', 'AI_STT') = '13/3',
  '3.1 실패한 요청은 같은 id로 다시 → 같은 원장 행에 다시 예약', t.usage(:'u2', 'AI_STT'));
select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000001', 'stt', null, :'h', 'openai', 'gpt-transcribe', 3) as r3 \gset
select t.ok(:'r3'::jsonb ->> 'code' = 'IN_PROGRESS', '3.2 처리 중에 같은 id → IN_PROGRESS', :'r3');
select public.ai_finish_request(p_request_id => (:'r1'::jsonb ->> 'request_id')::uuid, p_status => 'SUCCEEDED', p_charged_units => 2) \gset
select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000001', 'stt', null, :'h', 'openai', 'gpt-transcribe', 3) as r4 \gset
select t.ok(:'r4'::jsonb ->> 'code' = 'ALREADY_DONE' and t.usage(:'u2', 'AI_STT') = '15/0', '3.3 끝난 요청을 또 → ALREADY_DONE, 추가 차감 없음', t.usage(:'u2', 'AI_STT'));

select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000002', 'stt', null, :'h', 'openai', 'gpt-transcribe', 2) as r5 \gset
select public.ai_finish_request((:'r5'::jsonb ->> 'request_id')::uuid, 'FAILED') \gset
select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000002', 'stt', null, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'openai', 'gpt-transcribe', 2) as r6 \gset
select t.ok(:'r6'::jsonb ->> 'code' = 'REQUEST_ID_REUSED', '3.4 같은 id에 다른 녹음 → REQUEST_ID_REUSED', :'r6');
select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000002', 'organize', null, :'h', 'openai', 'm') as r7 \gset
select t.ok(:'r7'::jsonb ->> 'code' = 'REQUEST_ID_REUSED', '3.5 같은 id를 다른 기능에 → REQUEST_ID_REUSED', :'r7');

select t.err(format('select public.ai_begin_request(%L, gen_random_uuid(), ''stt'', null, %L, ''openai'', ''m'', 0)', :'u2', :'h'), 'INVALID_REQUEST', '3.6 0분 예약은 거절');
select t.err(format('select public.ai_begin_request(%L, gen_random_uuid(), ''stt'', null, %L, ''openai'', ''m'', 1001)', :'u2', :'h'), 'INVALID_REQUEST', '3.7 1001분 예약은 거절');
select t.err(format('select public.ai_begin_request(%L, gen_random_uuid(), ''stt'', null, %L, ''openai'', ''m'', null)', :'u2', :'h'), 'INVALID_REQUEST', '3.8 단위 없음(null)은 거절');
select public.ai_begin_request(:'u2', '30000000-0000-4000-8000-000000000003', 'stt', null, :'h', 'openai', 'gpt-transcribe', 1) as r8 \gset
select t.err(format('select public.ai_finish_request(%L, ''SUCCEEDED'', p_charged_units => -1)', :'r8'::jsonb ->> 'request_id'), 'INVALID_REQUEST', '3.9 음수 차감은 거절');
select t.ok(t.usage(:'u2', 'AI_STT') = '15/1', '3.10 거절된 정산은 아무것도 안 바꿈', t.usage(:'u2', 'AI_STT'));

select public.ai_begin_request(:'u4', gen_random_uuid(), 'stt', null, :'h', 'openai', 'gpt-transcribe', 1) as c1 \gset
select t.ok(:'c1'::jsonb ->> 'code' = 'CONSENT_REQUIRED', '3.11 외부 AI 동의 없으면 거절', :'c1');

-- 앱(로그인 사용자)은 예약·정산 함수를 부를 수 없음
:as_user
select t.err(format('select public.ai_begin_request(%L, gen_random_uuid(), ''stt'', null, %L, ''openai'', ''m'', 1)', :'u1', :'h'), 'permission denied', '3.12 앱은 ai_begin_request를 직접 못 부름');
select t.err(format('select public.ai_finish_request(%L, ''SUCCEEDED'', p_charged_units => 0)', :'r8'::jsonb ->> 'request_id'), 'permission denied', '3.13 앱은 ai_finish_request를 직접 못 부름');
select t.ok((select count(*) from public.usage_counters where metric = 'AI_STT') = 1, '3.14 앱은 자기 사용량만 보임 (남은 분 표시용)');

:as_admin
select t.ok(not exists (select 1 from pg_proc where proname = 'ai_begin_request' and pronargs = 7)
        and not exists (select 1 from pg_proc where proname = 'ai_finish_request' and pronargs = 9), '3.15 예전 함수 모양은 남아 있지 않음 (호출이 헷갈리지 않게)');

-- =====================================================================
-- 4. AI 채팅·안건 판단 (#27): query_plan(검색 조건, 질문 횟수 아님)·query(답변 = 질문 1회)·agenda(안건 판단)
-- =====================================================================
:as_admin
select t.ok(private.ai_monthly_limit('FREE', 'query_plan') = 150 and private.ai_monthly_limit('PRO', 'query_plan') = 1500
        and private.ai_monthly_limit('FREE', 'agenda') = 50 and private.ai_monthly_limit('PRO', 'agenda') = 500
        and private.ai_monthly_limit('FREE', 'query') = 50 and private.ai_monthly_limit('PRO', 'query') = 500,
        '4.1 한도: 검색 조건 FREE 150/PRO 1500, 안건 판단 50/500, 질문(답변) 50/500');
select t.ok(private.ai_monthly_limit('FREE', 'organize') = 100 and private.ai_monthly_limit('FREE', 'analyze') = 30
        and private.ai_monthly_limit('FREE', 'stt') = 60 and private.ai_monthly_limit('PRO', 'ocr') = 300,
        '4.2 기존 한도는 그대로');
:as_svc
select public.ai_begin_request(:'u2', gen_random_uuid(), 'query_plan', null, :'h', 'openai', 'gpt-6.1-terra') as qp \gset
select public.ai_begin_request(:'u2', gen_random_uuid(), 'agenda', null, :'h', 'openai', 'gpt-6.1-terra') as ag \gset
select t.ok((:'qp'::jsonb ->> 'ok')::boolean and (:'qp'::jsonb ->> 'limit')::int = 150 and (:'qp'::jsonb ->> 'remaining')::int = 149
        and (:'ag'::jsonb ->> 'ok')::boolean and (:'ag'::jsonb ->> 'limit')::int = 50, '4.3 새 엔드포인트 예약 (검색 조건·안건 판단)', :'qp' || ' ' || :'ag');
select public.ai_finish_request((:'qp'::jsonb ->> 'request_id')::uuid, 'SUCCEEDED');
select public.ai_finish_request((:'ag'::jsonb ->> 'request_id')::uuid, 'SUCCEEDED');
select t.ok(t.usage(:'u2', 'AI_QUERY_PLAN') = '1/0' and t.usage(:'u2', 'AI_AGENDA') = '1/0' and t.usage(:'u2', 'AI_QUERY') = 'none',
        '4.4 검색 조건은 따로 세고 질문 횟수(AI_QUERY)에는 안 들어감', t.usage(:'u2', 'AI_QUERY_PLAN') || ' ' || t.usage(:'u2', 'AI_QUERY'));
select t.ok(public.ai_begin_request(:'u4', gen_random_uuid(), 'agenda', null, :'h', 'openai', 'm') ->> 'code' = 'CONSENT_REQUIRED',
        '4.5 동의 없으면 안건 판단도 거절');
:as_admin
select t.err(format('insert into public.ai_requests (account_id, client_request_id, endpoint, input_hash, provider, model, status) values (%L, gen_random_uuid(), ''chat'', %L, ''openai'', ''m'', ''RESERVED'')', :'u2', :'h'),
        'new row for relation "ai_requests" violates check constraint', '4.6 정해진 엔드포인트 말고는 기록 안 됨');
-- 한도 끝: 안건 판단 50회를 다 쓰면 거절
insert into public.usage_counters (account_id, metric, period_start, used, reserved)
values (:'u1', 'AI_AGENDA', date_trunc('month', now() at time zone 'Asia/Seoul')::date, 50, 0);
:as_svc
select t.ok(public.ai_begin_request(:'u1', gen_random_uuid(), 'agenda', null, :'h', 'openai', 'm') ->> 'code' = 'QUOTA_EXCEEDED'
        and public.ai_begin_request(:'u1', gen_random_uuid(), 'query_plan', null, :'h', 'openai', 'm') ->> 'ok' = 'true',
        '4.7 안건 판단 한도를 다 써도 채팅 검색 조건은 따로');
:as_admin

select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
