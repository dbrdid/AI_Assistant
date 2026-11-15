-- 가짜 결제 (migration 20261114160026_fake_billing + #28 team_plan) 시나리오 테스트 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_billing.sql | grep -E "TOTAL|FAIL"
--   시간은 못 돌리므로, 기간이 끝난 상황은 관리자가 current_period_end를 과거로 옮겨서 만듦
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
    insert into t.results (name, pass, detail)
    values (p_name, sqlerrm like p_code || '%' or sqlstate = p_code, sqlstate || ' ' || sqlerrm);
  end;
end $$;
-- 관리자용: 그 사람의 AI 녹음 한도(분) = 요금제에 따라 60 / 600
create function t.stt_limit(p uuid) returns int language sql security definer as $$
  select (private.stt_minutes_left(p) ->> 'limit_minutes')::int $$;
create function t.payments(p uuid) returns bigint language sql security definer as $$
  select count(*) from public.payments where account_id = p $$;
create function t.ai_limit(p text, e text) returns int language sql security definer as $$
  select private.ai_monthly_limit(p, e) $$;
create function t.invite_limit(p uuid) returns int language sql security definer as $$
  select (private.project_invite_quota(p) ->> 'limit')::int $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set u1 '00000000-0000-4000-8000-0000000000b1'
\set u2 '00000000-0000-4000-8000-0000000000b2'
\set u3 '00000000-0000-4000-8000-0000000000b3'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'u1', 'pay1@test.dev', '{"name":"Pay1"}'),
  (:'u2', 'pay2@test.dev', '{"name":"Pay2"}'),
  (:'u3', 'team@test.dev', '{"name":"Team"}');

\set as_u1   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000b1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_u2   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000b2'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_u3   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000b3'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_svc  'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_anon 'reset role; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', false); set role anon;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

-- ---------------------------------------------------------------------
-- 1. 처음: FREE
-- ---------------------------------------------------------------------
:as_u1
select public.get_my_subscription() as s0 \gset
select t.ok(:'s0'::jsonb ->> 'plan' = 'FREE' and :'s0'::jsonb ->> 'state' = 'FREE'
        and (:'s0'::jsonb -> 'next_payment_at') = 'null'::jsonb
        and (:'s0'::jsonb -> 'price_krw' ->> 'PRO')::int = 4900, '1.1 가입 직후 FREE, 다음 결제일 없음, PRO 가격 4,900원', :'s0');
select t.ok(t.stt_limit(:'u1') = 60, '1.2 FREE 한도 (녹음 60분)');
select t.err($$select public.subscription_cancel()$$, 'NOT_SUBSCRIBED', '1.3 FREE에서 해지 → NOT_SUBSCRIBED');

-- ---------------------------------------------------------------------
-- 2. 입력 확인
-- ---------------------------------------------------------------------
select t.err($$select public.subscription_checkout('ENTERPRISE', gen_random_uuid())$$, 'INVALID_REQUEST', '2.1 없는 요금제(ENTERPRISE) → INVALID_REQUEST');
select t.err($$select public.subscription_checkout('FREE', gen_random_uuid())$$, 'INVALID_REQUEST', '2.2 FREE 결제 → INVALID_REQUEST (해지를 쓰기)');
select t.err($$select public.subscription_checkout('GOLD', gen_random_uuid())$$, 'INVALID_REQUEST', '2.3 없는 요금제 → INVALID_REQUEST');
select t.err($$select public.subscription_checkout('PRO', null)$$, 'INVALID_REQUEST', '2.4 요청 id 없음 → INVALID_REQUEST');
select t.err($$select public.subscription_checkout('PRO', gen_random_uuid(), 'HACK')$$, 'INVALID_REQUEST', '2.5 시연 옵션은 DECLINE만');
:as_anon
select t.err($$select public.subscription_checkout('PRO', gen_random_uuid())$$, '42501', '2.6 비로그인 → 실행 권한 없음');
select t.err($$select public.get_my_subscription()$$, '42501', '2.7 비로그인 조회 → 실행 권한 없음');

