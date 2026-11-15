-- 메모 즐겨찾기 · 프로젝트 파일 연결 (#29) · 프로젝트 팀장 권한 (#30) · 백업·복원 (#31) 시나리오 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_project_extras.sql | grep -E "TOTAL|FAIL"
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
create function t.one(p_entity text, p_op text, p_id uuid, p_base bigint, p_data jsonb) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('entity', p_entity, 'op', p_op, 'id', p_id, 'data', p_data)
         || case when p_base is null then '{}'::jsonb else jsonb_build_object('base_revision', p_base) end)
$$;
create function t.link(p_entity text, p_op text, p_data jsonb) returns jsonb
language sql as $$ select jsonb_build_array(jsonb_build_object('entity', p_entity, 'op', p_op, 'data', p_data)) $$;
create function t.rev(p_table text, p_id uuid) returns bigint language plpgsql security definer as $$
declare r bigint; begin execute format('select revision from public.%I where id = $1', p_table) into r using p_id; return r; end $$;
create function t.seq(p_ws uuid) returns bigint language sql security definer as $$
  select last_seq from public.workspace_sync_heads where workspace_id = p_ws $$;
create function t.fav_count(p uuid) returns bigint language sql security definer as $$
  select count(*) from public.note_favorites where account_id = p $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set own '00000000-0000-4000-8000-0000000000d0'
\set ld  '00000000-0000-4000-8000-0000000000d1'
\set ed  '00000000-0000-4000-8000-0000000000d2'
\set vw  '00000000-0000-4000-8000-0000000000d3'
\set vw2 '00000000-0000-4000-8000-0000000000d4'
\set out '00000000-0000-4000-8000-0000000000d9'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', 'xo@test.dev', '{"name":"관리자"}'),
  (:'ld',  'xl@test.dev', '{"name":"팀장"}'),
  (:'ed',  'xe@test.dev', '{"name":"팀원"}'),
  (:'vw',  'xv@test.dev', '{"name":"보기"}'),
  (:'vw2', 'xv2@test.dev', '{"name":"보기2"}'),
  (:'out', 'xx@test.dev', '{"name":"외부인"}');

\set as_own  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_ld   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_ed   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d2'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_vw   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d3'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_vw2  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d4'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_out  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000d9'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_anon 'reset role; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', false); set role anon;'
\set as_svc  'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

:as_own
select public.create_workspace('팀 공간') as ws \gset
select (public.create_invite(:'ws', 'EDITOR', 24, 2)) ->> 'code' as c_ed \gset
select (public.create_invite(:'ws', 'VIEWER', 24, 2)) ->> 'code' as c_vw \gset
:as_ld
select public.accept_invite(:'c_ed') as x \gset
:as_ed
select public.accept_invite(:'c_ed') as x \gset
:as_vw
select public.accept_invite(:'c_vw') as x \gset
:as_vw2
select public.accept_invite(:'c_vw') as x \gset
:as_out
select public.create_workspace('남의 공간') as ws_out \gset

\set n1 '00000000-0000-4000-8000-0000000a0001'
\set n2 '00000000-0000-4000-8000-0000000a0002'
\set n3 '00000000-0000-4000-8000-0000000a0003'
\set nout '00000000-0000-4000-8000-0000000a00ff'
:as_ed
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', :'n1', 'data', jsonb_build_object('title', '회의 메모', 'body', 'a')),
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', :'n2', 'data', jsonb_build_object('title', '자료 정리', 'body', 'b')),
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', :'n3', 'data', jsonb_build_object('title', '휴지통 갈 메모', 'body', 'c')))) as r \gset
:as_out
select t.push(:'ws_out', t.one('notes', 'UPSERT', :'nout', null, jsonb_build_object('title', '남의 메모'))) as r \gset

