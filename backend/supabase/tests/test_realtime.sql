-- 공유 공간 변경 신호(Realtime) 시나리오 테스트 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql ... -f test_realtime.sql
--   realtime.messages / topic() / send()는 bootstrap.sql의 흉내(원격과 같은 정의)를 씀
--   "받기 권한"은 Realtime 서버가 하는 것처럼 role·JWT·realtime.topic을 설정하고 SELECT로 확인
\set QUIET on
\pset format unaligned
\pset tuples_only on

drop schema if exists t cascade;
create schema t;
create table t.results (n serial, name text, pass boolean, detail text);
grant usage on schema t to authenticated, anon;
grant insert, select on t.results to authenticated, anon;
grant usage on sequence t.results_n_seq to authenticated, anon;
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
-- 주제를 정하고 그 사람이 볼 수 있는 신호 수 (Realtime 서버의 권한 확인과 같은 방식)
create function t.visible(p_topic text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('realtime.topic', coalesce(p_topic, ''), true);
  select count(*) into n from realtime.messages where topic = coalesce(p_topic, topic);
  return n;
end $$;
grant execute on all functions in schema t to authenticated, anon;

\set owner '00000000-0000-4000-8000-0000000000a0'
\set alice '00000000-0000-4000-8000-0000000000a1'
\set xout  '00000000-0000-4000-8000-0000000000f0'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'owner', 'owner@test.dev', '{"name":"Owner"}'),
  (:'alice', 'alice@test.dev', '{"name":"Alice"}'),
  (:'xout',  'x@test.dev',     '{"name":"Outsider"}');

\set as_owner 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_alice 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_xout  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000f0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_anon  'reset role; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', false); set role anon;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

-- ---------------------------------------------------------------------
-- 1. 공간 만들기 → 초대 → 참여: 멤버 변경도 신호가 됨
-- ---------------------------------------------------------------------
:as_owner
select public.create_workspace('신호 테스트') as ws \gset
select 'workspace:' || :'ws' as topic \gset
select (public.create_invite(:'ws', 'EDITOR', 24, 1)) ->> 'code' as code \gset
:as_admin
select t.ok((select count(*) from realtime.messages) = 0, '1.1 공간을 만들기만 하면 신호 없음 (순번 그대로)');
:as_alice
select public.accept_invite(:'code') as acc \gset
:as_admin
select t.ok((select count(*) from realtime.messages where topic = :'topic' and event = 'changed') = 1
        and (select (payload ->> 'last_seq')::int from realtime.messages where topic = :'topic' and event = 'changed') = 1,
        '1.2 참여(멤버 변경) → changed 신호 1개, last_seq=1');

-- ---------------------------------------------------------------------
-- 2. 저장(sync_push) → changed 신호
-- ---------------------------------------------------------------------
\set note '00000000-0000-4000-8000-00000000d001'
:as_owner
select public.sync_push(:'ws', gen_random_uuid(),
  jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', :'note',
    'data', jsonb_build_object('title', '비밀 제목', 'body', '비밀 본문')))) as r1 \gset
:as_admin
select t.ok(:'r1'::jsonb ->> 'status' = 'ACCEPTED', '2.0 저장 성공', :'r1');
select t.ok((select count(*) from realtime.messages where topic = :'topic' and event = 'changed') = 2, '2.1 저장 1번 → 신호 1개 더');
select t.ok((select max((payload ->> 'last_seq')::bigint) from realtime.messages where topic = :'topic')
          = (select last_seq from public.workspace_sync_heads where workspace_id = :'ws'), '2.2 신호의 last_seq = 서버 순번');
select t.ok((select bool_and(private and extension = 'broadcast') from realtime.messages), '2.3 비공개(private) broadcast로 보냄');
select t.ok((select bool_and((select array_agg(k order by k) from jsonb_object_keys(payload) k) = array['id', 'last_seq', 'workspace_id'])
             from realtime.messages where event = 'changed'), '2.4 신호에는 공간·순번만 (데이터 없음)');
select t.ok((select count(*) from realtime.messages where payload::text like '%비밀%') = 0, '2.5 제목·본문이 신호에 안 실림');

-- 같은 요청 재전송(같은 operation_id)·충돌은 순번이 안 올라가므로 신호 없음
:as_owner
select gen_random_uuid() as op2 \gset
select public.sync_push(:'ws', :'op2', jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT',
  'id', :'note', 'base_revision', 1, 'data', jsonb_build_object('title', '수정', 'body', 'b')))) as r2 \gset
select public.sync_push(:'ws', :'op2', jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT',
  'id', :'note', 'base_revision', 1, 'data', jsonb_build_object('title', '수정', 'body', 'b')))) as r2b \gset
:as_admin
select t.ok((select count(*) from realtime.messages where topic = :'topic') = 3 and (:'r2b'::jsonb ->> 'replayed')::boolean,
        '2.6 같은 요청 재전송 → 신호 추가 없음');
:as_alice
select public.sync_push(:'ws', gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT',
  'id', :'note', 'base_revision', 1, 'data', jsonb_build_object('title', '늦은 수정', 'body', 'b')))) as r3 \gset