-- ---------------------------------------------------------------------
-- 3. 결제 실패 시연 (DECLINE)
-- ---------------------------------------------------------------------
\set rd '00000000-0000-4000-8000-0000000d0001'
:as_u1
select public.subscription_checkout('pro', :'rd', 'DECLINE') as d1 \gset
select t.ok(:'d1'::jsonb ->> 'ok' = 'false' and :'d1'::jsonb ->> 'code' = 'PAYMENT_DECLINED'
        and :'d1'::jsonb -> 'subscription' ->> 'plan' = 'FREE', '3.1 결제 실패 → ok:false PAYMENT_DECLINED, 요금제 FREE 그대로', :'d1');
select t.ok((select status = 'FAILED' and failure_code = 'PAYMENT_DECLINED' and period_start is null
             from public.payments where account_id = :'u1'), '3.2 실패 기록이 남고 본인이 조회 가능');
select public.subscription_checkout('PRO', :'rd', 'DECLINE') as d2 \gset
select t.ok((:'d2'::jsonb ->> 'replayed')::boolean and :'d2'::jsonb ->> 'code' = 'PAYMENT_DECLINED' and t.payments(:'u1') = 1,
        '3.3 같은 요청 재시도 → 처음 결과, 기록 1건 그대로', :'d2');
select t.ok(t.stt_limit(:'u1') = 60, '3.4 실패 뒤 한도는 FREE 그대로');

-- ---------------------------------------------------------------------
-- 4. 구독 (FREE → PRO)
-- ---------------------------------------------------------------------
\set r1 '00000000-0000-4000-8000-0000000d0002'
select public.subscription_checkout('PRO', :'r1') as c1 \gset
select t.ok(:'c1'::jsonb ->> 'ok' = 'true' and :'c1'::jsonb ->> 'action' = 'SUBSCRIBED'
        and :'c1'::jsonb -> 'payment' ->> 'status' = 'PAID' and (:'c1'::jsonb -> 'payment' ->> 'amount_krw')::int = 4900,
        '4.1 PRO 결제 → SUBSCRIBED, 4,900원 PAID', :'c1');
select t.ok((select plan = 'PRO' and status = 'ACTIVE' and not cancel_at_period_end
               and current_period_end = current_period_start + interval '1 month'
               and current_period_start between now() - interval '1 minute' and now() + interval '1 minute'
               and payment_ref like 'fake\_%'
             from public.subscriptions where account_id = :'u1'), '4.2 지금부터 1개월 PRO, 가짜 결제 참조값');
select t.ok(t.stt_limit(:'u1') = 600, '4.3 PRO 한도로 바로 바뀜 (녹음 600분, 기존 한도 함수 그대로)');
select public.get_my_subscription() as s1 \gset
select t.ok(:'s1'::jsonb ->> 'state' = 'ACTIVE' and (:'s1'::jsonb ->> 'next_payment_at')::timestamptz = (:'c1'::jsonb -> 'payment' ->> 'period_end')::timestamptz
        and (:'s1'::jsonb ->> 'next_payment_krw')::int = 4900, '4.4 화면: 다음 결제일 = 기간 끝, 다음 결제 4,900원', :'s1');
select public.subscription_checkout('PRO', :'r1') as c2 \gset
select t.ok((:'c2'::jsonb ->> 'replayed')::boolean and :'c2'::jsonb ->> 'action' = 'SUBSCRIBED' and t.payments(:'u1') = 2,
        '4.5 결제 버튼 두 번(같은 요청) → 한 번만 결제', :'c2');
