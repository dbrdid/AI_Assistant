-- migration #22 ui_fields_and_note_restore · #23 note_strokes_validation 시나리오 테스트 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_ui_fields.sql | grep -E "TOTAL|FAIL"
--   확인: 공간 설명 · 프로젝트/할 일/일정 화면 칸 · 메모 손글씨(strokes) 형식 검사 · 메모 복구(RESTORE)
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
-- 오류 확인: p_code는 메시지 앞부분 또는 SQLSTATE(5자리)
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
-- sync_push 한 번 (오류면 {"error": sqlstate, "msg": ...})
create function t.push(p_ws uuid, p_ops jsonb, p_op uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.sync_push(p_ws, p_op, p_ops);
exception when others then
  return jsonb_build_object('error', sqlstate, 'msg', sqlerrm);
end $$;
create function t.one(p_entity text, p_op text, p_id uuid, p_base bigint, p_data jsonb) returns jsonb
language sql as $$
  -- data 안의 null은 그대로 보냄 ("이 칸을 지움")
  select jsonb_build_array(jsonb_build_object('entity', p_entity, 'op', p_op, 'id', p_id, 'data', p_data)
         || case when p_base is null then '{}'::jsonb else jsonb_build_object('base_revision', p_base) end)
$$;
create function t.seq(p_ws uuid) returns bigint language sql security definer as $$
  select last_seq from public.workspace_sync_heads where workspace_id = p_ws $$;
grant execute on all functions in schema t to authenticated, anon;

\set owner '00000000-0000-4000-8000-0000000000a0'
\set alice '00000000-0000-4000-8000-0000000000a1'
\set vic   '00000000-0000-4000-8000-0000000000a2'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'owner', 'owner@test.dev', '{"name":"Owner"}'),
  (:'alice', 'alice@test.dev', '{"name":"Alice"}'),
  (:'vic',   'vic@test.dev',   '{"name":"Viewer"}');

\set as_owner 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_alice 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_vic   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a2'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_anon  'reset role; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', false); set role anon;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

-- ---------------------------------------------------------------------
-- 1. 공간 설명 (create_workspace(이름, 설명))
-- ---------------------------------------------------------------------
:as_owner
select public.create_workspace('설명 있는 공간', '캡스톤 팀 공간') as ws \gset
select public.create_workspace('설명 없는 공간') as ws0 \gset
select public.create_workspace('설명 null', null) as ws1 \gset
select t.ok((select description from public.workspaces where id = :'ws') = '캡스톤 팀 공간', '1.1 설명 저장, 앱에서 조회됨(RLS)');
select t.ok((select description from public.workspaces where id = :'ws0') is null, '1.2 기존 create_workspace(이름) 그대로 동작, 설명 없음');
select t.ok((select description from public.workspaces where id = :'ws1') is null
        and exists (select 1 from public.workspace_members where workspace_id = :'ws1' and account_id = :'owner' and role = 'OWNER'),
        '1.3 설명 null 허용, 만든 사람이 OWNER');
select t.ok((select count(*) from public.workspaces where description = repeat('가', 120)) = 0
        and public.create_workspace('120자', repeat('가', 120)) is not null, '1.4 설명 120자까지 허용');
select t.err($$select public.create_workspace('너무 김', repeat('가', 121))$$, 'INVALID_REQUEST', '1.5 설명 121자 → INVALID_REQUEST');
:as_admin
select t.ok((select count(*) from public.workspaces where name = '너무 김') = 0, '1.6 거절되면 공간도 안 생김');
:as_anon
select t.err($$select public.create_workspace('익명', '설명')$$, '42501', '1.7 비로그인 → 실행 권한 없음');
:as_owner
select t.err($$update public.workspaces set description = 'x' where id = '$$ || :'ws' || $$'$$, '42501', '1.8 앱에서 workspaces 직접 수정 불가 (설명은 RPC로만)');

-- 초대: alice EDITOR, vic VIEWER
select (public.create_invite(:'ws', 'EDITOR', 24, 1)) ->> 'code' as code_e \gset
select (public.create_invite(:'ws', 'VIEWER', 24, 1)) ->> 'code' as code_v \gset
:as_alice
select public.accept_invite(:'code_e') as acc1 \gset
:as_vic
select public.accept_invite(:'code_v') as acc2 \gset

