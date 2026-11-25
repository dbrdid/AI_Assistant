-- 공간 결제 주체 · 멤버 만료 · 감사 기록 (11/25, 로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_workspace_billing.sql | grep -E "TOTAL|FAIL"
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
create function t.billing(p_ws uuid) returns uuid language sql security definer as $$
  select billing_account_id from public.workspaces where id = p_ws $$;
create function t.audits(p_ws uuid, p_action text) returns bigint language sql security definer as $$
  select count(*) from public.audit_logs where workspace_id = p_ws and action = p_action $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set o  '00000000-0000-4000-8000-000000000e10'
\set o2 '00000000-0000-4000-8000-000000000e11'
\set ed '00000000-0000-4000-8000-000000000e12'
\set vw '00000000-0000-4000-8000-000000000e13'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'o',  'bo@test.dev',  '{"name":"만든 사람"}'),
  (:'o2', 'bo2@test.dev', '{"name":"다른 관리자"}'),
  (:'ed', 'be@test.dev',  '{"name":"편집자"}'),
  (:'vw', 'bv@test.dev',  '{"name":"게스트"}');
\set as_o  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000e10'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_o2 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000e11'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_ed 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000e12'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_vw 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000e13'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

-- ---------------------------------------------------------------------
-- 1. 새 공간: 만든 사람이 결제 주체
-- ---------------------------------------------------------------------
:as_o
select public.create_workspace('결제 시험', '') as ws \gset
select t.ok(t.billing(:'ws') = :'o' and t.audits(:'ws', 'BILLING_ASSIGNED') = 1, '1.1 만든 사람이 결제 주체, 기록 1건');
:as_admin
update public.subscriptions set plan = 'PRO', status = 'ACTIVE', current_period_start = now(), current_period_end = now() + interval '1 month'
 where account_id = :'o';
insert into public.workspace_members (workspace_id, account_id, role) values
  (:'ws', :'o2', 'OWNER'), (:'ws', :'ed', 'EDITOR'), (:'ws', :'vw', 'VIEWER');
select t.ok(t.billing(:'ws') = :'o' and private.workspace_plan(:'ws') = 'PRO', '1.2 OWNER가 늘어도 결제 주체 그대로, 공간 PRO');

-- ---------------------------------------------------------------------
-- 2. 가져가기·조회 권한
-- ---------------------------------------------------------------------
:as_ed
select t.err(format('select public.claim_workspace_billing(%L)', :'ws'), 'FORBIDDEN', '2.1 EDITOR는 결제 주체가 될 수 없음');
select public.get_workspace_billing(:'ws') as gb \gset
select t.ok(:'gb'::jsonb ->> 'billing_account_id' = :'o' and :'gb'::jsonb ->> 'plan' = 'PRO'
        and :'gb'::jsonb ->> 'billing_name' = '만든 사람' and (:'gb'::jsonb ->> 'is_me')::boolean = false, '2.2 멤버는 결제 주체·공간 요금제를 봄', :'gb');
select t.ok((select count(*) from public.audit_logs) = 0, '2.3 EDITOR는 감사 기록을 못 읽음');
:as_o2
select public.claim_workspace_billing(:'ws') as c1 \gset
select t.ok(:'c1'::jsonb ->> 'plan' = 'FREE' and t.billing(:'ws') = :'o2', '2.4 다른 OWNER가 가져가면 그 사람 요금제(FREE)', :'c1');
select public.claim_workspace_billing(:'ws') as c2 \gset
select t.ok((:'c2'::jsonb ->> 'unchanged')::boolean and t.audits(:'ws', 'BILLING_ASSIGNED') = 2, '2.5 다시 불러도 그대로, 기록 늘지 않음', :'c2');
select t.ok((select count(*) from public.audit_logs where workspace_id = :'ws') = 2, '2.6 OWNER는 감사 기록을 읽음');
select t.err($$insert into public.audit_logs (workspace_id, action) values ('00000000-0000-4000-8000-000000000000', 'BILLING_ASSIGNED')$$,
        '42501', '2.7 화면에서 감사 기록을 직접 쓸 수 없음');