-- =====================================================================
-- 1. 메모 즐겨찾기 (#29, 사람마다 따로)
-- =====================================================================
:as_ed
select t.seq(:'ws') as s0 \gset
select public.set_note_favorites(:'ws', array[:'n1', :'n2', :'n1']::uuid[], true) as f1 \gset
select t.ok((:'f1'::jsonb ->> 'changed')::int = 2 and jsonb_array_length(:'f1'::jsonb -> 'note_ids') = 2,
        '1.1 여러 개 한 번에 켜기 (같은 id 두 번은 한 번으로)', :'f1');
select t.ok(t.seq(:'ws') = :s0, '1.2 즐겨찾기는 동기화 원장에 안 남음 (팀원에게 안 감)');
select public.set_note_favorites(:'ws', array[:'n1']::uuid[], true) as f2 \gset
select t.ok((:'f2'::jsonb ->> 'changed')::int = 0, '1.3 이미 켠 것 다시 켜기 → 바뀐 것 없음', :'f2');
select t.ok((select count(*) = 2 from public.note_favorites), '1.4 내 즐겨찾기는 내가 조회 가능 (RLS)');
select public.list_note_favorites(:'ws') as l1 \gset
select t.ok(jsonb_array_length(:'l1'::jsonb) = 2 and (:'l1'::jsonb -> 0 ->> 'note_id') = :'n1', '1.5 목록: 켠 순서대로 (내 다른 기기가 받음)', :'l1');
:as_ld
select t.ok(jsonb_array_length(public.list_note_favorites(:'ws')) = 0 and (select count(*) = 0 from public.note_favorites),
        '1.6 팀원에게는 내 별표가 안 보임');
select public.set_note_favorites(:'ws', array[:'n1']::uuid[], true) \gset
select t.ok(t.fav_count(:'ld') = 1 and t.fav_count(:'ed') = 2, '1.7 같은 메모를 각자 따로 별표');
:as_vw
select t.ok((public.set_note_favorites(:'ws', array[:'n2']::uuid[], true) ->> 'changed')::int = 1, '1.8 보기 전용 멤버도 별표 가능 (내 표시일 뿐)');
:as_ed
select public.set_note_favorites(:'ws', array[:'n2']::uuid[], false) as f3 \gset
select t.ok((:'f3'::jsonb ->> 'changed')::int = 1 and jsonb_array_length(:'f3'::jsonb -> 'note_ids') = 1, '1.9 끄기', :'f3');
select t.err(format('select public.set_note_favorites(%L, array[%L]::uuid[], true)', :'ws', :'nout'), 'NOT_FOUND', '1.10 다른 공간 메모 → NOT_FOUND');
select t.err(format('select public.set_note_favorites(%L, array[%L]::uuid[], true)', :'ws_out', :'nout'), 'FORBIDDEN', '1.11 멤버가 아닌 공간 → FORBIDDEN');
select t.err(format('select public.set_note_favorites(%L, array[]::uuid[], true)', :'ws'), 'INVALID_REQUEST', '1.12 빈 목록 → INVALID_REQUEST');
select t.err(format('select public.set_note_favorites(%L, (select array_agg(gen_random_uuid()) from generate_series(1, 501)), true)', :'ws'),
        'INVALID_REQUEST', '1.13 501개 → INVALID_REQUEST');
select t.err(format('select public.set_note_favorites(%L, array[%L]::uuid[], null)', :'ws', :'n1'), 'INVALID_REQUEST', '1.14 켜기/끄기 값 없음 → INVALID_REQUEST');
select t.err(format('insert into public.note_favorites (account_id, workspace_id, note_id) values (%L, %L, %L)', :'ed', :'ws', :'n3'),
        '42501', '1.15 앱에서 직접 추가 불가');
-- 휴지통 메모도 별표 유지, 메모가 지워지면(완전 삭제) 함께 사라짐
select t.push(:'ws', t.one('notes', 'DELETE', :'n1', t.rev('notes', :'n1'), '{}'::jsonb)) as r \gset
select t.ok(jsonb_array_length(public.list_note_favorites(:'ws')) = 1, '1.16 휴지통에 간 메모도 별표 그대로 (복구하면 그대로)');
:as_anon
select t.err($$select public.list_note_favorites()$$, '42501', '1.17 비로그인 → 실행 권한 없음');
-- 공간에서 나가면 그 공간 별표 정리
:as_vw
select public.leave_workspace(:'ws') \gset
select t.ok(t.fav_count(:'vw') = 0, '1.18 공간을 나가면 그 공간 즐겨찾기 정리');
:as_ed
select public.create_workspace('ed의 다른 공간') as ws_ed2 \gset
\set ned2 '00000000-0000-4000-8000-0000000a00e2'
select t.push(:'ws_ed2', t.one('notes', 'UPSERT', :'ned2', null, jsonb_build_object('title', '다른 공간 메모'))) as r \gset
select public.set_note_favorites(:'ws_ed2', array[:'ned2']::uuid[], true) \gset
select t.ok(jsonb_array_length(public.list_note_favorites()) = 2 and jsonb_array_length(public.list_note_favorites(:'ws')) = 1,
        '1.19 공간을 안 정하면 내 모든 공간 즐겨찾기, 정하면 그 공간만');
:as_admin
insert into public.note_favorites (account_id, workspace_id, note_id) values (:'vw', :'ws', :'n2');
:as_vw
select t.ok((select count(*) = 0 from public.note_favorites) and jsonb_array_length(public.list_note_favorites()) = 0,
        '1.20 공간을 떠난 사람에게 남은 별표가 있어도 안 보임 (RLS·목록 모두)');

-- =====================================================================
-- 2. 프로젝트 ↔ 파일 (#29)
-- =====================================================================
\set h1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
\set f1 '00000000-0000-4000-8000-0000000b0001'
\set f2 '00000000-0000-4000-8000-0000000b0002'
\set fp '00000000-0000-4000-8000-0000000b0003'
\set fo '00000000-0000-4000-8000-0000000b00ff'
\set pa '00000000-0000-4000-8000-0000000c0001'
\set pb '00000000-0000-4000-8000-0000000c0002'
:as_svc
select public.asset_prepare(:'ed', :'f1', 'ATTACHMENT', :'ws', '회의 자료.pdf', 'application/pdf', 5, :'h1') \gset
select public.asset_complete(:'ed', :'f1', 5, :'h1') \gset
select public.asset_prepare(:'ed', :'f2', 'ATTACHMENT', :'ws', '사진.png', 'image/png', 5, :'h1') \gset
select public.asset_complete(:'ed', :'f2', 5, :'h1') \gset
select public.asset_prepare(:'ed', :'fp', 'ATTACHMENT', :'ws', '올리는 중.pdf', 'application/pdf', 5, :'h1') \gset
select public.asset_prepare(:'out', :'fo', 'ATTACHMENT', :'ws_out', '남의 파일.pdf', 'application/pdf', 5, :'h1') \gset
select public.asset_complete(:'out', :'fo', 5, :'h1') \gset
:as_ed
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'pa', 'data', jsonb_build_object('name', '발표')),
  jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'pb', 'data', jsonb_build_object('name', '보고서')))) as r \gset
