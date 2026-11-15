-- 공유 휴지통 (#32): 전 항목 복구 · 영구 삭제(PURGE) · 30일 뒤 자동 영구 삭제 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_trash.sql | grep -E "TOTAL|FAIL"
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
create function t.push(p_ws uuid, p_ops jsonb, p_op uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.sync_push(p_ws, p_op, p_ops);
exception when others then
  return jsonb_build_object('error', sqlstate, 'msg', sqlerrm);
end $$;
create function t.one(p_entity text, p_op text, p_id uuid, p_base bigint, p_data jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('entity', p_entity, 'op', p_op, 'id', p_id, 'data', p_data)
         || case when p_base is null then '{}'::jsonb else jsonb_build_object('base_revision', p_base) end)
$$;
create function t.op(p_entity text, p_op text, p_id uuid, p_base bigint, p_data jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select jsonb_build_object('entity', p_entity, 'op', p_op, 'id', p_id, 'data', p_data)
         || case when p_base is null then '{}'::jsonb else jsonb_build_object('base_revision', p_base) end
$$;
create function t.rev(p_table text, p_id uuid) returns bigint language plpgsql security definer as $$
declare r bigint; begin execute format('select revision from public.%I where id = $1', p_table) into r using p_id; return r; end $$;
create function t.exists_row(p_table text, p_id uuid) returns boolean language plpgsql security definer as $$
declare r boolean; begin execute format('select exists (select 1 from public.%I where id = $1)', p_table) into r using p_id; return r; end $$;
create function t.seq(p_ws uuid) returns bigint language sql security definer as $$
  select last_seq from public.workspace_sync_heads where workspace_id = p_ws $$;
-- 원장 seq > p_after 에서 (entity, key, op) 줄이 있는지
create function t.logged(p_ws uuid, p_after bigint, p_entity text, p_key text, p_op text) returns boolean language sql security definer as $$
  select exists (select 1 from public.workspace_changes
                  where workspace_id = p_ws and seq > p_after and entity_table = p_entity and entity_key = p_key and op = p_op) $$;
create function t.gapless(p_ws uuid) returns boolean language sql security definer as $$
  select count(*) = max(seq) and min(seq) = 1 and max(seq) = (select last_seq from public.workspace_sync_heads where workspace_id = p_ws)
    from public.workspace_changes where workspace_id = p_ws $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set own '00000000-0000-4000-8000-0000000000e0'
\set ed  '00000000-0000-4000-8000-0000000000e1'
\set ed2 '00000000-0000-4000-8000-0000000000e2'
\set vw  '00000000-0000-4000-8000-0000000000e3'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', 'to@test.dev', '{"name":"관리자"}'),
  (:'ed',  'te@test.dev', '{"name":"멤버1"}'),
  (:'ed2', 'te2@test.dev', '{"name":"멤버2"}'),
  (:'vw',  'tv@test.dev', '{"name":"보기"}');

\set as_own  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000e0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_ed   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000e1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_ed2  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000e2'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_vw   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000e3'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

\set p1 '00000000-0000-4000-8000-00000000f001'
\set p2 '00000000-0000-4000-8000-00000000f002'
\set n1 '00000000-0000-4000-8000-00000000f011'
\set n2 '00000000-0000-4000-8000-00000000f012'
\set k1 '00000000-0000-4000-8000-00000000f021'
\set k2 '00000000-0000-4000-8000-00000000f022'
\set e1 '00000000-0000-4000-8000-00000000f031'
\set m1 '00000000-0000-4000-8000-00000000f041'
\set m2 '00000000-0000-4000-8000-00000000f042'
\set a1 '00000000-0000-4000-8000-00000000f051'
\set a2 '00000000-0000-4000-8000-00000000f052'
\set a3 '00000000-0000-4000-8000-00000000f053'
\set pm1 '00000000-0000-4000-8000-00000000f061'
\set pm2 '00000000-0000-4000-8000-00000000f062'
\set pm3 '00000000-0000-4000-8000-00000000f063'
\set f1 '00000000-0000-4000-8000-00000000f071'
\set h1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

:as_own
select public.create_workspace('휴지통 공간') as ws \gset
select (public.create_invite(:'ws', 'EDITOR', 24, 2)) ->> 'code' as c_ed \gset
select (public.create_invite(:'ws', 'VIEWER', 24, 1)) ->> 'code' as c_vw \gset
:as_ed
select public.accept_invite(:'c_ed') is not null as x \gset
:as_ed2
select public.accept_invite(:'c_ed') is not null as x \gset
:as_vw
select public.accept_invite(:'c_vw') is not null as x \gset

:as_admin
select public.asset_prepare(:'ed', :'f1', 'ATTACHMENT', :'ws', '자료.pdf', 'application/pdf', 5, :'h1') is not null as x \gset
select public.asset_complete(:'ed', :'f1', 5, :'h1') is not null as x \gset

-- 준비: 프로젝트 P1(팀장 없음) · P2(팀장 = 멤버2) · 메모 N1(P1 연결, 첨부, 할 일·일정이 가리킴) · 회의 M1(안건 A1) · M2(A2 = A1 이월)
:as_ed
select t.push(:'ws', jsonb_build_array(
  t.op('projects', 'UPSERT', :'p1', null, '{"name":"발표"}'),
  t.op('projects', 'UPSERT', :'p2', null, '{"name":"개발"}'),
  t.op('project_members', 'UPSERT', :'pm2', null, jsonb_build_object('project_id', :'p2', 'account_id', :'ed2', 'name', '멤버2', 'role', '팀장')),
  t.op('project_members', 'UPSERT', :'pm1', null, jsonb_build_object('project_id', :'p1', 'name', '외부 협력자')),
  t.op('project_members', 'UPSERT', :'pm3', null, jsonb_build_object('project_id', :'p1', 'name', '초대 받을 사람')),
  t.op('notes', 'UPSERT', :'n1', null, '{"title":"회의 준비","body":"자료"}'),
  t.op('notes', 'UPSERT', :'n2', null, '{"title":"두 번째","body":""}'),
  t.op('tasks', 'UPSERT', :'k1', null, jsonb_build_object('title', '슬라이드', 'note_id', :'n1', 'project_id', :'p1')),
  t.op('tasks', 'UPSERT', :'k2', null, '{"title":"따로 할 일"}'),
  t.op('events', 'UPSERT', :'e1', null, jsonb_build_object('title', '리허설', 'note_id', :'n1', 'project_id', :'p1',
        'start_at', '2026-11-20T10:00:00+09:00', 'end_at', '2026-11-20T11:00:00+09:00')),
  t.op('meetings', 'UPSERT', :'m1', null, jsonb_build_object('title', '1차 회의', 'project_id', :'p1')),
  t.op('meetings', 'UPSERT', :'m2', null, jsonb_build_object('title', '2차 회의', 'project_id', :'p1')),
  t.op('agenda_items', 'UPSERT', :'a1', null, jsonb_build_object('meeting_id', :'m1', 'title', '예산')),
  t.op('agenda_items', 'UPSERT', :'a3', null, jsonb_build_object('meeting_id', :'m1', 'title', '일정'))
) || t.op('note_projects', 'UPSERT', null, null, jsonb_build_object('note_id', :'n1', 'project_id', :'p1'))
  || jsonb_build_object('entity', 'note_attachments', 'op', 'UPSERT', 'data', jsonb_build_object('note_id', :'n1', 'asset_id', :'f1'))
  || jsonb_build_object('entity', 'project_files', 'op', 'UPSERT', 'data', jsonb_build_object('project_id', :'p1', 'asset_id', :'f1'))
) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '0.1 준비 저장', :'r');
select t.push(:'ws', t.one('agenda_items', 'UPSERT', :'a2', null, jsonb_build_object('meeting_id', :'m2', 'title', '예산(이월)', 'carried_from_id', :'a1'))) ->> 'status' as x \gset
select t.push(:'ws', t.one('agenda_items', 'UPSERT', :'a1', 1, '{"status":"DISCUSSED"}')) ->> 'status' as x \gset
select public.set_note_favorites(:'ws', array[:'n1'::uuid], true) ->> 'changed' as x \gset
select public.create_project_invite(:'p1', 'LINK') as inv \gset
select (:'inv'::jsonb ->> 'code') as inv_code, (:'inv'::jsonb ->> 'project_invite_id') as pinv \gset
:as_admin
update public.project_invites set member_id = :'pm3' where id = :'pinv';
select t.ok((select count(*) = 1 from public.agenda_transitions where agenda_item_id = :'a1'), '0.2 준비: 안건 상태 이력 1개');

-- ---------------------------------------------------------------------
-- 1. 복구 (RESTORE) — 7가지 모두
-- ---------------------------------------------------------------------
:as_ed
select t.push(:'ws', jsonb_build_array(
  t.op('tasks', 'DELETE', :'k2', t.rev('tasks', :'k2')),
  t.op('events', 'DELETE', :'e1', t.rev('events', :'e1')),
  t.op('meetings', 'DELETE', :'m2', t.rev('meetings', :'m2')),
  t.op('agenda_items', 'DELETE', :'a3', t.rev('agenda_items', :'a3')),
  t.op('project_members', 'DELETE', :'pm1', t.rev('project_members', :'pm1')),
  t.op('projects', 'DELETE', :'p1', t.rev('projects', :'p1')))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '1.1 여러 가지 휴지통으로', :'r');
select t.seq(:'ws') as s1 \gset
select t.push(:'ws', jsonb_build_array(
  t.op('tasks', 'RESTORE', :'k2', t.rev('tasks', :'k2')),
  t.op('events', 'RESTORE', :'e1', t.rev('events', :'e1')),
  t.op('meetings', 'RESTORE', :'m2', t.rev('meetings', :'m2')),
  t.op('agenda_items', 'RESTORE', :'a3', t.rev('agenda_items', :'a3')),
  t.op('project_members', 'RESTORE', :'pm1', t.rev('project_members', :'pm1')),
  t.op('projects', 'RESTORE', :'p1', t.rev('projects', :'p1')))) as r \gset
:as_admin
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED'
  and (select count(*) = 0 from (
         select deleted_at from public.tasks where id = :'k2' union all select deleted_at from public.events where id = :'e1'
         union all select deleted_at from public.meetings where id = :'m2' union all select deleted_at from public.agenda_items where id = :'a3'
         union all select deleted_at from public.project_members where id = :'pm1' union all select deleted_at from public.projects where id = :'p1') x
        where deleted_at is not null),
  '1.2 할 일·일정·회의·안건·팀원·프로젝트 복구 (#32 전에는 메모만)', :'r');
select t.ok((select count(*) = 6 from public.workspace_changes where workspace_id = :'ws' and seq > :s1 and op = 'UPSERT'
               and (data ->> 'deleted_at') is null), '1.3 복구도 원장에 (다른 기기 휴지통에서 빠짐)');
:as_ed
select t.push(:'ws', t.one('tasks', 'RESTORE', :'k2', t.rev('tasks', :'k2'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_DELETED', '1.4 휴지통에 없는 것 복구 → 충돌 NOT_DELETED', :'r');
select t.push(:'ws', jsonb_build_array(jsonb_build_object('entity', 'note_projects', 'op', 'RESTORE', 'data', '{}'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%휴지통 대상%', '1.5 연결은 복구 대상 아님 → INVALID_REQUEST', :'r');
select t.push(:'ws', t.one('tasks', 'DELETE', :'k2', t.rev('tasks', :'k2'))) ->> 'status' as x \gset
select t.push(:'ws', t.one('tasks', 'RESTORE', :'k2', t.rev('tasks', :'k2'), '{"title":"바꿈"}')) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023', '1.6 복구 + 데이터 → INVALID_REQUEST', :'r');
:as_vw
select t.push(:'ws', t.one('tasks', 'RESTORE', :'k2', t.rev('tasks', :'k2'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '42501' or :'r'::jsonb ->> 'msg' like 'FORBIDDEN%', '1.7 보기 전용은 복구 불가', :'r');
:as_ed2
select t.push(:'ws', t.one('tasks', 'RESTORE', :'k2', t.rev('tasks', :'k2'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '1.8 다른 멤버가 지운 것도 멤버 누구나 복구', :'r');

-- 팀장 있는 프로젝트(P2): 팀장이 아닌 멤버는 복구 불가 (#30 규칙)
:as_ed2
select t.push(:'ws', t.one('projects', 'DELETE', :'p2', t.rev('projects', :'p2'))) ->> 'status' as x \gset
:as_ed
select t.push(:'ws', t.one('projects', 'RESTORE', :'p2', t.rev('projects', :'p2'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER', '1.9 팀장 있는 프로젝트 복구는 팀장·관리자만 (충돌)', :'r');

-- ---------------------------------------------------------------------
-- 2. 영구 삭제 (PURGE) 권한
-- ---------------------------------------------------------------------
:as_ed
select t.push(:'ws', t.one('tasks', 'PURGE', :'k2', t.rev('tasks', :'k2'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_DELETED', '2.1 휴지통에 없는 것 영구 삭제 → 충돌 NOT_DELETED', :'r');
select t.push(:'ws', t.one('tasks', 'DELETE', :'k2', t.rev('tasks', :'k2'))) ->> 'status' as x \gset
select t.push(:'ws', jsonb_build_array(jsonb_build_object('entity', 'tasks', 'op', 'PURGE', 'id', :'k2', 'data', '{}'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%base_revision%', '2.2 base_revision 없이 → INVALID_REQUEST', :'r');
:as_ed2
select t.push(:'ws', t.one('tasks', 'PURGE', :'k2', t.rev('tasks', :'k2'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'PURGE_NOT_ALLOWED'
  and :'r'::jsonb -> 'conflicts' -> 0 -> 'server' ->> 'id' = :'k2' and t.exists_row('tasks', :'k2'),
  '2.3 지운 사람이 아닌 멤버 → 충돌 PURGE_NOT_ALLOWED (서버 값 포함, 그대로 남음)', :'r');
:as_ed
select t.seq(:'ws') as s2 \gset
select t.push(:'ws', t.one('tasks', 'PURGE', :'k2', t.rev('tasks', :'k2'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and (:'r'::jsonb -> 'results' -> 0 ->> 'purged')::boolean
  and not t.exists_row('tasks', :'k2') and t.logged(:'ws', :s2, 'tasks', :'k2', 'DELETE'),
  '2.4 지운 사람 → 영구 삭제 + 원장 DELETE', :'r');
:as_ed2
select t.push(:'ws', t.one('meetings', 'DELETE', :'m2', t.rev('meetings', :'m2'))) ->> 'status' as x \gset
:as_own
select t.push(:'ws', t.one('meetings', 'PURGE', :'m2', t.rev('meetings', :'m2'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and not t.exists_row('meetings', :'m2')
  and not t.exists_row('agenda_items', :'a2'), '2.5 공간 관리자는 남이 지운 것도 영구 삭제 (회의 → 안건도)', :'r');
:as_vw
select t.push(:'ws', t.one('notes', 'PURGE', :'n2', 1)) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '42501' or :'r'::jsonb ->> 'msg' like 'FORBIDDEN%', '2.6 보기 전용은 영구 삭제 불가', :'r');
:as_ed
select t.push(:'ws', jsonb_build_array(jsonb_build_object('entity', 'input_sources', 'op', 'PURGE', 'id', :'n2', 'base_revision', 1, 'data', '{}'::jsonb))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%휴지통 대상%', '2.7 원문은 영구 삭제 대상 아님', :'r');
-- 팀장 있는 P2: 팀장(지운 사람)만
select t.push(:'ws', t.one('projects', 'PURGE', :'p2', t.rev('projects', :'p2'))) as r \gset
select t.ok(:'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER', '2.8 팀장 있는 프로젝트는 팀장 규칙이 먼저 (충돌)', :'r');
:as_ed2
select t.push(:'ws', t.one('projects', 'PURGE', :'p2', t.rev('projects', :'p2'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and not t.exists_row('projects', :'p2') and not t.exists_row('project_members', :'pm2'),
  '2.9 팀장이 지운 자기 프로젝트 영구 삭제 → 팀원도 같이', :'r');

-- ---------------------------------------------------------------------
-- 3. 메모 영구 삭제: 연결 정리
-- ---------------------------------------------------------------------
:as_ed
select t.push(:'ws', t.one('notes', 'DELETE', :'n1', t.rev('notes', :'n1'))) ->> 'status' as x \gset
select t.rev('tasks', :'k1') as k1rev \gset
select t.seq(:'ws') as s3 \gset
select t.push(:'ws', t.one('notes', 'PURGE', :'n1', t.rev('notes', :'n1'))) as r \gset
:as_admin
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and not t.exists_row('notes', :'n1'), '3.1 메모 영구 삭제', :'r');
select t.ok((select note_id is null and project_id = :'p1' and revision = :k1rev + 1 from public.tasks where id = :'k1')
  and t.logged(:'ws', :s3, 'tasks', :'k1', 'UPSERT'), '3.2 메모를 가리키던 할 일은 남고 연결만 끊김 (버전 +1, 원장)');
select t.ok((select note_id is null from public.events where id = :'e1') and t.logged(:'ws', :s3, 'events', :'e1', 'UPSERT'), '3.3 일정도 같음');
select t.ok(not exists (select 1 from public.note_projects where note_id = :'n1')
  and t.logged(:'ws', :s3, 'note_projects', :'n1' || ':' || :'p1', 'DELETE'), '3.4 메모↔프로젝트 연결 지움 + 원장 (키 note:project)');
select t.ok(not exists (select 1 from public.note_attachments where note_id = :'n1')
  and t.logged(:'ws', :s3, 'note_attachments', :'n1' || ':' || :'f1', 'DELETE')
  and (select status = 'AVAILABLE' from public.assets where id = :'f1'), '3.5 첨부 연결 지움 (첨부 파일은 남음)');
select t.ok(not exists (select 1 from public.note_favorites where note_id = :'n1'), '3.6 즐겨찾기도 정리');
select t.ok(t.gapless(:'ws'), '3.7 원장 순번 빈틈 없음 (head = 마지막 seq)');

-- ---------------------------------------------------------------------
-- 4. 안건·회의·팀원
-- ---------------------------------------------------------------------
:as_ed
select t.push(:'ws', t.one('meetings', 'UPSERT', :'m2', null, jsonb_build_object('title', '3차 회의'))) as x \gset
\set m3 '00000000-0000-4000-8000-00000000f043'
\set a4 '00000000-0000-4000-8000-00000000f054'
select t.push(:'ws', jsonb_build_array(
  t.op('meetings', 'UPSERT', :'m3', null, '{"title":"3차 회의"}'),
  t.op('agenda_items', 'UPSERT', :'a4', null, jsonb_build_object('meeting_id', :'m3', 'title', '예산(다시 이월)', 'carried_from_id', :'a1')))) ->> 'status' as x \gset
select t.push(:'ws', t.one('agenda_items', 'DELETE', :'a1', t.rev('agenda_items', :'a1'))) ->> 'status' as x \gset
select t.seq(:'ws') as s4 \gset
select t.push(:'ws', t.one('agenda_items', 'PURGE', :'a1', t.rev('agenda_items', :'a1'))) as r \gset
:as_admin
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and not t.exists_row('agenda_items', :'a1')
  and not exists (select 1 from public.agenda_transitions where agenda_item_id = :'a1'), '4.1 안건 영구 삭제 + 상태 이력', :'r');
select t.ok((select carried_from_id is null from public.agenda_items where id = :'a4')
  and t.logged(:'ws', :s4, 'agenda_items', :'a4', 'UPSERT')
  and exists (select 1 from public.workspace_changes where workspace_id = :'ws' and seq > :s4 and entity_table = 'agenda_transitions' and op = 'DELETE'),
  '4.2 이월받은 안건은 남고 이월 원본만 끊김, 이력 삭제도 원장');
:as_ed
select t.push(:'ws', t.one('project_members', 'DELETE', :'pm3', t.rev('project_members', :'pm3'))) ->> 'status' as x \gset
select t.seq(:'ws') as s5 \gset
select t.push(:'ws', t.one('project_members', 'PURGE', :'pm3', t.rev('project_members', :'pm3'))) as r \gset
:as_admin
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and (select member_id is null from public.project_invites where id = :'pinv')
  and t.logged(:'ws', :s5, 'project_invites', :'pinv', 'UPSERT'), '4.3 팀원 영구 삭제 → 그 팀원을 가리키던 초대는 연결만 끊김', :'r');

-- ---------------------------------------------------------------------
-- 5. 프로젝트 영구 삭제: 할 일·일정·회의는 남고, 팀원·초대·파일·연결은 지움
-- ---------------------------------------------------------------------
:as_ed
select t.push(:'ws', t.one('projects', 'DELETE', :'p1', t.rev('projects', :'p1'))) ->> 'status' as x \gset
select t.seq(:'ws') as s6 \gset
select t.push(:'ws', t.one('projects', 'PURGE', :'p1', t.rev('projects', :'p1'))) as r \gset
:as_admin
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED' and not t.exists_row('projects', :'p1'), '5.1 프로젝트 영구 삭제', :'r');
select t.ok((select project_id is null from public.tasks where id = :'k1') and (select project_id is null from public.events where id = :'e1')
  and (select project_id is null from public.meetings where id = :'m1') and t.logged(:'ws', :s6, 'meetings', :'m1', 'UPSERT'),
  '5.2 할 일·일정·회의는 남고 프로젝트 연결만 끊김');
select t.ok(not exists (select 1 from public.project_members where project_id = :'p1')
  and t.logged(:'ws', :s6, 'project_members', :'pm1', 'DELETE'), '5.3 팀원 삭제 + 원장');
select t.ok(not exists (select 1 from public.project_files where project_id = :'p1')
  and t.logged(:'ws', :s6, 'project_files', :'p1' || ':' || :'f1', 'DELETE'), '5.4 프로젝트 파일 연결 삭제 + 원장');
select t.ok(not exists (select 1 from public.project_invites where id = :'pinv') and t.logged(:'ws', :s6, 'project_invites', :'pinv', 'DELETE')
  and (select status = 'REVOKED' from public.workspace_invites wi where wi.id = (select id from public.workspace_invites where workspace_id = :'ws' order by created_at desc limit 1)),
  '5.5 대기 중 프로젝트 초대 삭제 + 그 공간 초대 코드는 취소');
:as_vw
select t.err(format('select public.join_with_invite(%L)', :'inv_code'), 'INVITE_', '5.6 취소된 초대 코드로는 참여 불가');
:as_admin
select t.ok(t.gapless(:'ws'), '5.7 원장 순번 빈틈 없음');

-- ---------------------------------------------------------------------
-- 6. 한 묶음에 섞기 · 재전송 · 받기
-- ---------------------------------------------------------------------
\set n3 '00000000-0000-4000-8000-00000000f013'
\set opx '00000000-0000-4000-8000-00000000faaa'
:as_ed
select t.push(:'ws', t.one('tasks', 'DELETE', :'k1', t.rev('tasks', :'k1'))) ->> 'status' as x \gset
select t.seq(:'ws') as s7 \gset
select jsonb_build_array(
  t.op('notes', 'UPSERT', :'n3', null, '{"title":"앞","body":""}'),
  t.op('tasks', 'PURGE', :'k1', t.rev('tasks', :'k1')),
  t.op('notes', 'UPSERT', :'n2', 1, '{"title":"뒤"}')) as ops6 \gset
select t.push(:'ws', :'ops6'::jsonb, :'opx') as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED'
  and (:'r'::jsonb -> 'results' -> 0 ->> 'seq')::bigint < (:'r'::jsonb -> 'results' -> 1 ->> 'seq')::bigint
  and (:'r'::jsonb -> 'results' -> 1 ->> 'seq')::bigint < (:'r'::jsonb -> 'results' -> 2 ->> 'seq')::bigint
  and (:'r'::jsonb ->> 'last_seq')::bigint = t.seq(:'ws') and t.gapless(:'ws'),
  '6.1 만들기·영구 삭제·수정 한 묶음 → 순번이 순서대로, 빈틈 없음', :'r');
select t.push(:'ws', :'ops6'::jsonb, :'opx') as r2 \gset
select t.ok((:'r2'::jsonb ->> 'replayed')::boolean or (:'r2'::jsonb -> 'results') = (:'r'::jsonb -> 'results'), '6.2 같은 operation_id 재전송 → 처음 결과', :'r2');
select public.sync_pull(:'ws', :s7, 100) as pl \gset
select t.ok(exists (select 1 from jsonb_array_elements(:'pl'::jsonb -> 'changes') c
                     where c ->> 'entity' = 'tasks' and c ->> 'key' = :'k1' and c ->> 'op' = 'DELETE'),
  '6.3 다른 기기 받기(sync_pull)에 영구 삭제가 DELETE로', :'pl');
select public.sync_snapshot(:'ws') as sn \gset
select t.ok(not exists (select 1 from jsonb_array_elements(:'sn'::jsonb -> 'tasks') x where x ->> 'id' = :'k1')
  and exists (select 1 from jsonb_array_elements(:'sn'::jsonb -> 'notes') x where x ->> 'id' = :'n3'), '6.4 전체 받기에 영구 삭제된 것 없음 (새 메모는 있음)');

-- ---------------------------------------------------------------------
-- 7. 30일 뒤 자동 영구 삭제 (cron)
-- ---------------------------------------------------------------------
\set n4 '00000000-0000-4000-8000-00000000f014'
\set n5 '00000000-0000-4000-8000-00000000f015'
\set m4 '00000000-0000-4000-8000-00000000f044'
\set a5 '00000000-0000-4000-8000-00000000f055'
:as_ed
select t.push(:'ws', jsonb_build_array(
  t.op('notes', 'UPSERT', :'n4', null, '{"title":"오래된","body":""}'),
  t.op('notes', 'UPSERT', :'n5', null, '{"title":"29일","body":""}'),
  t.op('meetings', 'UPSERT', :'m4', null, '{"title":"오래된 회의"}'),
  t.op('agenda_items', 'UPSERT', :'a5', null, jsonb_build_object('meeting_id', :'m4', 'title', '오래된 안건')))) ->> 'status' as x \gset
select t.push(:'ws', jsonb_build_array(
  t.op('notes', 'DELETE', :'n4', 1), t.op('notes', 'DELETE', :'n5', 1),
  t.op('meetings', 'DELETE', :'m4', 1), t.op('agenda_items', 'DELETE', :'a5', 1))) ->> 'status' as x \gset
select t.err('select private.trash_purge_expired()', '42501', '7.1 앱은 자동 삭제 함수를 못 부름');
:as_admin
update public.notes set deleted_at = now() - interval '31 days' where id = :'n4';
update public.notes set deleted_at = now() - interval '29 days' where id = :'n5';
update public.meetings set deleted_at = now() - interval '40 days' where id = :'m4';
update public.agenda_items set deleted_at = now() - interval '40 days' where id = :'a5';
select t.seq(:'ws') as s8 \gset
select private.trash_purge_expired() as purged \gset
select t.ok(:purged = 3 and not t.exists_row('notes', :'n4') and t.exists_row('notes', :'n5')
  and not t.exists_row('meetings', :'m4') and not t.exists_row('agenda_items', :'a5'),
  '7.2 30일 넘은 것만 영구 삭제 (안건 먼저, 회의 다음), 29일은 남음', :'purged');
select t.ok(t.logged(:'ws', :s8, 'notes', :'n4', 'DELETE')
  and (select bool_and(actor_id is null) from public.workspace_changes where workspace_id = :'ws' and seq > :s8),
  '7.3 자동 삭제도 원장에 (행위자 없음)');
select t.ok(t.gapless(:'ws'), '7.4 원장 순번 빈틈 없음');
select private.trash_purge_expired() as purged2 \gset
select t.ok(:purged2 = 0, '7.5 다시 돌려도 지울 것 없음', :'purged2');
select t.ok(exists (select 1 from cron.job where jobname = 'trash-purge-expired' and schedule = '17 18 * * *'), '7.6 cron 등록 (매일 03:17 서울)');
select t.ok(not has_function_privilege('authenticated', 'private.trash_purge(uuid, text, uuid, uuid, uuid)', 'execute'), '7.7 내부 함수 권한 없음');
select t.seq(:'ws') as s9 \gset
select private.trash_purge(:'ws', 'notes', :'n3'::uuid, null, null) as live \gset
select private.trash_purge(:'ws', 'notes', gen_random_uuid(), null, null) as ghost \gset
select t.ok(not :'live'::boolean and not :'ghost'::boolean and t.exists_row('notes', :'n3') and t.seq(:'ws') = :s9,
  '7.8 휴지통에 없는 기록은 내부 함수로도 안 지워짐 (원장 그대로)');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