-- ---------------------------------------------------------------------
-- 3. 결제 주체가 나가거나 내려오면 비움 → FREE
-- ---------------------------------------------------------------------
:as_o
select public.claim_workspace_billing(:'ws') as c3 \gset
select t.ok(:'c3'::jsonb ->> 'plan' = 'PRO', '3.1 만든 사람이 다시 가져가면 PRO', :'c3');
select public.leave_workspace(:'ws') as lv \gset
:as_admin
select t.ok(t.billing(:'ws') is null and private.workspace_plan(:'ws') = 'FREE' and t.audits(:'ws', 'BILLING_CLEARED') = 1,
        '3.2 결제 주체가 나가면 비워지고 FREE (남은 OWNER 요금제로 바뀌지 않음)');
select t.ok((select detail ->> 'reason' from public.audit_logs where workspace_id = :'ws' and action = 'BILLING_CLEARED') = 'LEFT', '3.3 해제 사유 LEFT');
:as_o2
select public.claim_workspace_billing(:'ws') as c4 \gset
select t.ok(t.billing(:'ws') = :'o2', '3.4 남은 OWNER가 가져감', :'c4');

-- ---------------------------------------------------------------------
-- 4. 멤버 만료
-- ---------------------------------------------------------------------
:as_ed
select t.err(format('select public.set_member_expiry(%L, %L, now() + interval ''1 day'')', :'ws', :'vw'), 'FORBIDDEN', '4.1 EDITOR는 만료를 정할 수 없음');
:as_o2
select t.err(format('select public.set_member_expiry(%L, %L, now() - interval ''1 minute'')', :'ws', :'vw'), 'INVALID_REQUEST', '4.2 지난 시각은 거절');
select t.err(format('select public.set_member_expiry(%L, %L, now() + interval ''1 day'')', :'ws', :'o2'), 'INVALID_REQUEST', '4.3 OWNER에게는 만료 없음');
select t.err(format('select public.set_member_expiry(%L, %L, now() + interval ''1 day'')', :'ws', :'o'), 'NOT_FOUND', '4.4 나간 멤버는 NOT_FOUND');
select public.set_member_expiry(:'ws', :'vw', now() + interval '1 day') as e1 \gset
select public.set_member_expiry(:'ws', :'ed', now() + interval '1 day') as e2 \gset
:as_admin
select t.ok((select expires_at is not null from public.workspace_members where workspace_id = :'ws' and account_id = :'vw')
        and t.audits(:'ws', 'MEMBER_EXPIRY_SET') = 2, '4.5 만료 지정과 기록');
update public.workspace_members set role = 'OWNER' where workspace_id = :'ws' and account_id = :'ed';
select t.ok((select expires_at is null from public.workspace_members where workspace_id = :'ws' and account_id = :'ed'),
        '4.6 OWNER로 올리면 만료가 지워짐');
select t.ok(private.expire_members() = 0, '4.7 아직 안 지났으면 처리 없음');
update public.workspace_members set expires_at = now() - interval '1 second' where workspace_id = :'ws' and account_id = :'vw';
select last_seq as seq0 from public.workspace_sync_heads where workspace_id = :'ws' \gset
select t.ok(private.expire_members() = 1, '4.8 지난 멤버 1명 처리');
select t.ok((select status = 'REMOVED' and ended_at is not null and expires_at is null
               from public.workspace_members where workspace_id = :'ws' and account_id = :'vw')
        and t.audits(:'ws', 'MEMBER_EXPIRED') = 1, '4.9 만료된 멤버는 REMOVED, 기록 1건');
select t.ok((select count(*) from public.workspace_changes where workspace_id = :'ws' and seq > :seq0
               and entity_table = 'workspace_members' and entity_key = :'vw' and data ->> 'status' = 'REMOVED') = 1,
        '4.10 기기에 내보내기와 같은 멤버 변경 기록이 감');
:as_vw
select t.err(format('select public.get_workspace_billing(%L)', :'ws'), 'FORBIDDEN', '4.11 만료된 사람은 더 이상 공간을 못 봄');

-- ---------------------------------------------------------------------
-- 5. 탈퇴: 결제 주체가 탈퇴하면 비워짐
-- ---------------------------------------------------------------------
:as_admin
select public.account_withdraw_prepare(:'o2') as wd \gset
select t.ok(t.billing(:'ws') is null and private.workspace_plan(:'ws') = 'FREE', '5.1 결제 주체가 탈퇴 준비하면 비워지고 FREE');
select public.account_withdraw_finish(:'o2') as wf \gset
select t.ok((select count(*) from public.audit_logs where workspace_id = :'ws' and actor_id = :'o2') = 0
        and (select count(*) from public.audit_logs where workspace_id = :'ws') > 0, '5.2 탈퇴 뒤 기록은 남고 행위자는 비워짐');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
