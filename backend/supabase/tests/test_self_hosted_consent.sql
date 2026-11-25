-- 자체 호스팅 AI 동의 (20261125052038_self_hosted_consent) (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_self_hosted_consent.sql | grep -E "TOTAL|FAIL"
--   provider = 'self_hosted'면 SERVER_AI 동의, 그 밖(openai 등)은 지금처럼 EXTERNAL_AI 동의
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
grant execute on all functions in schema t to authenticated, anon, service_role;

\set ext  '00000000-0000-4000-8000-0000000000e1'
\set srv  '00000000-0000-4000-8000-0000000000e2'
\set both '00000000-0000-4000-8000-0000000000e3'
\set none '00000000-0000-4000-8000-0000000000e4'
\set h 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
insert into auth.users (id, email) values (:'ext', 'e1@t.dev'), (:'srv', 'e2@t.dev'), (:'both', 'e3@t.dev'), (:'none', 'e4@t.dev');
insert into public.consents (account_id, consent_type, policy_version) values
  (:'ext', 'EXTERNAL_AI', 'v1'), (:'srv', 'SERVER_AI', 'v1'), (:'both', 'EXTERNAL_AI', 'v1'), (:'both', 'SERVER_AI', 'v1');

\set as_svc  'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

:as_admin
select t.ok((select count(*) = 2 from public.consents where consent_type = 'SERVER_AI'), '1 SERVER_AI 동의를 저장할 수 있음');
select t.ok(pg_get_functiondef('public.ai_begin_request(uuid,uuid,text,uuid,text,text,text,integer)'::regprocedure)
  like '%case when p_provider = ''self_hosted'' then ''SERVER_AI'' else ''EXTERNAL_AI'' end%', '2 ai_begin_request가 경로별 동의를 봄');
select t.ok(pg_get_functiondef('public.ai_begin_request(uuid,uuid,text,uuid,text,text,text,integer)'::regprocedure) like '%p_units integer DEFAULT 1%',
  '3 p_units 기본값(1) 그대로');

:as_svc
select t.ok((public.ai_begin_request(:'srv', gen_random_uuid(), 'organize', null, :'h', 'self_hosted', 'local-model') ->> 'ok')::boolean,
  '4 SERVER_AI 동의만 있으면 자체 AI 요청은 됨');
select t.ok(public.ai_begin_request(:'srv', gen_random_uuid(), 'organize', null, :'h', 'openai', 'm') ->> 'code' = 'CONSENT_REQUIRED',
  '5 SERVER_AI 동의로 외부 AI(openai)는 안 됨');
select t.ok(public.ai_begin_request(:'ext', gen_random_uuid(), 'organize', null, :'h', 'self_hosted', 'local-model') ->> 'code' = 'CONSENT_REQUIRED',
  '6 EXTERNAL_AI 동의로 자체 AI는 안 됨 (별도 동의)');
select t.ok((public.ai_begin_request(:'ext', gen_random_uuid(), 'organize', null, :'h', 'openai', 'm') ->> 'ok')::boolean,
  '7 기존 외부 AI 요청은 그대로 됨');
select t.ok((public.ai_begin_request(:'both', gen_random_uuid(), 'organize', null, :'h', 'self_hosted', 'local-model') ->> 'ok')::boolean
  and (public.ai_begin_request(:'both', gen_random_uuid(), 'organize', null, :'h', 'openai', 'm') ->> 'ok')::boolean,
  '8 둘 다 동의하면 둘 다 됨');
select t.ok(public.ai_begin_request(:'none', gen_random_uuid(), 'organize', null, :'h', 'self_hosted', 'local-model') ->> 'code' = 'CONSENT_REQUIRED',
  '9 동의 없으면 거절');

:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
