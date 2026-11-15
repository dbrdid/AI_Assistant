-- 초대 메일 (#35): 확인 · 한도 · 기록 (로컬 전용, 실제 발송은 invite_mail.test.ts가 가짜 SMTP로)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_invite_mail.sql | grep -E "TOTAL|FAIL"
\set QUIET on
\pset format unaligned
\pset tuples_only on

drop schema if exists t cascade;
create schema t;
create table t.results (n serial, name text, pass boolean, detail text);
grant usage on schema t to authenticated, anon, service_role;
grant insert, select, update on t.results to authenticated, anon, service_role;
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
    insert into t.results (name, pass, detail)
    values (p_name, sqlerrm like p_code || '%' or sqlstate = p_code, sqlstate || ' ' || sqlerrm);
  end;
end $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set own '00000000-0000-4000-8000-000000000c10'
\set ed  '00000000-0000-4000-8000-000000000c11'
\set p1  '00000000-0000-4000-8000-00000000c001'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', 'mo@test.dev', '{"name":"관리자"}'),
  (:'ed',  'me@test.dev', '{"name":"편집자"}');
\set as_own 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000c10'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_ed  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000c11'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_svc 'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

:as_own
select public.create_workspace('메일 공간') as ws \gset
select public.create_invite(:'ws', 'EDITOR', 24, 2) as inv \gset
select (:'inv'::jsonb ->> 'code') as code, (:'inv'::jsonb ->> 'invite_id') as inv_id \gset
:as_ed
select public.accept_invite(:'code') is not null as x \gset
select public.sync_push(:'ws', gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'p1', 'data', '{"name":"발표"}'::jsonb))) ->> 'status' as x \gset
select public.create_project_invite(:'p1', 'EMAIL', 'Guest@Example.com') as pinv \gset
select (:'pinv'::jsonb ->> 'code') as pcode, (:'pinv'::jsonb ->> 'project_invite_id') as pinv_id \gset
select public.create_project_invite(:'p1', 'LINK') ->> 'code' as lcode \gset
:as_own
select public.create_invite(:'ws', 'VIEWER', 24, 1) ->> 'code' as code2 \gset

-- ---------------------------------------------------------------------
-- 1. 권한 · 확인
-- ---------------------------------------------------------------------
:as_own
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'own', :'code', 'a@b.co'), '42501', '1.1 앱은 직접 못 부름 (Edge Function만)');
:as_svc
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'ed', :'code', 'a@b.co'), 'FORBIDDEN', '1.2 초대한 사람만');
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'own', 'ZZZZZ-ZZZZZ', 'a@b.co'), 'INVITE_INVALID', '1.3 없는 코드');
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'own', :'code', 'not-mail'), 'INVALID_EMAIL', '1.4 주소 형식');
select t.err(format('select public.invite_mail_prepare(%L, %L)', :'own', :'code'), 'INVALID_EMAIL', '1.5 공간 초대는 주소가 필요');
select t.err(format('select public.invite_mail_prepare(%L, %L)', :'ed', :'lcode'), 'INVALID_EMAIL', '1.6 링크 초대는 메일로 안 보냄');
select t.err(format('select public.invite_mail_prepare(%L, %L)', :'own', :'pcode'), 'FORBIDDEN', '1.7 프로젝트 초대도 초대한 사람만');

-- ---------------------------------------------------------------------
-- 2. 공간 초대 메일
-- ---------------------------------------------------------------------
select public.invite_mail_prepare(:'own', lower(:'code'), ' Friend@Example.COM ') as m1 \gset
select t.ok(:'m1'::jsonb ->> 'email' = 'friend@example.com' and :'m1'::jsonb ->> 'kind' = 'WORKSPACE'
  and :'m1'::jsonb ->> 'code' = :'code' and :'m1'::jsonb ->> 'workspace_name' = '메일 공간' and :'m1'::jsonb ->> 'inviter_name' = '관리자'
  and :'m1'::jsonb ->> 'role' = 'EDITOR', '2.1 확인 → 보낼 내용 (코드는 대문자, 주소는 소문자)', :'m1');
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'own', :'code', 'friend@example.com'), 'MAIL_TOO_SOON', '2.2 보내는 중·보낸 지 10분 안 같은 주소 → MAIL_TOO_SOON');
select public.invite_mail_result((:'m1'::jsonb ->> 'mail_id')::uuid, true) ->> 'status' as r1 \gset
:as_admin
select t.ok(:'r1' = 'SENT' and (select invitee_email = 'friend@example.com' from public.workspace_invites where id = :'inv_id'),
  '2.3 결과 SENT → 공간 초대에 받는 주소 기록', :'r1');
:as_svc
select public.invite_mail_prepare(:'own', :'code', 'other@example.com') as m2 \gset
select public.invite_mail_result((:'m2'::jsonb ->> 'mail_id')::uuid, false, 'SMTP 535') ->> 'status' as r2 \gset
select public.invite_mail_prepare(:'own', :'code', 'other@example.com') as m3 \gset
select t.ok(:'r2' = 'FAILED' and (:'m3'::jsonb ->> 'mail_id') is not null, '2.4 실패한 메일은 바로 다시 보낼 수 있음', :'m3');
select public.invite_mail_result((:'m3'::jsonb ->> 'mail_id')::uuid, true) ->> 'status' as x \gset
select t.ok(public.invite_mail_result((:'m3'::jsonb ->> 'mail_id')::uuid, false) ->> 'unchanged' = 'true', '2.5 결과는 한 번만');
:as_admin
select t.ok((select invitee_email = 'friend@example.com' from public.workspace_invites where id = :'inv_id'), '2.6 처음 주소는 그대로');