select public.subscription_checkout('PRO', gen_random_uuid()) as c3 \gset
select t.ok(:'c3'::jsonb ->> 'action' = 'ALREADY_ACTIVE' and t.payments(:'u1') = 2, '4.6 이미 PRO인데 다시 결제 → ALREADY_ACTIVE, 결제 없음', :'c3');
select t.ok((select count(*) from public.payments) = 2, '4.7 결제 내역은 본인 것만 보임 (RLS)');

-- ---------------------------------------------------------------------
-- 5. 해지 예약 → 해지 취소
-- ---------------------------------------------------------------------
select public.subscription_cancel() as x1 \gset
select t.ok(:'x1'::jsonb -> 'subscription' ->> 'state' = 'CANCELING' and :'x1'::jsonb -> 'subscription' ->> 'plan' = 'PRO'
        and (:'x1'::jsonb -> 'subscription' -> 'next_payment_at') = 'null'::jsonb
        and (:'x1'::jsonb -> 'subscription' ->> 'current_period_end') is not null,
        '5.1 해지 → CANCELING, 기간 끝까지 PRO, 다음 결제 없음', :'x1');
select t.ok(t.stt_limit(:'u1') = 600, '5.2 해지 예약 중에도 PRO 한도');
select public.subscription_cancel() as x2 \gset
select t.ok((:'x2'::jsonb ->> 'unchanged')::boolean, '5.3 해지 두 번 → unchanged', :'x2');
select public.subscription_checkout('PRO', gen_random_uuid()) as c4 \gset
select t.ok(:'c4'::jsonb ->> 'action' = 'RESUMED' and :'c4'::jsonb -> 'subscription' ->> 'state' = 'ACTIVE' and t.payments(:'u1') = 2,
        '5.4 해지 예약 중 PRO 선택 → 결제 없이 해지 취소(RESUMED)', :'c4');

-- ---------------------------------------------------------------------
-- 6. 기간 끝: 해지 예약이면 FREE
-- ---------------------------------------------------------------------
select public.subscription_cancel() as x3 \gset
:as_admin
update public.subscriptions set current_period_start = now() - interval '1 month', current_period_end = now() - interval '1 second'
 where account_id = :'u1';
select t.ok(private.subscription_tick() = 1, '6.1 매분 cron이 기간 끝난 구독 1건 처리');
select t.ok((select plan = 'FREE' and status = 'ACTIVE' and current_period_end is null and not cancel_at_period_end
             from public.subscriptions where account_id = :'u1'), '6.2 해지 예약 → 기간이 끝나면 FREE');
select t.ok(t.stt_limit(:'u1') = 60 and t.payments(:'u1') = 2, '6.3 FREE 한도로 돌아오고 결제 없음');
select t.ok(private.subscription_tick() = 0, '6.4 처리할 것이 없으면 0');

-- ---------------------------------------------------------------------
-- 7. 기간 끝: 해지 안 했으면 가짜 자동 결제로 연장
-- ---------------------------------------------------------------------
:as_u1
select public.subscription_checkout('PRO', gen_random_uuid()) as c5 \gset
select t.ok(:'c5'::jsonb ->> 'action' = 'SUBSCRIBED' and t.payments(:'u1') = 3, '7.1 FREE로 돌아간 뒤 다시 구독 → 새 결제', :'c5');
:as_admin
update public.subscriptions set current_period_start = now() - interval '1 month' - interval '1 hour', current_period_end = now() - interval '1 hour'
 where account_id = :'u1';
select current_period_end as old_end from public.subscriptions where account_id = :'u1' \gset
:as_u1
select public.get_my_subscription() as s2 \gset
:as_admin
select t.ok(:'s2'::jsonb ->> 'state' = 'ACTIVE'
        and (:'s2'::jsonb ->> 'current_period_start')::timestamptz = :'old_end'::timestamptz
        and (:'s2'::jsonb ->> 'current_period_end')::timestamptz = :'old_end'::timestamptz + interval '1 month',
        '7.2 조회할 때 기간이 지났으면 먼저 연장 (이전 끝 → +1개월, 빈틈 없음)', :'s2');