:as_admin
select t.ok(:'r3'::jsonb ->> 'status' = 'CONFLICT' and (select count(*) from realtime.messages where topic = :'topic') = 3,
        '2.7 충돌(저장 안 됨) → 신호 없음', :'r3');

-- ---------------------------------------------------------------------
-- 3. 받기 권한 (realtime.messages RLS)
-- ---------------------------------------------------------------------
:as_owner
select t.ok(t.visible(:'topic') = 3, '3.1 OWNER는 자기 공간 신호를 받음');
:as_alice
select t.ok(t.visible(:'topic') = 3, '3.2 EDITOR 멤버도 받음');
:as_xout
select t.ok(t.visible(:'topic') = 0, '3.3 외부인은 못 받음');
:as_anon
select t.ok(t.visible(:'topic') = 0, '3.4 비로그인은 못 받음');
-- 주제를 바꿔 끼우기
:as_alice
select t.ok(t.visible('workspace:' || upper(:'ws')) = 0, '3.5 대문자 주제는 다른 주제로 취급 (못 받음)');
select t.ok(t.visible('workspace:not-a-uuid') = 0, '3.6 잘못된 주제 → 오류 없이 못 받음');
select t.ok(t.visible(null) = 0, '3.7 주제 없이 조회 → 아무것도 못 받음');
select t.ok(t.visible('workspace:' || :'ws' || ' ') = 0, '3.8 주제 뒤 공백 → 못 받음');
-- 다른 공간
:as_xout
select public.create_workspace('외부인 공간') as ws2 \gset
select public.sync_push(:'ws2', gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT',
  'id', gen_random_uuid(), 'data', jsonb_build_object('title', 'x', 'body', 'x')))) as r4 \gset
:as_alice
select t.ok(t.visible('workspace:' || :'ws2') = 0, '3.9 남의 공간 주제로 구독해도 못 받음');
select t.ok(t.visible(:'topic') = 3, '3.10 내 주제로는 내 공간 신호만 보임 (다른 공간 신호 섞이지 않음)');

-- ---------------------------------------------------------------------
-- 4. 앱은 신호를 보낼 수 없음
-- ---------------------------------------------------------------------
:as_alice
select t.err(format($q$insert into realtime.messages (topic, extension, event, payload, private)
                     values (%L, 'broadcast', 'changed', '{"last_seq": 999}', true)$q$, :'topic'),
             'new row violates row-level security', '4.1 멤버도 신호를 직접 넣을 수 없음');
:as_owner
update realtime.messages set payload = '{"last_seq": 999}' where topic = :'topic';
:as_admin
select t.ok((select count(*) from realtime.messages where (payload ->> 'last_seq') = '999') = 0, '4.2 OWNER도 기존 신호를 고칠 수 없음 (UPDATE 정책 없음)');
select t.err('select private.signal_workspace_change()', 'trigger functions can only be called as triggers', '4.3 트리거 함수는 직접 못 부름');
:as_alice
select t.ok(private.can_listen_workspace('x') = false, '4.4 권한 함수: 로그인 사용자 실행 가능, 잘못된 주제는 거짓');
:as_anon
select t.err('select private.can_listen_workspace(''x'')', 'permission denied', '4.5 비로그인은 권한 함수 실행 불가');

-- ---------------------------------------------------------------------
-- 5. 멤버에서 빠지면 받을 수 없음 / 공간 삭제 → closed
-- ---------------------------------------------------------------------
:as_owner
select public.remove_member(:'ws', :'alice') as rm \gset
:as_admin
select t.ok((select count(*) from realtime.messages where topic = :'topic' and event = 'changed') = 4, '5.1 내보내기(멤버 변경) → changed 신호');
:as_alice
select t.ok(t.visible(:'topic') = 0, '5.2 내보내진 사람은 더 이상 못 받음 (새로 구독할 때)');
:as_owner
select t.ok(t.visible(:'topic') = 4, '5.3 남은 멤버는 계속 받음');
select public.delete_workspace(:'ws') as del \gset
:as_admin
select t.ok((select count(*) from realtime.messages where topic = :'topic' and event = 'closed'
             and (payload ->> 'closed')::boolean and payload ->> 'workspace_id' = :'ws') = 1, '5.4 공간 삭제 → closed 신호');
:as_owner
select t.ok(t.visible(:'topic') = 0, '5.5 삭제된 공간은 새로 구독 못 함');

-- ---------------------------------------------------------------------
-- 6. 신호가 실패해도 저장은 됨
-- ---------------------------------------------------------------------
:as_admin
alter table realtime.messages rename to messages_off;
:as_xout
select public.sync_push(:'ws2', gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT',
  'id', gen_random_uuid(), 'data', jsonb_build_object('title', 'y', 'body', 'y')))) as r5 \gset
:as_admin
alter table realtime.messages_off rename to messages;
select t.ok(:'r5'::jsonb ->> 'status' = 'ACCEPTED'
        and (select last_seq from public.workspace_sync_heads where workspace_id = :'ws2') = 2,
        '6.1 신호 저장소가 없어도 저장(sync_push)은 성공', :'r5');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