-- ---------------------------------------------------------------------
-- 3. 프로젝트 메일 초대 (초대에 적힌 주소로)
-- ---------------------------------------------------------------------
:as_svc
select public.invite_mail_prepare(:'ed', :'pcode', 'ignored@x.com') as pm \gset
select t.ok(:'pm'::jsonb ->> 'email' = 'guest@example.com' and :'pm'::jsonb ->> 'kind' = 'PROJECT' and :'pm'::jsonb ->> 'project_name' = '발표',
  '3.1 프로젝트 초대는 초대에 적힌 주소 (앱이 보낸 주소는 무시)', :'pm');
:as_admin
select last_seq as s0 from public.workspace_sync_heads where workspace_id = :'ws' \gset
:as_svc
select public.invite_mail_result((:'pm'::jsonb ->> 'mail_id')::uuid, true) ->> 'status' as x \gset
:as_admin
select t.ok((select mailed_at is not null from public.project_invites where id = :'pinv_id')
  and exists (select 1 from public.workspace_changes where workspace_id = :'ws' and seq > :s0 and entity_table = 'project_invites'
              and entity_key = :'pinv_id' and data ->> 'mailed_at' is not null),
  '3.2 보내면 mailed_at + 원장 (다른 기기 "초대 대기"에 메일 보냄 표시)');
:as_ed
select t.ok(exists (select 1 from jsonb_array_elements(public.sync_snapshot(:'ws') -> 'project_invites') x
                     where x ->> 'id' = :'pinv_id' and x ->> 'mailed_at' is not null and not (x ? 'token_hash')),
  '3.3 전체 받기에도 mailed_at (코드·해시는 없음)');
-- 취소·만료된 초대
select public.revoke_project_invite(:'pinv_id') ->> 'status' as x \gset
:as_svc
select t.err(format('select public.invite_mail_prepare(%L, %L)', :'ed', :'pcode'), 'INVITE_REVOKED', '3.4 취소된 초대');
:as_admin
update public.workspace_invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where token_hash = private.invite_code_hash(private.normalize_invite_code(:'code2'));
:as_svc
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'own', :'code2', 'x@example.com'), 'INVITE_EXPIRED', '3.5 기간 지난 초대');

-- ---------------------------------------------------------------------
-- 4. 한도
-- ---------------------------------------------------------------------
:as_own
select public.get_invite_mail_quota() as q0 \gset
select t.ok(:'q0'::jsonb ->> 'limit' = '30' and :'q0'::jsonb ->> 'used' = '2', '4.1 오늘 남은 메일 (실패한 것은 안 셈)', :'q0');
:as_admin
insert into private.invite_mails (account_id, invite_id, email, status)
select :'own', :'inv_id', 'bulk' || g || '@example.com', 'SENT' from generate_series(1, 27) g;
insert into private.invite_mails (account_id, invite_id, email, status, created_at)
select :'own', :'inv_id', 'old' || g || '@example.com', 'SENT', now() - interval '2 days' from generate_series(1, 5) g;
:as_svc
select public.invite_mail_prepare(:'own', :'code', 'thirtieth@example.com') ->> 'mail_id' as m30 \gset
select t.ok(:'m30' is not null, '4.2a 오늘 30번째까지는 보냄 (어제 것은 안 셈)');
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'own', :'code', 'new@example.com'), 'MAIL_LIMIT', '4.2 한 사람 하루 30통');
:as_admin
delete from private.invite_mails where email like 'bulk%' or email = 'thirtieth@example.com';
insert into private.invite_mails (account_id, invite_id, email, status)
select null, :'inv_id', 'all' || g || '@example.com', 'SENT' from generate_series(1, 448) g;
:as_svc
select t.err(format('select public.invite_mail_prepare(%L, %L, %L)', :'own', :'code', 'new@example.com'), 'MAIL_LIMIT', '4.3 서비스 전체 하루 450통');
:as_admin
delete from private.invite_mails where email like 'all%';
-- 보내다 멈춘 기록 정리
:as_svc
select public.invite_mail_prepare(:'own', :'code', 'stuck@example.com') ->> 'mail_id' as stuck \gset
:as_admin
update private.invite_mails set created_at = now() - interval '11 minutes' where id = :'stuck';
:as_svc
select public.invite_mail_prepare(:'own', :'code', 'fresh@example.com') ->> 'mail_id' as fresh \gset
:as_admin
select private.invite_mails_cleanup() as cl \gset
select t.ok(:cl = 1 and (select status = 'FAILED' and error = 'TIMEOUT' from private.invite_mails where id = :'stuck')
  and (select status = 'SENDING' from private.invite_mails where id = :'fresh'), '4.4 10분 넘게 SENDING이면 실패로 정리 (방금 것은 그대로)', :'cl');
select t.ok(exists (select 1 from cron.job where jobname = 'invite-mails-cleanup'), '4.5 cron 등록');
select t.ok(not has_table_privilege('authenticated', 'private.invite_mails', 'select')
  and not has_function_privilege('authenticated', 'public.invite_mail_result(uuid, boolean, text)', 'execute'), '4.6 기록·결과 함수는 앱이 못 씀');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