select t.ok((select kind = 'RENEWAL' and status = 'PAID' and amount_krw = 4900 and period_start = :'old_end'::timestamptz
             from public.payments where account_id = :'u1' order by created_at desc, kind desc limit 1)
        and t.payments(:'u1') = 4, '7.3 자동 결제 기록(RENEWAL) 1건');
-- 오래 멈춰 있던 경우 (40개월): 36번까지 따라잡고 그 뒤는 오늘부터
update public.subscriptions set current_period_start = now() - interval '41 months', current_period_end = now() - interval '40 months'
 where account_id = :'u1';
select private.subscription_tick() as n7 \gset
select t.ok(t.payments(:'u1') = 4 + 36 + 0
        and (select current_period_end > now() and current_period_end <= now() + interval '1 month' + interval '1 minute'
             from public.subscriptions where account_id = :'u1'), '7.4 오래 밀린 기간은 최대 36번 연장 후 오늘부터 새 기간');

-- ---------------------------------------------------------------------
-- 8. 권한 · 데이터 모양
-- ---------------------------------------------------------------------
:as_u2
select t.ok((select count(*) from public.payments) = 0, '8.1 다른 사람 결제 내역은 안 보임');
select t.ok((select count(*) from public.subscriptions where account_id = :'u1') = 0, '8.2 다른 사람 구독도 안 보임');
select t.err($$update public.subscriptions set plan = 'PRO' where account_id = '00000000-0000-4000-8000-0000000000b2'$$, '42501', '8.3 앱에서 구독 직접 수정 불가');
select t.err($$insert into public.payments (account_id, kind, plan, amount_krw, status, period_start, period_end, payment_ref)
               values ('00000000-0000-4000-8000-0000000000b2', 'CHECKOUT', 'PRO', 0, 'PAID', now(), now() + interval '1 month', 'x')$$,
        '42501', '8.4 앱에서 결제 기록 직접 추가 불가');
select t.err($$select private.subscription_tick()$$, '42501', '8.5 정리 함수는 앱에서 못 부름');
select t.err($$select private.subscription_settle('00000000-0000-4000-8000-0000000000b2')$$, '42501', '8.6 정산 함수도 앱에서 못 부름');
select public.subscription_checkout('PRO', '00000000-0000-4000-8000-0000000d0002') as c6 \gset
select t.ok(:'c6'::jsonb ->> 'action' = 'SUBSCRIBED' and not ((:'c6'::jsonb ->> 'replayed') is not null),
        '8.7 요청 id는 사람마다 따로 (다른 사람이 같은 id를 써도 새 결제)', :'c6');
:as_admin
select t.err($$update public.subscriptions set plan = 'FREE' where account_id = '00000000-0000-4000-8000-0000000000b2'$$,
        '23514', '8.8 FREE인데 기간이 남은 모양은 DB가 거절');
select t.err($$update public.subscriptions set current_period_end = current_period_start where account_id = '00000000-0000-4000-8000-0000000000b2'$$,
        '23514', '8.9 PRO 기간이 0이면 거절');
select t.ok((select schedule = '* * * * *' from cron.job where jobname = 'subscription-tick'), '8.10 cron 등록 (매분)');
select t.ok((select count(*) = 0 from public.payments p where p.status = 'PAID' and p.period_end <= p.period_start), '8.11 결제 기록 기간 모양 정상');