select t.seq(:'ws') as s1 \gset
select t.push(:'ws', t.link('project_files', 'UPSERT', jsonb_build_object('project_id', :'pa', 'asset_id', :'f1', 'position', 2))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and :'r'::jsonb -> 'results' -> 0 ->> 'key' = :'pa' || ':' || :'f1'
        and (select position = 2 and added_by = :'ed' from public.project_files where project_id = :'pa' and asset_id = :'f1'),
        '2.1 프로젝트에 파일 직접 연결 (메모 없이)', :'r');
select t.ok(t.seq(:'ws') = :s1 + 1, '2.2 연결은 원장에 1건 (다른 기기가 받음)');
select t.push(:'ws', t.link('project_files', 'UPSERT', jsonb_build_object('project_id', :'pa', 'asset_id', :'f1'))) as r \gset
select t.ok((:'r'::jsonb -> 'results' -> 0 ->> 'unchanged')::boolean and t.seq(:'ws') = :s1 + 1, '2.3 이미 연결 → 변화 없음, 순번 안 씀', :'r');
select t.push(:'ws', t.link('project_files', 'UPSERT', jsonb_build_object('project_id', :'pa', 'asset_id', :'fp'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%AVAILABLE%', '2.4 업로드 확인 전 파일 → 거절', :'r');
select t.push(:'ws', t.link('project_files', 'UPSERT', jsonb_build_object('project_id', :'pa', 'asset_id', :'fo'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023', '2.5 다른 공간 파일 → 거절', :'r');
select t.push(:'ws', t.link('project_files', 'UPSERT', jsonb_build_object('project_id', :'pa'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%project_files: project_id·asset_id%', '2.6 키 빠짐 → 안내 문구', :'r');
-- 다른 프로젝트로 옮기기 = 한 묶음에 해제 + 연결
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'project_files', 'op', 'DELETE', 'data', jsonb_build_object('project_id', :'pa', 'asset_id', :'f1')),
  jsonb_build_object('entity', 'project_files', 'op', 'UPSERT', 'data', jsonb_build_object('project_id', :'pb', 'asset_id', :'f1')))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED'
        and not exists (select 1 from public.project_files where project_id = :'pa')
        and exists (select 1 from public.project_files where project_id = :'pb' and asset_id = :'f1'), '2.7 다른 프로젝트로 옮기기 (해제 + 연결 한 묶음)', :'r');
select t.push(:'ws', t.link('project_files', 'UPSERT', jsonb_build_object('project_id', :'pb', 'asset_id', :'f2'))) as r \gset
select public.sync_pull(:'ws', :s1, 100) as pl \gset
select t.ok((select count(*) from jsonb_array_elements(:'pl'::jsonb -> 'changes') c where c ->> 'entity' = 'project_files') = 4
        and exists (select 1 from jsonb_array_elements(:'pl'::jsonb -> 'changes') c where c ->> 'entity' = 'project_files' and c ->> 'op' = 'DELETE'),
        '2.8 다른 기기는 sync_pull로 연결·해제를 받음');
select public.sync_snapshot(:'ws') as sn \gset
select t.ok(jsonb_array_length(:'sn'::jsonb -> 'project_files') = 2, '2.9 전체 받기에도 프로젝트 파일 포함');
:as_out
select t.ok((select count(*) = 0 from public.project_files where workspace_id = :'ws'), '2.10 외부인은 프로젝트 파일 안 보임');
select t.err(format('insert into public.project_files (workspace_id, project_id, asset_id, added_by) values (%L, %L, %L, %L)', :'ws', :'pa', :'f2', :'out'),
        '42501', '2.11 앱에서 직접 연결 불가 (sync_push로만)');
:as_svc
select public.asset_delete(:'ed', :'f2') \gset
:as_ed
select t.ok(exists (select 1 from public.project_files where asset_id = :'f2'), '2.12 파일을 지워도 연결은 남음 (앱이 "삭제된 파일"로 표시)');
:as_own
select t.push(:'ws', t.one('projects', 'DELETE', :'pb', t.rev('projects', :'pb'), '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and exists (select 1 from public.project_files where project_id = :'pb'),
        '2.13 프로젝트를 휴지통에 보내도 연결은 남음 (복구하면 그대로)', :'r');

-- =====================================================================
-- 3. 프로젝트 팀장 권한 (#30)
--    own = 공간 관리자, ld = 편집자(P의 팀장), ed = 편집자(P의 팀원), vw는 나갔음
-- =====================================================================
\set pp '00000000-0000-4000-8000-0000000c0010'
\set pq '00000000-0000-4000-8000-0000000c0011'
\set pr '00000000-0000-4000-8000-0000000c0012'
\set mld '00000000-0000-4000-8000-0000000c1001'
\set med '00000000-0000-4000-8000-0000000c1002'
\set mnm '00000000-0000-4000-8000-0000000c1003'
:as_ld
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'pp', 'data', jsonb_build_object('name', '팀장 프로젝트')),
  jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', :'mld', 'data', jsonb_build_object('project_id', :'pp', 'account_id', :'ld', 'name', '팀장', 'role', '팀장')),
  jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', :'med', 'data', jsonb_build_object('project_id', :'pp', 'account_id', :'ed', 'name', '팀원', 'role', '팀원')))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.1 새 프로젝트 + 나를 팀장으로 + 팀원 추가를 한 묶음에 (팀장이 아직 없으니 허용)', :'r');
:as_ed
select t.seq(:'ws') as s3 \gset
select t.push(:'ws', t.one('projects', 'UPSERT', :'pp', t.rev('projects', :'pp'), jsonb_build_object('name', '팀원이 바꾼 이름'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER'
        and :'r'::jsonb -> 'conflicts' -> 0 -> 'server' ->> 'name' = '팀장 프로젝트' and t.seq(:'ws') = :s3,
        '3.2 팀원이 프로젝트 수정 → 충돌 NOT_PROJECT_LEADER(서버 값 함께), 저장 안 됨', :'r');
select t.push(:'ws', t.one('projects', 'DELETE', :'pp', t.rev('projects', :'pp'), '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER', '3.3 팀원이 프로젝트 삭제 → NOT_PROJECT_LEADER', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', :'mnm', null, jsonb_build_object('project_id', :'pp', 'name', '새 사람'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER' and not (:'r'::jsonb -> 'conflicts' -> 0 ? 'server'),
        '3.4 팀원이 팀원 추가 → NOT_PROJECT_LEADER', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', :'med', t.rev('project_members', :'med'), jsonb_build_object('role', '팀장'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER', '3.5 팀원이 자기를 팀장으로 바꾸기 → 막힘', :'r');
select t.push(:'ws', t.one('project_members', 'DELETE', :'med', t.rev('project_members', :'med'), '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER', '3.6 팀원이 팀원 삭제 → 막힘', :'r');
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', :'n2', 'base_revision', t.rev('notes', :'n2'), 'data', jsonb_build_object('body', '팀원이 고침')),
  jsonb_build_object('entity', 'note_projects', 'op', 'UPSERT', 'data', jsonb_build_object('note_id', :'n2', 'project_id', :'pp')),
  jsonb_build_object('entity', 'project_files', 'op', 'UPSERT', 'data', jsonb_build_object('project_id', :'pp', 'asset_id', :'f1')))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.7 메모 수정·프로젝트에 메모·파일 연결은 지금처럼 공간 권한', :'r');
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', gen_random_uuid(), 'data', jsonb_build_object('title', '같이 보낸 메모')),
  jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'pp', 'base_revision', t.rev('projects', :'pp'), 'data', jsonb_build_object('name', 'x')))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and jsonb_array_length(:'r'::jsonb -> 'conflicts') = 1 and (:'r'::jsonb -> 'conflicts' -> 0 ->> 'index')::int = 1,
        '3.8 묶음 안에 막힌 것이 하나라도 있으면 묶음 전체 충돌 (막힌 op 위치만 표시)', :'r');
select t.push(:'ws', t.one('projects', 'UPSERT', :'pp', 99, jsonb_build_object('name', '오래된 수정'))) as r \gset
select t.ok(jsonb_array_length(:'r'::jsonb -> 'conflicts') = 1 and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'REVISION_MISMATCH',
        '3.8b 이미 다른 충돌(오래된 revision)이 있으면 그 충돌 하나만', :'r');
select t.push(:'ws', t.one('projects', 'UPSERT', :'pr', null, jsonb_build_object('name', '팀원의 새 프로젝트'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.9 팀원도 새 프로젝트는 만들 수 있음', :'r');
select t.err(format('select public.create_project_invite(%L, ''LINK'')', :'pp'), 'FORBIDDEN: 프로젝트 팀장만', '3.10 팀원이 프로젝트 초대 → FORBIDDEN');
select public.get_project_permissions(:'ws') as perm_ed \gset
select t.ok((:'perm_ed'::jsonb ->> :'pp')::boolean = false and (:'perm_ed'::jsonb ->> :'pr')::boolean = true and (:'perm_ed'::jsonb ->> :'pa')::boolean = true,
        '3.11 화면용 권한: 팀장 있는 P는 false, 팀장 없는 프로젝트는 true', :'perm_ed');
:as_vw2
select t.ok(not exists (select 1 from jsonb_each(public.get_project_permissions(:'ws')) e where e.value = 'true'::jsonb),
        '3.11b 보기 전용 멤버는 어느 프로젝트도 관리 불가 (팀장 없는 프로젝트 포함)');
-- 팀장
:as_ld
select t.push(:'ws', t.one('projects', 'UPSERT', :'pp', t.rev('projects', :'pp'), jsonb_build_object('name', '팀장이 바꾼 이름'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.12 팀장은 프로젝트 수정', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', :'med', t.rev('project_members', :'med'), jsonb_build_object('role', '디자이너'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.13 팀장은 팀원 역할 수정', :'r');
select public.create_project_invite(:'pp', 'LINK') as iv \gset
select t.ok(:'iv'::jsonb ->> 'code' is not null, '3.14 팀장은 프로젝트 초대', :'iv');
select t.ok((public.get_project_permissions(:'ws') ->> :'pp')::boolean, '3.15 팀장 화면용 권한 true');
-- 팀원을 다른 프로젝트로 옮기기: 양쪽 모두 관리 권한이 있어야
:as_ld
select t.push(:'ws', t.one('project_members', 'UPSERT', :'med', t.rev('project_members', :'med'), jsonb_build_object('project_id', :'pr'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.16 팀장 → 팀장이 없는 프로젝트로 팀원 이동 가능', :'r');
:as_ed
select t.push(:'ws', t.one('project_members', 'UPSERT', :'med', t.rev('project_members', :'med'), jsonb_build_object('project_id', :'pp'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER', '3.17 팀장이 있는 프로젝트로 옮겨 넣기는 그 팀장만', :'r');
-- 공간 관리자
:as_own
select t.push(:'ws', t.one('projects', 'UPSERT', :'pp', t.rev('projects', :'pp'), jsonb_build_object('description', '관리자 메모'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.18 공간 관리자는 팀장이 아니어도 관리', :'r');
select public.create_project_invite(:'pp', 'LINK') as iv2 \gset
select t.ok(:'iv2'::jsonb ->> 'code' is not null, '3.19 공간 관리자도 프로젝트 초대');
-- 초대 취소: 만든 사람·관리자·팀장
:as_ld
select t.ok(public.revoke_project_invite((:'iv2'::jsonb ->> 'project_invite_id')::uuid) ->> 'status' = 'REVOKED', '3.20 팀장은 관리자가 만든 그 프로젝트 초대도 취소');
:as_own
select public.create_project_invite(:'pp', 'LINK') as iv3 \gset
:as_ed
select t.err(format('select public.revoke_project_invite(%L)', :'iv3'::jsonb ->> 'project_invite_id'), 'FORBIDDEN', '3.21 팀원은 남의 초대 취소 불가');
-- 휴지통에 간 팀장 행은 팀장 아님 (다른 팀장 ed가 있을 때)
\set mle2 '00000000-0000-4000-8000-0000000c1004'
:as_ld
select t.push(:'ws', t.one('project_members', 'UPSERT', :'mle2', null, jsonb_build_object('project_id', :'pp', 'account_id', :'ed', 'name', '둘째 팀장', 'role', '팀장'))) as r \gset
:as_own
select t.push(:'ws', t.one('project_members', 'DELETE', :'mld', t.rev('project_members', :'mld'), '{}'::jsonb)) as r \gset
:as_ld
select t.push(:'ws', t.one('projects', 'UPSERT', :'pp', t.rev('projects', :'pp'), jsonb_build_object('name', '지워진 팀장'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER', '3.21b 팀장 행이 휴지통에 가면 팀장 아님', :'r');
:as_own
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'project_members', 'op', 'DELETE', 'id', :'mle2', 'base_revision', t.rev('project_members', :'mle2'), 'data', '{}'::jsonb),
  jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', gen_random_uuid(), 'data', jsonb_build_object('project_id', :'pp', 'account_id', :'ld', 'name', '팀장', 'role', '팀장')))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.21c 관리자가 팀장을 다시 지정', :'r');
-- 팀장이 계정 없이 이름만이거나 공간을 떠나면 → 팀장 없음 → 다시 편집자 누구나
:as_ld
select t.push(:'ws', t.one('project_members', 'UPSERT', :'mnm', null, jsonb_build_object('project_id', :'pp', 'name', '이름만 팀장', 'role', '팀장'))) as r \gset
select public.leave_workspace(:'ws') \gset
:as_ed
select t.push(:'ws', t.one('projects', 'UPSERT', :'pp', t.rev('projects', :'pp'), jsonb_build_object('name', '팀장이 떠난 뒤'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED',
        '3.22 계정 연결된 팀장이 공간을 떠나면(이름만 팀장 제외) 편집자 누구나 관리 (잠기지 않게)', :'r');
:as_admin
select t.ok(private.can_manage_project(:'ws', :'pp', :'ed') and not private.is_project_leader(:'ws', :'pp', :'ed'), '3.23 권한 함수: 관리 가능 ≠ 팀장');
:as_ed
select t.err($$select private.can_manage_project('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')$$,
        '42501', '3.24 권한 함수는 앱에서 못 부름');
:as_out
select t.err(format('select public.get_project_permissions(%L)', :'ws'), 'FORBIDDEN', '3.25 멤버가 아닌 공간 권한 조회 → FORBIDDEN');

-- =====================================================================
-- 4. 백업·복원 (#31)
-- =====================================================================
\set k1 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
\set k2 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA='
\set b1 '00000000-0000-4000-8000-0000000e0001'
\set b2 '00000000-0000-4000-8000-0000000e0002'
\set b3 '00000000-0000-4000-8000-0000000e0003'
\set bp '00000000-0000-4000-8000-0000000e0004'
:as_ed
select t.err($$select public.backup_key()$$, 'INVALID_REQUEST', '4.1 처음에는 새 키 후보가 필요');
select t.err($$select public.backup_key('짧은키')$$, 'INVALID_REQUEST', '4.2 32바이트 base64가 아니면 거절');
select public.backup_key(:'k1') as bk1 \gset
select t.ok(:'bk1'::jsonb ->> 'key' = :'k1' and (:'bk1'::jsonb ->> 'created')::boolean, '4.3 첫 키 저장', :'bk1');
select public.backup_key(:'k2') as bk2 \gset
select t.ok(:'bk2'::jsonb ->> 'key' = :'k1' and not (:'bk2'::jsonb ->> 'created')::boolean, '4.4 다른 기기가 새 키를 보내도 처음 키 (같은 계정은 키 하나)', :'bk2');
select t.ok(public.backup_key() ->> 'key' = :'k1', '4.5 새 기기: 로그인만 하면 같은 키');
select t.err($$select * from private.backup_keys$$, '42501', '4.6 키 표는 앱에서 직접 못 봄');
:as_own
select t.ok(public.backup_key(:'k2') ->> 'key' = :'k2', '4.7 키는 사람마다 따로');
:as_svc
select public.asset_prepare(:'ed', :'b1', 'BACKUP', null, 'stella-backup', 'application/octet-stream', 100, :'h1') \gset
select public.asset_complete(:'ed', :'b1', 100, :'h1') \gset
select public.asset_prepare(:'ed', :'bp', 'BACKUP', null, 'stella-backup', 'application/octet-stream', 100, :'h1') \gset
:as_ed
select public.backup_register(:'b1', 'MANUAL', '{"memos": 3, "tasks": 2, "projects": 1}', 'Galaxy S25', '1.0.0', 2) as g1 \gset
select t.ok(:'g1'::jsonb ->> 'ok' = 'true' and :'g1'::jsonb -> 'backup' ->> 'kind' = 'MANUAL' and (:'g1'::jsonb -> 'backup' ->> 'auto')::boolean = false
        and (:'g1'::jsonb -> 'backup' -> 'counts' ->> 'memos')::int = 3 and (:'g1'::jsonb -> 'backup' ->> 'size_bytes')::int = 100
        and jsonb_array_length(:'g1'::jsonb -> 'remove_asset_ids') = 0 and (:'g1'::jsonb ->> 'count')::int = 1,
        '4.8 업로드한 백업 등록 (기록 수·크기·기기 이름)', :'g1');
select public.backup_register(:'b1', 'AUTO') as g1b \gset
select t.ok((:'g1b'::jsonb ->> 'replayed')::boolean and :'g1b'::jsonb -> 'backup' ->> 'kind' = 'MANUAL', '4.9 같은 파일 다시 등록 → 처음 결과', :'g1b');
select t.err(format('select public.backup_register(%L)', :'bp'), 'NOT_UPLOADED', '4.10 업로드 확인 전 → NOT_UPLOADED');
select t.err(format('select public.backup_register(%L)', :'f1'), 'NOT_FOUND', '4.11 첨부(백업 아님) → NOT_FOUND');
select t.err(format('select public.backup_register(%L, ''WEEKLY'')', :'b1'), 'INVALID_REQUEST', '4.12 kind는 MANUAL·AUTO');
select t.err(format('select public.backup_register(%L, ''MANUAL'', ''{"memos": "많음"}'')', :'b1'), 'INVALID_REQUEST', '4.13 counts는 숫자만');
select t.err(format('select public.backup_register(%L, ''MANUAL'', ''{}'', null, null, 0)', :'b1'), 'INVALID_REQUEST', '4.14 보관 개수 0 → 거절');
:as_own
select t.err(format('select public.backup_register(%L)', :'b1'), 'NOT_FOUND', '4.15 남의 백업 등록 불가');
select t.ok(jsonb_array_length(public.list_backups()) = 0, '4.16 남의 백업 목록 안 보임');
\set bo '00000000-0000-4000-8000-0000000e00f0'
:as_svc
select public.asset_prepare(:'own', :'bo', 'BACKUP', null, null, 'application/octet-stream', 100, :'h1') \gset
select public.asset_complete(:'own', :'bo', 100, :'h1') \gset
:as_own
select public.backup_register(:'bo') \gset
-- 보관 개수(keep) 넘으면 가장 오래된 것부터 지울 목록
:as_svc
select public.asset_prepare(:'ed', :'b2', 'BACKUP', null, null, 'application/octet-stream', 100, :'h1') \gset
select public.asset_complete(:'ed', :'b2', 100, :'h1') \gset
select public.asset_prepare(:'ed', :'b3', 'BACKUP', null, null, 'application/octet-stream', 100, :'h1') \gset
select public.asset_complete(:'ed', :'b3', 100, :'h1') \gset
:as_admin
update public.backups set created_at = now() - interval '2 hours' where asset_id = :'b1';
:as_ed
select public.backup_register(:'b2', 'AUTO', '{"memos": 4}', null, null, 2) as g2 \gset
select t.ok(jsonb_array_length(:'g2'::jsonb -> 'remove_asset_ids') = 0 and (:'g2'::jsonb -> 'backup' ->> 'auto')::boolean, '4.17 자동 백업(복원 전) 등록, 아직 2개', :'g2');
select public.backup_register(:'b3', 'MANUAL', '{"memos": 5}', null, null, 2) as g3 \gset
select t.ok(:'g3'::jsonb -> 'remove_asset_ids' = jsonb_build_array(:'b1') and (:'g3'::jsonb ->> 'count')::int = 3,
        '4.18 보관 2개를 넘으면 가장 오래된 백업 id를 돌려줌 (앱이 지움)', :'g3');
select public.list_backups() as lb \gset
select t.ok(jsonb_array_length(:'lb'::jsonb) = 3 and :'lb'::jsonb -> 0 ->> 'id' = :'b3' and :'lb'::jsonb -> 2 ->> 'id' = :'b1'
        and :'lb'::jsonb -> 0 ->> 'bucket_id' = 'backups', '4.19 목록 최신순 (받을 경로 포함)', :'lb');
select t.ok(public.list_backups('old') -> 0 ->> 'id' = :'b1', '4.20 오래된순');
:as_svc
select public.asset_delete(:'ed', :'b1') \gset
:as_ed
select t.ok(jsonb_array_length(public.list_backups()) = 2 and not exists (select 1 from jsonb_array_elements(public.list_backups()) x where x ->> 'id' = :'b1'),
        '4.21 지운 백업은 목록에서 빠짐');
select public.backup_register(:'b3', 'MANUAL', '{}', null, null, 1) as g4 \gset
select t.ok(:'g4'::jsonb -> 'remove_asset_ids' = jsonb_build_array(:'b2'), '4.22 다시 등록해도 보관 개수 계산 (방금 것은 남김)', :'g4');
select t.ok((select count(*) = 3 from public.backups), '4.23 내 백업 행만 조회 (RLS, 관리자 백업 1개는 안 보임)');
select public.backup_register(:'b2', 'AUTO', '{}', null, null, 1) as g5 \gset
select t.ok(jsonb_array_length(:'g5'::jsonb -> 'remove_asset_ids') = 0, '4.23b 예전 백업을 다시 등록해도 그 백업은 지울 목록에 안 넣음', :'g5');
select t.err(format('insert into public.backups (asset_id, account_id, kind) values (%L, %L, ''MANUAL'')', :'bp', :'ed'), '42501', '4.24 앱에서 직접 등록 불가');
:as_anon
select t.err($$select public.list_backups()$$, '42501', '4.25 비로그인 → 실행 권한 없음');
:as_admin
select t.ok((select count(*) = 1 from public.backups where account_id = :'own'), '4.26 관리자 백업은 관리자 것으로 따로');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