-- ---------------------------------------------------------------------
-- 2. 프로젝트 화면 칸
-- ---------------------------------------------------------------------
\set p1 '00000000-0000-4000-8000-00000000b001'
\set p2 '00000000-0000-4000-8000-00000000b002'
:as_owner
select t.push(:'ws', t.one('projects', 'UPSERT', :'p1', null, jsonb_build_object(
  'name', '발표 준비', 'due_date', '2026-11-30', 'priority', 2, 'progress_status', 'IN_PROGRESS',
  'reminder_minutes', 1440, 'assignee_name', '병욱', 'location', '공학관 301'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '2.1 새 칸을 넣어 프로젝트 만들기', :'r');
select t.ok((select due_date = '2026-11-30' and priority = 2 and progress_status = 'IN_PROGRESS' and reminder_minutes = 1440
               and assignee_name = '병욱' and location = '공학관 301' and status = 'ACTIVE'
             from public.projects where id = :'p1'), '2.2 칸 값 저장, 보관 상태(status)는 ACTIVE 그대로');
select t.push(:'ws', t.one('projects', 'UPSERT', :'p2', null, jsonb_build_object('name', '기본값'))) as r \gset
select t.ok((select priority = 0 and progress_status = 'TODO' and due_date is null and reminder_minutes is null
             from public.projects where id = :'p2'), '2.3 안 보내면 기본값 (중요도 0, 진행 TODO)');
select t.push(:'ws', t.one('projects', 'UPSERT', :'p1', 1, jsonb_build_object('progress_status', 'DONE'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED'
        and (select progress_status = 'DONE' and priority = 2 and location = '공학관 301' and revision = 2
             from public.projects where id = :'p1'), '2.4 보낸 칸만 바뀜 (진행 DONE, 나머지 유지, revision 2)', :'r');
select t.push(:'ws', t.one('projects', 'UPSERT', :'p1', 2, jsonb_build_object('due_date', null, 'reminder_minutes', null))) as r \gset
select t.ok((select due_date is null and reminder_minutes is null from public.projects where id = :'p1'), '2.5 null을 보내면 마감·알림 지움');
select t.seq(:'ws') as s0 \gset
select t.push(:'ws', t.one('projects', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('name', 'x', 'progress_status', 'WAITING'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '2.6 없는 진행 상태 → CHECK_FAILED(23514)', :'r');
select t.push(:'ws', t.one('projects', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('name', 'x', 'priority', 4))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '2.7 중요도 4 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('projects', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('name', 'x', 'reminder_minutes', 525601))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '2.8 알림 1년(525600분) 초과 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('projects', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('name', 'x', 'location', repeat('a', 201)))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '2.9 장소 201자 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('projects', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('name', 'x', 'due_date', '내일'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22007', '2.10 날짜 형식 아님 → 22007(INVALID_FORMAT)', :'r');
select t.ok(t.seq(:'ws') = :s0, '2.11 거절된 요청은 순번을 쓰지 않음');

-- ---------------------------------------------------------------------
-- 3. 할 일 화면 칸
-- ---------------------------------------------------------------------
\set k1 '00000000-0000-4000-8000-00000000c001'
select t.push(:'ws', t.one('tasks', 'UPSERT', :'k1', null, jsonb_build_object(
  'title', '슬라이드 정리', 'project_id', :'p1', 'reminder_minutes', 30, 'assignee_name', '주원', 'location', '도서관'))) as r \gset
select t.ok((select reminder_minutes = 30 and assignee_name = '주원' and location = '도서관' and assignee_id is null
             from public.tasks where id = :'k1'), '3.1 할 일 알림·담당자 이름·장소 저장 (assignee_id와 별개)', :'r');
select t.push(:'ws', t.one('tasks', 'UPSERT', :'k1', 1, jsonb_build_object('assignee_id', :'alice', 'assignee_name', 'Alice'))) as r \gset
select t.ok((select assignee_id = :'alice' and assignee_name = 'Alice' and reminder_minutes = 30 from public.tasks where id = :'k1'),
        '3.2 담당자 계정·표시 이름 함께 수정, 알림 유지', :'r');
select t.push(:'ws', t.one('tasks', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'assignee_name', repeat('a', 101)))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '3.3 담당자 이름 101자 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('tasks', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'reminder_minutes', -1))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '3.4 알림 음수 → CHECK_FAILED', :'r');

-- ---------------------------------------------------------------------
-- 4. 일정 화면 칸
-- ---------------------------------------------------------------------
\set e1 '00000000-0000-4000-8000-00000000e001'
select t.push(:'ws', t.one('events', 'UPSERT', :'e1', null, jsonb_build_object(
  'title', '중간 점검', 'start_at', '2026-11-20T14:00:00+09:00', 'end_at', '2026-11-20T15:00:00+09:00'))) as r \gset
select t.ok((select status = 'TODO' and priority = 0 and reminder_minutes is null from public.events where id = :'e1'),
        '4.1 일정 기본값 (상태 TODO, 중요도 0)', :'r');
select t.push(:'ws', t.one('events', 'UPSERT', :'e1', 1, jsonb_build_object(
  'status', 'DONE', 'priority', 3, 'reminder_minutes', 10, 'assignee_name', '팀 전체'))) as r \gset
select t.ok((select status = 'DONE' and priority = 3 and reminder_minutes = 10 and assignee_name = '팀 전체' and title = '중간 점검'
             from public.events where id = :'e1'), '4.2 일정 상태·중요도·알림·담당자 이름 수정', :'r');
select t.push(:'ws', t.one('events', 'UPSERT', :'e1', 2, jsonb_build_object('status', 'ON_HOLD'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '4.3 일정에는 ON_HOLD 없음 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('events', 'UPSERT', :'e1', 2, jsonb_build_object('priority', null))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23502', '4.4 일정 중요도 null → REQUIRED_FIELD(23502)', :'r');

-- ---------------------------------------------------------------------
-- 5. 메모 손글씨 (strokes)
-- ---------------------------------------------------------------------
\set n1 '00000000-0000-4000-8000-00000000d001'
\set n2 '00000000-0000-4000-8000-00000000d002'
\set stroke1 '[{"id":"s1","c":"#111111","w":2.5,"p":[[10,20],[11.5,21.25],[13,22]]}]'
\set stroke2 '[{"id":"s1","c":"#111111","w":2.5,"p":[[10,20]]},{"id":"s2","c":"rgba(255,0,0,0.5)","w":8,"p":[[0,0],[-5,3e2]]}]'
select t.push(:'ws', t.one('notes', 'UPSERT', :'n1', null, jsonb_build_object('title', '글 메모', 'body', '본문'))) as r \gset
select t.ok((select strokes = '[]'::jsonb from public.notes where id = :'n1'), '5.1 손글씨 없이 만들면 빈 배열', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', :'n2', null, jsonb_build_object('title', '필기', 'strokes', :'stroke1'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED'
        and (select strokes = :'stroke1'::jsonb and body = '' from public.notes where id = :'n2'), '5.2 손글씨 획 저장 (좌표·색·굵기 그대로)', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', :'n2', 1, jsonb_build_object('strokes', :'stroke2'::jsonb))) as r \gset
select t.ok((select strokes = :'stroke2'::jsonb and title = '필기' and revision = 2 from public.notes where id = :'n2'),
        '5.3 손글씨만 수정 (음수·지수 좌표, rgba 색 허용), 제목 유지', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', :'n2', 2, jsonb_build_object('title', '필기 2'))) as r \gset
select t.ok((select strokes = :'stroke2'::jsonb and title = '필기 2' from public.notes where id = :'n2'), '5.4 strokes를 안 보내면 손글씨 유지', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', :'n2', 3, jsonb_build_object('strokes', '[]'::jsonb))) as r \gset
select t.ok((select strokes = '[]'::jsonb from public.notes where id = :'n2'), '5.5 빈 배열을 보내면 손글씨 모두 지움', :'r');
select t.seq(:'ws') as s1 \gset
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '{"id":"s1"}'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.6 배열이 아님 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"s1","w":2,"p":[[1,2]]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.7 색(c) 없음 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"","c":"#000","w":2,"p":[[1,2]]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.8 빈 id → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"s","c":"#000","w":0,"p":[[1,2]]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.9 굵기 0 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"s","c":"#000","w":101,"p":[[1,2]]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.10 굵기 100 초과 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"s","c":"#000","w":"2","p":[[1,2]]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.11 굵기가 문자열 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"s","c":"#000","w":2,"p":[]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.12 점 0개 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"s","c":"#000","w":2,"p":[[1,2,3]]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.13 점이 [x,y]가 아님 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x', 'strokes', '[{"id":"s","c":"#000","w":2,"p":[["1","2"]]}]'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.14 좌표가 문자열 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x',
  'strokes', jsonb_build_array(jsonb_build_object('id', 's', 'c', '#000', 'w', 2,
     'p', (select jsonb_agg(jsonb_build_array(g, g)) from generate_series(1, 10001) g)))))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.15 한 획에 점 10,001개 → CHECK_FAILED', :'r');
-- 1MiB 넘는 손글씨 (획 여러 개, 점 형식은 정상)
select t.push(:'ws', t.one('notes', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', 'x',
  'strokes', (select jsonb_agg(jsonb_build_object('id', 's' || s, 'c', '#000000', 'w', 2,
     'p', (select jsonb_agg(jsonb_build_array(1234.5678, 8765.4321)) from generate_series(1, 2000))))
   from generate_series(1, 30) s)))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '5.16 손글씨 1MiB 초과 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', :'n2', 4, jsonb_build_object('strokes', null))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514' and (select revision from public.notes where id = :'n2') = 4,
        '5.17 strokes: null → 거절, 기존 손글씨 그대로', :'r');
-- 묶음 하나가 잘못되면 전부 거절 (메모 1개 정상 + 1개 잘못된 획)
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', gen_random_uuid(), 'data', jsonb_build_object('title', '정상')),
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', gen_random_uuid(), 'data', jsonb_build_object('title', '잘못', 'strokes', '[1]'::jsonb)))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514' and (select count(*) from public.notes where title = '정상') = 0,
        '5.18 묶음 중 하나라도 잘못된 획이면 전부 거절', :'r');
select t.ok(t.seq(:'ws') = :s1, '5.19 거절된 손글씨 요청은 순번을 쓰지 않음');
select t.err($$select private.valid_note_strokes('[]'::jsonb)$$, '42501', '5.20 형식 검사 함수는 앱에서 직접 못 부름');
:as_admin
select t.ok(private.valid_note_strokes(:'stroke2'::jsonb) and not private.valid_note_strokes('[{"id":"s","c":"#0","w":2,"p":[[1,null]]}]'::jsonb),
        '5.21 형식 검사 함수: 정상 true / 좌표 null false');
select t.err($$update public.notes set strokes = '[{"bad":1}]' where id = '00000000-0000-4000-8000-00000000d001'$$, '23514',
        '5.22 관리자(SQL Editor)가 고쳐도 형식 검사 적용 (테이블 제약)');

-- ---------------------------------------------------------------------
-- 6. 메모 복구 (RESTORE)
-- ---------------------------------------------------------------------
:as_owner
select revision as rv from public.notes where id = :'n1' \gset
select t.push(:'ws', t.one('notes', 'DELETE', :'n1', :rv, '{}'::jsonb)) as r \gset
select t.ok((select deleted_at is not null and deleted_by = :'owner' from public.notes where id = :'n1'), '6.1 메모 삭제 → 휴지통', :'r');
select revision as rv from public.notes where id = :'n1' \gset
select t.push(:'ws', t.one('notes', 'UPSERT', :'n1', :rv, jsonb_build_object('title', '휴지통에서 수정'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'DELETED',
        '6.2 휴지통 메모 수정 → DELETED 충돌 (그대로)', :'r');
select t.seq(:'ws') as s2 \gset
:as_vic
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv, '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '42501', '6.3 VIEWER는 복구 불가 → FORBIDDEN', :'r');
:as_alice
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', null, '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%base_revision%', '6.4 base_revision 없이 복구 → INVALID_REQUEST', :'r');
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv, jsonb_build_object('title', '복구하면서 수정'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023', '6.5 복구 + 데이터 함께 → INVALID_REQUEST (복구 후 따로 수정)', :'r');
select t.push(:'ws', jsonb_build_array(jsonb_build_object('entity', 'input_sources', 'op', 'RESTORE', 'id', :'n1', 'base_revision', 1, 'data', '{}'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%휴지통 대상%', '6.6 휴지통 대상이 아닌 것(원문) 복구 → INVALID_REQUEST (#32부터 할 일 등은 복구됨)', :'r');
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv - 1, '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'REVISION_MISMATCH',
        '6.7 오래된 revision으로 복구 → REVISION_MISMATCH', :'r');
select t.ok(t.seq(:'ws') = :s2, '6.8 거절·충돌은 순번을 쓰지 않음');
\set opr '00000000-0000-4000-8000-0000000f0001'
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv, '{}'::jsonb), :'opr') as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED'
        and (:'r'::jsonb -> 'results' -> 0 ->> 'revision')::int = :rv + 1
        and (:'r'::jsonb -> 'results' -> 0 ->> 'deleted')::boolean = false,
        '6.9 EDITOR가 복구 → ACCEPTED, revision +1, deleted=false', :'r');
select t.ok((select deleted_at is null and deleted_by is null and title = '글 메모' and body = '본문' from public.notes where id = :'n1'),
        '6.10 복구된 메모: 휴지통 표시 지워짐, 내용 그대로');
select t.ok(t.seq(:'ws') = :s2 + 1, '6.11 복구는 순번 1개');
:as_admin
select t.ok((select op = 'UPSERT' and (data ->> 'deleted_at') is null and data ->> 'title' = '글 메모' and actor_id = :'alice'
             from public.workspace_changes where workspace_id = :'ws' and seq = :s2 + 1),
        '6.12 변경 원장: UPSERT + deleted_at null (다른 기기가 sync_pull로 복구를 받음)');
:as_alice
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv, '{}'::jsonb), :'opr') as r \gset
select t.ok((:'r'::jsonb ->> 'replayed')::boolean and t.seq(:'ws') = :s2 + 1, '6.13 같은 operation_id 재전송 → 처음 결과, 다시 적용 안 함', :'r');
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv + 1, '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_DELETED',
        '6.14 휴지통에 없는 메모 복구 → NOT_DELETED 충돌', :'r');
select t.push(:'ws', t.one('notes', 'UPSERT', :'n1', :rv + 1, jsonb_build_object('title', '복구 후 수정'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and (select title from public.notes where id = :'n1') = '복구 후 수정',
        '6.15 복구 후에는 다시 수정 가능', :'r');
select t.push(:'ws', t.one('notes', 'RESTORE', gen_random_uuid(), 1, '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_FOUND',
        '6.16 없는 메모 복구 → NOT_FOUND 충돌', :'r');
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv + 2, '{}'::jsonb) || t.one('notes', 'DELETE', :'n1', :rv + 2, '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023', '6.17 한 묶음에 같은 메모 복구+삭제 → INVALID_REQUEST', :'r');
-- 삭제 → 복구 → 삭제를 순서대로 (각각 다른 요청)
select revision as rv2 from public.notes where id = :'n1' \gset
select t.push(:'ws', t.one('notes', 'DELETE', :'n1', :rv2, '{}'::jsonb)) as r1 \gset
select t.push(:'ws', t.one('notes', 'RESTORE', :'n1', :rv2 + 1, '{}'::jsonb)) as r2 \gset
select t.ok(:'r1'::jsonb ->> 'status' = 'ACCEPTED' and :'r2'::jsonb ->> 'status' = 'ACCEPTED'
        and (select deleted_at is null and revision = :rv2 + 2 from public.notes where id = :'n1'),
        '6.18 삭제 → 복구를 반복해도 revision이 이어짐', :'r2');

-- ---------------------------------------------------------------------
-- 7. 다른 기기에서 받기 (sync_pull / sync_snapshot에 새 칸)
-- ---------------------------------------------------------------------
:as_vic
select public.sync_pull(:'ws', 0, 500) as pl \gset
select t.ok(exists (select 1 from jsonb_array_elements(:'pl'::jsonb -> 'changes') c
                    where c ->> 'entity' = 'projects' and c -> 'data' ->> 'progress_status' = 'DONE'
                      and c -> 'data' ? 'due_date' and c -> 'data' ->> 'location' = '공학관 301'),
        '7.1 sync_pull에 프로젝트 새 칸이 옴 (VIEWER도 읽기 가능)');
select t.ok(exists (select 1 from jsonb_array_elements(:'pl'::jsonb -> 'changes') c
                    where c ->> 'entity' = 'notes' and c ->> 'key' = :'n2' and c -> 'data' -> 'strokes' = :'stroke1'::jsonb),
        '7.2 sync_pull에 손글씨 획이 옴');
select public.sync_snapshot(:'ws') as sn \gset
select t.ok((select r -> 'strokes' = '[]'::jsonb and r ->> 'deleted_at' is null
             from jsonb_array_elements(:'sn'::jsonb -> 'notes') r where r ->> 'id' = :'n1')
        and (select r ->> 'status' = 'DONE' from jsonb_array_elements(:'sn'::jsonb -> 'events') r where r ->> 'id' = :'e1')
        and :'sn'::jsonb -> 'workspace' ->> 'description' = '캡스톤 팀 공간',
        '7.3 sync_snapshot: 공간 설명, 복구된 메모, 일정 상태 포함', left(:'sn', 300));

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