-- ---------------------------------------------------------------------
-- 9. Team 요금제 (#28): 9,900원, AI 한도 = PRO, 초대 200회, 공간 첨부 10GB·백업 1GB
-- ---------------------------------------------------------------------
\set h1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
:as_u3
select public.create_workspace('Team 공간') as tws \gset
:as_u2
select public.create_workspace('Pro 공간') as pws \gset
select (public.create_invite(:'pws', 'EDITOR', 24, 1)) ->> 'code' as pcode \gset
:as_u3
select public.accept_invite(:'pcode') \gset
select t.ok(private_free.ok, '9.0 시작: FREE (초대 10회)') from (select t.invite_limit(:'u3') = 10 as ok) private_free;
select public.subscription_checkout('team', '00000000-0000-4000-8000-0000000d0901') as k1 \gset
select t.ok(:'k1'::jsonb ->> 'action' = 'SUBSCRIBED' and :'k1'::jsonb -> 'payment' ->> 'plan' = 'TEAM'
        and (:'k1'::jsonb -> 'payment' ->> 'amount_krw')::int = 9900 and :'k1'::jsonb -> 'subscription' ->> 'plan' = 'TEAM'
        and (:'k1'::jsonb -> 'subscription' ->> 'next_payment_krw')::int = 9900,
        '9.1 FREE → TEAM 결제 → SUBSCRIBED, 9,900원 PAID, 다음 결제 9,900원', :'k1');
select t.ok(t.stt_limit(:'u3') = 600 and t.ai_limit('TEAM', 'query') = 500 and t.ai_limit('TEAM', 'organize') = 1000,
        '9.2 TEAM AI 한도 = PRO (녹음 600분, 질문 500, 정리 1000)');
select t.ok(t.invite_limit(:'u3') = 200, '9.3 TEAM 이번 달 프로젝트 초대 200회');
select t.ok((:'k1'::jsonb -> 'subscription' -> 'price_krw' ->> 'TEAM')::int = 9900
        and (:'k1'::jsonb -> 'subscription' -> 'plans' -> 'TEAM' ->> 'workspace_storage_bytes')::bigint = 10737418240
        and (:'k1'::jsonb -> 'subscription' -> 'plans' -> 'PRO' ->> 'project_invites_per_month')::int = 50
        and (:'k1'::jsonb -> 'subscription' -> 'plans' -> 'FREE' -> 'ai' ->> 'query')::int = 50,
        '9.4 화면용 요금제 표(plans): 가격·초대·용량·AI 한도');
select public.subscription_checkout('TEAM', gen_random_uuid()) as k2 \gset
select t.ok(:'k2'::jsonb ->> 'action' = 'ALREADY_ACTIVE' and t.payments(:'u3') = 1, '9.5 이미 TEAM → ALREADY_ACTIVE, 결제 없음', :'k2');

-- 공간 용량: 공간 관리자 중 가장 높은 요금제
:as_admin
select t.ok(private.workspace_plan(:'tws') = 'TEAM' and private.workspace_plan(:'pws') = 'PRO',
        '9.6 공간 요금제 = 관리자의 요금제 (u3 공간 TEAM, u2(8.7에서 PRO) 공간 PRO: u3는 EDITOR일 뿐)');
update public.workspace_members set role = 'OWNER' where workspace_id = :'pws' and account_id = :'u3';
select t.ok(private.workspace_plan(:'pws') = 'TEAM', '9.7 관리자가 둘이면 높은 쪽 (u2 PRO + u3 TEAM → TEAM)');
update public.workspace_members set role = 'EDITOR' where workspace_id = :'pws' and account_id = :'u3';
:as_svc
select public.asset_prepare(:'u3', '00000000-0000-4000-8000-00000000f901', 'ATTACHMENT', :'tws', null, 'audio/mp4', 52428800, :'h1') \gset
:as_admin
update public.assets set declared_size_bytes = 10737418240 - 52428800 - 1048576 where id = '00000000-0000-4000-8000-00000000f901';
:as_svc
select t.ok((public.asset_prepare(:'u3', gen_random_uuid(), 'ATTACHMENT', :'tws', null, 'audio/mp4', 52428800, :'h1')) ->> 'status' = 'PENDING',
        '9.8 TEAM 공간: 9.9GB 쓴 뒤에도 50MB 더 올림 (FREE면 500MB에서 막힘)');
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''ATTACHMENT'', %L, null, ''audio/mp4'', 52428800, %L)', :'u3', :'tws', :'h1'),
        'QUOTA_EXCEEDED: 이 공간의 첨부 용량(10GB)', '9.9 TEAM 공간도 10GB 넘으면 거절 (문구에 10GB)');
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''ATTACHMENT'', %L, null, ''audio/mp4'', 52428800, %L)', :'u2', :'pws', :'h1'),
        'no error', '9.10 (자리) PRO 공간 첫 50MB는 됨');
