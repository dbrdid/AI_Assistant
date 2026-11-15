-- 푸시 알림 · 브리핑 (#34) (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_push.sql | grep -E "TOTAL|FAIL"
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
create function t.push(p_ws uuid, p_ops jsonb) returns jsonb
language plpgsql as $$
begin
  return public.sync_push(p_ws, gen_random_uuid(), p_ops);
exception when others then
  return jsonb_build_object('error', sqlstate, 'msg', sqlerrm);
end $$;
create function t.op(p_entity text, p_op text, p_id uuid, p_base bigint, p_data jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select jsonb_build_object('entity', p_entity, 'op', p_op, 'id', p_id, 'data', p_data)
         || case when p_base is null then '{}'::jsonb else jsonb_build_object('base_revision', p_base) end
$$;
create function t.nc(p_account uuid, p_kind text) returns bigint language sql security definer as $$
  select count(*) from public.notifications where account_id = p_account and kind = p_kind $$;
create function t.device(p_account uuid, p_inst text) returns uuid language sql security definer as $$
  insert into public.devices (account_id, installation_id, platform, app_version) values (p_account, p_inst, 'ios', '1.0') returning id $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set own '00000000-0000-4000-8000-000000000b10'
\set a   '00000000-0000-4000-8000-000000000b11'
\set b   '00000000-0000-4000-8000-000000000b12'
\set v   '00000000-0000-4000-8000-000000000b13'
\set nw  '00000000-0000-4000-8000-000000000b14'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', 'po@test.dev', '{"name":"관리자"}'),
  (:'a',   'pa@test.dev', '{"name":"팀원A"}'),
  (:'b',   'pb@test.dev', '{"name":"멤버B"}'),
  (:'v',   'pv@test.dev', '{"name":"보기V"}'),
  (:'nw',  'pn@test.dev', '{"name":"새사람"}');

\set as_own 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000b10'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_a   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000b11'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_b   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000b12'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_v   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000b13'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_nw  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000b14'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_svc 'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

\set p1 '00000000-0000-4000-8000-00000000b001'
\set k1 '00000000-0000-4000-8000-00000000b021'
\set k2 '00000000-0000-4000-8000-00000000b022'
\set k3 '00000000-0000-4000-8000-00000000b023'
\set e1 '00000000-0000-4000-8000-00000000b031'
\set k4 '00000000-0000-4000-8000-00000000b024'
\set k5 '00000000-0000-4000-8000-00000000b025'
\set pmx '00000000-0000-4000-8000-00000000b041'
\set tok1 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'
\set tok2 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]'

:as_own
select public.create_workspace('알림 공간') as ws \gset
select (public.create_invite(:'ws', 'EDITOR', 24, 2)) ->> 'code' as c_ed \gset
select (public.create_invite(:'ws', 'VIEWER', 24, 1)) ->> 'code' as c_vw \gset
:as_a
select public.accept_invite(:'c_ed') is not null as x \gset
:as_b
select public.accept_invite(:'c_ed') is not null as x \gset
:as_v
select public.accept_invite(:'c_vw') is not null as x \gset
:as_admin
select t.device(:'own', 'i-own') as d_own \gset
select t.device(:'a', 'i-a') as d_a \gset
select t.device(:'b', 'i-b') as d_b \gset

-- ---------------------------------------------------------------------
-- 1. 기기 알림 토큰
-- ---------------------------------------------------------------------
:as_own
select t.err(format('select public.set_push_token(%L, %L)', :'d_own', 'not-a-token'), 'INVALID_REQUEST', '1.1 Expo 토큰 형식이 아니면 거절');
select t.err(format('select public.set_push_token(%L, %L)', :'d_a', :'tok1'), 'NOT_FOUND', '1.2 남의 기기에는 못 넣음');
select public.set_push_token(:'d_own', :'tok1') ->> 'enabled' as x \gset
:as_admin
select t.ok((select push_token = :'tok1' and push_provider = 'EXPO' from public.devices where id = :'d_own'), '1.3 내 기기에 토큰 저장 (EXPO)');
-- 같은 휴대폰에 A가 로그인: 같은 토큰 → 관리자 기기에서 빠짐
:as_a
select public.set_push_token(:'d_a', :'tok1') ->> 'enabled' as x \gset
:as_admin
select t.ok((select push_token is null and push_provider is null from public.devices where id = :'d_own')
  and (select push_token = :'tok1' from public.devices where id = :'d_a'), '1.4 같은 토큰을 다른 계정이 쓰면 예전 계정에서 뺌');
:as_own
select public.set_push_token(:'d_own', :'tok2') ->> 'enabled' as x \gset
select public.set_push_token(:'d_own', null) ->> 'enabled' as off \gset
select t.ok(not :'off'::boolean, '1.5 null이면 끄기');
select public.set_push_token(:'d_own', :'tok2') ->> 'enabled' as x \gset

-- ---------------------------------------------------------------------
-- 2. 알림 설정
-- ---------------------------------------------------------------------
:as_b
select public.get_notification_settings() as s0 \gset
select t.ok((:'s0'::jsonb ->> 'push')::boolean and (:'s0'::jsonb -> 'briefing_daily' ->> 'on') = 'false'
  and :'s0'::jsonb -> 'briefing_weekly' ->> 'day' = '1', '2.1 기본: 알림 켜짐, 브리핑 꺼짐(주간 월요일)', :'s0');
select t.ok(:'s0'::jsonb -> 'briefing_daily' ->> 'time' = '09:00' and :'s0'::jsonb -> 'briefing_weekly' ->> 'time' = '09:00',
  '2.1a 기본 시각: 일간 09:00 · 주간 09:00 (#37)', :'s0');
select public.set_notification_settings('{"reminders": false, "briefing_daily": {"on": true, "time": "07:30"}}') as s1 \gset
select t.ok(not (:'s1'::jsonb ->> 'reminders')::boolean and :'s1'::jsonb -> 'briefing_daily' = '{"on": true, "time": "07:30"}'
  and (:'s1'::jsonb ->> 'workspace')::boolean, '2.2 바꾼 항목만 저장, 나머지는 그대로', :'s1');
select t.err($$select public.set_notification_settings('{"briefing_daily": {"time": "25:00"}}')$$, 'INVALID_REQUEST', '2.3 시각 형식 검사');
select t.err($$select public.set_notification_settings('{"briefing_weekly": {"day": 7}}')$$, 'INVALID_REQUEST', '2.4 요일 0~6');
select t.err($$select public.set_notification_settings('{"briefing_daily": {"day": 1}}')$$, 'INVALID_REQUEST', '2.5 일간 브리핑에는 요일 없음');
select t.err($$select public.set_notification_settings('{"sound": true}')$$, 'INVALID_REQUEST', '2.6 모르는 설정 거절');
select t.err($$select public.set_notification_settings('{"push": "yes"}')$$, 'INVALID_REQUEST', '2.7 켜기·끄기는 true/false');
:as_admin
update public.user_settings set preferences = preferences || '{"theme": "dark"}' where account_id = :'b';
:as_b
select public.set_notification_settings('{"recording": false}') ->> 'recording' as x \gset
:as_admin
select t.ok((select preferences ->> 'theme' = 'dark' and preferences -> 'notifications' ->> 'recording' = 'false'
               and preferences -> 'notifications' ->> 'reminders' = 'false' from public.user_settings where account_id = :'b'),
  '2.8 다른 설정(preferences)은 지우지 않음');
:as_b
select public.set_notification_settings('{"recording": true}') ->> 'recording' as x \gset

-- ---------------------------------------------------------------------
-- 3. 공유 기록 마감·시작 알림
-- ---------------------------------------------------------------------
:as_own
select t.push(:'ws', jsonb_build_array(
  t.op('projects', 'UPSERT', :'p1', null, '{"name":"발표"}'),
  t.op('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'account_id', :'a', 'name', '팀원A', 'role', '팀장')),
  t.op('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', '계정 없는 협력자')),
  t.op('project_members', 'UPSERT', :'pmx', null, jsonb_build_object('project_id', :'p1', 'account_id', :'v', 'name', '빠진 팀원')),
  t.op('tasks', 'UPSERT', :'k1', null, jsonb_build_object('title', '슬라이드 마감', 'project_id', :'p1',
        'due_at', now() + interval '30 minutes', 'reminder_minutes', 30)),
  t.op('tasks', 'UPSERT', :'k2', null, jsonb_build_object('title', '공용 할 일', 'due_at', now() + interval '60 minutes', 'reminder_minutes', 60)),
  t.op('tasks', 'UPSERT', :'k3', null, jsonb_build_object('title', '끝난 일', 'status', 'DONE', 'due_at', now() + interval '10 minutes', 'reminder_minutes', 10)),
  t.op('tasks', 'UPSERT', :'k4', null, jsonb_build_object('title', '취소한 일', 'status', 'CANCELED', 'due_at', now() + interval '10 minutes', 'reminder_minutes', 10)),
  t.op('tasks', 'UPSERT', :'k5', null, jsonb_build_object('title', '20분 전에 알렸어야 할 일', 'due_at', now() + interval '10 minutes', 'reminder_minutes', 30)),
  t.op('events', 'UPSERT', :'e1', null, jsonb_build_object('title', '리허설', 'start_at', now() + interval '2 hours',
        'end_at', now() + interval '3 hours', 'reminder_minutes', 120)))) ->> 'status' as st \gset
select t.ok(:'st' = 'ACCEPTED', '3.0 준비', :'st');
select t.push(:'ws', jsonb_build_array(t.op('project_members', 'DELETE', :'pmx', 1))) ->> 'status' as x \gset
:as_admin
select private.enqueue_reminders() as n1 \gset
select t.ok(t.nc(:'a', 'TASK_REMINDER') = 2 and t.nc(:'own', 'TASK_REMINDER') = 1 and t.nc(:'v', 'TASK_REMINDER') = 1,
  '3.1 프로젝트 할 일 → 계정 연결된 팀원만(A), 프로젝트 없는 할 일 → 공간 전체', :'n1');
select t.ok(t.nc(:'b', 'TASK_REMINDER') = 0, '3.2 마감 알림을 끈 B는 안 받음');
select t.ok(not exists (select 1 from public.notifications where ref_id in (:'k3', :'k4')), '3.3 끝난·취소한 할 일은 알리지 않음');
select t.ok(not exists (select 1 from public.notifications where ref_id = :'k5'), '3.3b 알릴 시각이 이미 10분 넘게 지난 새 할 일은 안 보냄');
select t.ok(not exists (select 1 from public.notifications where ref_id = :'k1' and account_id = :'v'), '3.3c 휴지통에 간 팀원 칸의 계정은 팀원 아님');
select t.ok((select body = '알림 공간 · 30분 뒤 마감이에요' and title = '슬라이드 마감' and data ->> 'type' = 'tasks' and data ->> 'id' = :'k1'
               from public.notifications where account_id = :'a' and ref_id = :'k1'), '3.4 문구·이동할 곳(data)');
select t.ok(t.nc(:'own', 'EVENT_REMINDER') = 1 and (select body like '%2시간 뒤 시작해요' from public.notifications where account_id = :'own' and ref_id = :'e1'),
  '3.5 일정 시작 2시간 전');
select private.enqueue_reminders() as n2 \gset
select t.ok(:n2 = 0, '3.6 다시 돌려도 같은 알림은 한 번만', :'n2');
select t.ok(private.enqueue_reminders(now() + interval '20 minutes') = 0, '3.7 알릴 시각이 10분 넘게 지난 것은 안 보냄');
-- 마감 시각을 바꾸면 새로 알림
:as_own
select t.push(:'ws', jsonb_build_array(t.op('tasks', 'UPSERT', :'k1', 1, jsonb_build_object('due_at', now() + interval '31 minutes')))) ->> 'status' as x \gset
:as_admin
select private.enqueue_reminders(now() + interval '1 minute') as n3 \gset
select t.ok(t.nc(:'a', 'TASK_REMINDER') = 3, '3.8 마감 시각을 바꾸면 그 시각으로 다시 알림', :'n3');
-- 휴지통에 간 것은 안 보냄
:as_own
select t.push(:'ws', jsonb_build_array(t.op('events', 'DELETE', :'e1', 1))) ->> 'status' as x \gset
:as_admin
delete from public.notifications where ref_id = :'e1';
select t.ok(private.enqueue_reminders() = 0 and not exists (select 1 from public.notifications where ref_id = :'e1'), '3.9 휴지통에 있는 일정은 알리지 않음');
-- 프로젝트 마감일: 그날 09:00(서울) 기준
:as_own
select t.push(:'ws', jsonb_build_array(t.op('projects', 'UPSERT', :'p1', 1,
  jsonb_build_object('due_date', '2026-12-01', 'reminder_minutes', 1440)))) ->> 'status' as x \gset
:as_admin
select private.enqueue_reminders('2026-11-30 09:01:00+09') as n4 \gset
select t.ok(t.nc(:'a', 'PROJECT_REMINDER') = 1 and t.nc(:'own', 'PROJECT_REMINDER') = 0
  and (select body = '알림 공간 · 프로젝트 마감 1일 뒤이에요' from public.notifications where kind = 'PROJECT_REMINDER'),
  '3.10 프로젝트 마감 하루 전 09:00 → 팀원에게', :'n4');

-- ---------------------------------------------------------------------
-- 4. 공간 소식 · 녹음 변환
-- ---------------------------------------------------------------------
:as_v
select public.set_notification_settings('{"workspace": false}') ->> 'workspace' as x \gset
:as_own
select (public.create_invite(:'ws', 'EDITOR', 24, 1)) ->> 'code' as c_nw \gset
:as_nw
select public.accept_invite(:'c_nw') is not null as x \gset
:as_admin
create function t.joined(p_to uuid, p_who uuid) returns bigint language sql security definer as $$
  select count(*) from public.notifications where account_id = p_to and kind = 'WORKSPACE_JOINED' and data ->> 'account_id' = p_who::text $$;
grant execute on function t.joined(uuid, uuid) to authenticated;
select t.ok(t.joined(:'own', :'nw') = 1 and t.joined(:'a', :'nw') = 1 and t.joined(:'b', :'nw') = 1 and t.nc(:'nw', 'WORKSPACE_JOINED') = 0
  and t.joined(:'v', :'nw') = 0 and t.joined(:'own', :'a') = 1
  and (select body = '새사람님이 공간에 들어왔어요' and title = '알림 공간' from public.notifications where account_id = :'own' and kind = 'WORKSPACE_JOINED' and data ->> 'account_id' = :'nw'),
  '4.1 새 멤버가 들어오면 다른 멤버에게 (본인·공간 소식을 끈 사람 제외)');
\set rec '00000000-0000-4000-8000-00000000b0aa'
insert into private.stt_recordings (id, account_id, workspace_id, segment_count, total_seconds) values (:'rec', :'a', :'ws', 2, 240);
insert into private.stt_segments (id, recording_id, seq, account_id, object_path, ext, mime_type, declared_size_bytes, start_seconds, duration_seconds, status)
values (gen_random_uuid(), :'rec', 0, :'a', 'r/0.m4a', 'm4a', 'audio/mp4', 10, 0, 120, 'PROCESSING'),
       (gen_random_uuid(), :'rec', 1, :'a', 'r/1.m4a', 'm4a', 'audio/mp4', 10, 120, 120, 'PROCESSING');
update private.stt_segments set status = 'DONE' where recording_id = :'rec' and seq = 0;
select t.ok(t.nc(:'a', 'RECORDING_DONE') = 0, '4.2 아직 처리 중인 구간이 있으면 알리지 않음');
update private.stt_segments set status = 'FAILED' where recording_id = :'rec' and seq = 1;
select t.ok(t.nc(:'a', 'RECORDING_DONE') = 1 and (select title = '녹음 일부를 바꾸지 못했어요' from public.notifications where kind = 'RECORDING_DONE'),
  '4.3 다 끝나면 녹음한 사람에게 (실패 구간 안내)');
update private.stt_segments set status = 'QUEUED' where recording_id = :'rec' and seq = 1;
update private.stt_segments set status = 'DONE' where recording_id = :'rec' and seq = 1;
select t.ok(t.nc(:'a', 'RECORDING_DONE') = 2 and exists (select 1 from public.notifications where kind = 'RECORDING_DONE' and title = '녹음을 글로 바꿨어요'),
  '4.4 실패 구간을 다시 해서 끝나면 또 알림');

-- ---------------------------------------------------------------------
-- 5. 브리핑 (B: 일간 07:30, 서울)
-- ---------------------------------------------------------------------
:as_b
select public.set_notification_settings('{"briefing_weekly": {"on": true, "day": 0, "time": "21:00"}}') ->> 'push' as x \gset
:as_admin
select private.enqueue_briefings('2026-11-16 07:29:00+09') as b0 \gset
select private.enqueue_briefings('2026-11-16 07:33:00+09') as b1 \gset
select private.enqueue_briefings('2026-11-16 07:35:00+09') as b2 \gset
select t.ok(:b0 = 0 and :b1 = 1 and :b2 = 0 and t.nc(:'b', 'BRIEFING_DAILY') = 1, '5.1 일간: 설정 시각부터 10분 안에 하루 한 번', :'b0' || '/' || :'b1' || '/' || :'b2');
select private.enqueue_briefings('2026-11-16 07:45:00+09') as b3 \gset
select t.ok(:b3 = 0, '5.2 10분이 지나면 그날은 안 보냄', :'b3');
select private.enqueue_briefings('2026-11-16 21:00:00+09') as b4 \gset
select private.enqueue_briefings('2026-11-15 21:02:00+09') as b5 \gset
select t.ok(:b4 = 0 and :b5 = 1 and t.nc(:'b', 'BRIEFING_WEEKLY') = 1, '5.3 주간: 정한 요일(일)만', :'b4' || '/' || :'b5');
update public.user_settings set timezone = 'America/New_York' where account_id = :'b';
select private.enqueue_briefings('2026-11-17 07:31:00-05') as b6 \gset
select t.ok(:b6 = 1, '5.4 사용자 시간대 기준', :'b6');
select t.ok((select data ->> 'type' = 'briefing' and body = '오늘 일정과 남은 할 일을 확인해 보세요' from public.notifications where kind = 'BRIEFING_DAILY' limit 1),
  '5.5 브리핑 푸시는 안내만 (내용은 기기가 만듦)');
:as_own
select public.set_notification_settings('{"push": false}') ->> 'push' as x \gset
:as_admin
select count(*) as own_before from public.notifications where account_id = :'own' \gset
select private.notify(:'own', :'ws', 'SYSTEM', '테스트', '테스트', '{}', 'X:1') as ins \gset
select t.ok(not :'ins'::boolean and (select count(*) from public.notifications where account_id = :'own') = :own_before, '5.6 알림 전체를 끄면 아무것도 안 넣음');
:as_own
select public.set_notification_settings('{"push": true}') ->> 'push' as x \gset

-- ---------------------------------------------------------------------
-- 6. 보내기 (push-send가 부르는 함수)
-- ---------------------------------------------------------------------
:as_own
select t.err('select public.push_claim(10)', '42501', '6.1 앱은 보낼 목록을 못 가져감');
:as_svc
select public.push_claim(500) as cl \gset
:as_admin
select t.ok(jsonb_array_length(:'cl'::jsonb) > 0
  and not exists (select 1 from jsonb_array_elements(:'cl'::jsonb) x where jsonb_array_length(x -> 'tokens') = 0)
  and exists (select 1 from jsonb_array_elements(:'cl'::jsonb) x where x -> 'tokens' = jsonb_build_array(:'tok1') and x -> 'data' ? 'notification_id'),
  '6.2 토큰 있는 사람 것만 가져감 (data에 notification_id)', left(:'cl', 300));
select t.ok(not exists (select 1 from public.notifications where account_id = :'v' and status <> 'SKIPPED')
  and exists (select 1 from public.notifications where account_id = :'v' and last_error = 'NO_DEVICE'), '6.3 기기가 없는 사람 알림은 SKIPPED');
:as_svc
select public.push_claim(500) as cl2 \gset
select t.ok(:'cl2'::jsonb = '[]'::jsonb, '6.4 가져간 것은 잠겨서 두 번 안 감', :'cl2');
select (:'cl'::jsonb -> 0 ->> 'id') as id1, (:'cl'::jsonb -> 1 ->> 'id') as id2 \gset
select public.push_report(jsonb_build_array(
  jsonb_build_object('id', :'id1', 'ok', true),
  jsonb_build_object('id', :'id2', 'ok', false, 'error', 'DeviceNotRegistered', 'bad_tokens', jsonb_build_array(:'tok2')))) as rp \gset
:as_admin
select t.ok((select status = 'SENT' and sent_at is not null from public.notifications where id = :'id1')
  and (select status = 'PENDING' and scheduled_for > now() and last_error = 'DeviceNotRegistered' from public.notifications where id = :'id2')
  and (select push_token is null from public.devices where id = :'d_own'),
  '6.5 결과: 성공 → SENT, 실패 → 1분 뒤 다시, 잘못된 토큰은 기기에서 뺌', :'rp');
update public.notifications set attempts = 3 where id = :'id2';
:as_svc
select public.push_report(jsonb_build_array(jsonb_build_object('id', :'id2', 'ok', false, 'error', 'MessageRateExceeded'))) ->> 'failed' as x \gset
:as_admin
select t.ok((select status = 'FAILED' from public.notifications where id = :'id2'), '6.6 3번 실패하면 FAILED');
select t.err($$select public.push_report('{}')$$, 'INVALID_REQUEST', '6.7 결과는 배열');
-- 매분 tick
delete from net.calls;
update public.notifications set status = 'PENDING', locked_at = null, scheduled_for = now() - interval '1 minute' where id = :'id1';
select private.push_tick() as tk \gset
select t.ok((:'tk'::jsonb ->> 'kicked')::boolean and exists (select 1 from net.calls where url like '%/functions/v1/push-send'),
  '6.8 보낼 것이 있으면 push-send를 깨움', :'tk');
update public.notifications set status = 'SENT' where status = 'PENDING';
delete from net.calls;
select private.push_tick() as tk2 \gset
select t.ok(not (:'tk2'::jsonb ->> 'kicked')::boolean and not exists (select 1 from net.calls), '6.9 보낼 것이 없으면 안 깨움', :'tk2');
select t.ok(exists (select 1 from cron.job where jobname = 'push-tick' and schedule = '* * * * *'), '6.10 cron 등록 (매분)');

-- ---------------------------------------------------------------------
-- 7. 알림함
-- ---------------------------------------------------------------------
:as_a
select public.list_notifications(100) as ls \gset
select t.ok(jsonb_array_length(:'ls'::jsonb) > 0 and not exists (select 1 from jsonb_array_elements(:'ls'::jsonb) x where x ->> 'read_at' is not null),
  '7.1 내 알림함 (보낸 것)', left(:'ls', 200));
select public.mark_notifications_read() as rd \gset
select t.ok(:rd > 0 and (select count(*) = 0 from public.notifications where account_id = :'a' and read_at is null), '7.2 모두 읽음', :'rd');
:as_admin
select id as own_unread from public.notifications where account_id = :'own' and read_at is null limit 1 \gset
:as_b
select t.ok(not exists (select 1 from jsonb_array_elements(public.list_notifications(200)) x where x ->> 'id' in (select id::text from public.notifications where account_id <> :'b')),
  '7.3 남의 알림은 안 보임');
select t.ok(public.mark_notifications_read(array[:'own_unread'::uuid]) = 0, '7.4 남의 알림은 읽음 표시 못 함');
:as_admin
select t.ok((select read_at is null from public.notifications where id = :'own_unread'), '7.4b 그대로 안 읽음');
:as_v
select jsonb_array_length(public.list_notifications(100)) as v_before \gset
select public.leave_workspace(:'ws') is not null as x \gset
select t.ok(:v_before > 0 and jsonb_array_length(public.list_notifications(100)) = 0, '7.6 나간 공간의 알림은 알림함에서 안 보임', :'v_before');
:as_admin
select t.ok(not has_function_privilege('authenticated', 'private.enqueue_reminders(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.set_push_token(uuid, text, text)', 'execute'), '7.5 내부 함수 권한');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