:as_admin
update t.results set pass = detail = 'no error', name = '9.10 PRO 공간 첫 50MB는 됨' where name = '9.10 (자리) PRO 공간 첫 50MB는 됨';
update public.assets set declared_size_bytes = 2147483648 - 1048576 where workspace_id = :'pws';
:as_svc
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''ATTACHMENT'', %L, null, ''audio/mp4'', 52428800, %L)', :'u3', :'pws', :'h1'),
        'QUOTA_EXCEEDED: 이 공간의 첨부 용량(2GB)', '9.11 PRO 공간은 2GB: TEAM인 u3(EDITOR)가 올려도 공간 관리자 요금제 기준 (FREE 500MB는 test_assets 4.1)');
select public.asset_prepare(:'u3', '00000000-0000-4000-8000-00000000f9b1', 'BACKUP', null, null, 'application/octet-stream', 52428800, :'h1') \gset
:as_admin
update public.assets set declared_size_bytes = 1073741824 - 52428800 - 1048576 where id = '00000000-0000-4000-8000-00000000f9b1';
:as_svc
select t.ok((public.asset_prepare(:'u3', gen_random_uuid(), 'BACKUP', null, null, 'application/octet-stream', 52428800, :'h1')) ->> 'status' = 'PENDING',
        '9.12 TEAM 백업: 1GB 직전까지 올림 (FREE는 200MB)');
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''BACKUP'', null, null, ''application/octet-stream'', 52428800, %L)', :'u3', :'h1'),
        'QUOTA_EXCEEDED: 백업 용량(1GB)', '9.13 백업 1GB 넘으면 거절 (문구에 1GB)');

-- TEAM ↔ PRO 바꾸기
:as_u3
select public.subscription_checkout('PRO', '00000000-0000-4000-8000-0000000d0902') as k3 \gset
select t.ok(:'k3'::jsonb ->> 'action' = 'CHANGED' and :'k3'::jsonb ->> 'previous_plan' = 'TEAM'
        and :'k3'::jsonb -> 'payment' ->> 'plan' = 'PRO' and (:'k3'::jsonb -> 'payment' ->> 'amount_krw')::int = 4900
        and :'k3'::jsonb -> 'subscription' ->> 'plan' = 'PRO' and t.payments(:'u3') = 2,
        '9.14 TEAM → PRO: 바로 바뀜(CHANGED), 4,900원 새 결제', :'k3');
select t.ok(t.invite_limit(:'u3') = 50 and t.stt_limit(:'u3') = 600, '9.15 PRO로 내리면 초대 50회, AI 한도는 그대로');
:as_admin
select t.ok(private.workspace_plan(:'tws') = 'PRO', '9.16 공간 요금제도 PRO로 (용량 2GB)');
:as_u3
select public.subscription_checkout('TEAM', '00000000-0000-4000-8000-0000000d0903', 'DECLINE') as k4 \gset
select t.ok(:'k4'::jsonb ->> 'code' = 'PAYMENT_DECLINED' and :'k4'::jsonb -> 'payment' ->> 'plan' = 'TEAM'
        and (:'k4'::jsonb -> 'payment' ->> 'amount_krw')::int = 9900 and :'k4'::jsonb -> 'subscription' ->> 'plan' = 'PRO',
        '9.17 PRO → TEAM 결제 실패 시연 → PRO 그대로', :'k4');
select public.subscription_checkout('TEAM', '00000000-0000-4000-8000-0000000d0904') as k5 \gset
select public.subscription_checkout('TEAM', '00000000-0000-4000-8000-0000000d0904') as k6 \gset
select t.ok(:'k5'::jsonb ->> 'action' = 'CHANGED' and (:'k6'::jsonb ->> 'replayed')::boolean and t.payments(:'u3') = 4,
        '9.18 PRO → TEAM: CHANGED, 같은 요청 재시도는 한 번만 결제', :'k6');

-- 해지·해지 취소·다른 요금제 선택·자동 결제
select public.subscription_cancel() as k7 \gset
select t.ok(:'k7'::jsonb -> 'subscription' ->> 'state' = 'CANCELING' and :'k7'::jsonb -> 'subscription' ->> 'plan' = 'TEAM'
        and t.invite_limit(:'u3') = 200, '9.19 TEAM 해지 → 기간 끝까지 TEAM (초대 200회 유지)', :'k7');
select public.subscription_checkout('TEAM', gen_random_uuid()) as k8 \gset
select t.ok(:'k8'::jsonb ->> 'action' = 'RESUMED' and t.payments(:'u3') = 4, '9.20 해지 예약 중 TEAM 다시 선택 → 결제 없이 해지 취소', :'k8');
select public.subscription_cancel() \gset
select public.subscription_checkout('PRO', gen_random_uuid()) as k9 \gset
select t.ok(:'k9'::jsonb ->> 'action' = 'CHANGED' and :'k9'::jsonb -> 'subscription' ->> 'state' = 'ACTIVE'
        and not (:'k9'::jsonb -> 'subscription' ->> 'cancel_at_period_end')::boolean and t.payments(:'u3') = 5,
        '9.21 TEAM 해지 예약 중 PRO 선택 → 해지 취소하고 PRO로 바꿈(새 결제)', :'k9');
select public.subscription_checkout('TEAM', gen_random_uuid()) \gset
:as_admin
update public.subscriptions set current_period_start = now() - interval '1 month' - interval '1 hour', current_period_end = now() - interval '1 hour'
 where account_id = :'u3';
select private.subscription_tick() as n9 \gset
select t.ok(:n9 = 1
        and (select kind = 'RENEWAL' and plan = 'TEAM' and amount_krw = 9900 from public.payments
              where account_id = :'u3' order by created_at desc, kind desc limit 1)
        and (select plan = 'TEAM' and current_period_end > now() from public.subscriptions where account_id = :'u3'),
        '9.22 TEAM 기간 끝 → 자동 결제(RENEWAL) 9,900원으로 연장');
update public.subscriptions set cancel_at_period_end = true, canceled_at = now(),
       current_period_start = now() - interval '1 month' - interval '1 hour', current_period_end = now() - interval '1 hour'
 where account_id = :'u3';
select private.subscription_tick() \gset
select t.ok((select plan = 'FREE' from public.subscriptions where account_id = :'u3') and t.invite_limit(:'u3') = 10
        and private.workspace_plan(:'tws') = 'FREE' and t.stt_limit(:'u3') = 60,
        '9.23 TEAM 해지 후 기간 끝 → FREE (초대 10회, 공간 FREE, 녹음 60분). 올린 파일은 그대로');
select t.ok((select count(*) from public.assets where workspace_id = :'tws' and status = 'PENDING') = 2,
        '9.24 요금제를 내려도 이미 올린 첨부는 지우지 않음');
select t.err($$update public.payments set plan = 'GOLD' where false$$, 'no error', '9.25 (자리)');
delete from t.results where name = '9.25 (자리)';
select t.err($$insert into public.payments (account_id, kind, plan, amount_krw, status, failure_code, payment_ref)
               values ('00000000-0000-4000-8000-0000000000b3', 'CHECKOUT', 'GOLD', 1, 'FAILED', 'X', 'fake_gold')$$,
        '23514', '9.25 결제 기록 요금제는 PRO·TEAM만');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
