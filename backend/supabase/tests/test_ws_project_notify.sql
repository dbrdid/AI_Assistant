-- 워크스페이스·프로젝트 알림 (11/25, 20261125051502) (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_ws_project_notify.sql | grep -E "TOTAL|FAIL"
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
create function t.link(p_note uuid, p_project uuid) returns jsonb
language sql as $$ select jsonb_build_object('entity', 'note_projects', 'op', 'UPSERT', 'data', jsonb_build_object('note_id', p_note, 'project_id', p_project)) $$;
create function t.nc(p_account uuid, p_kind text) returns bigint language sql security definer as $$
  select count(*) from public.notifications where account_id = p_account and kind = p_kind $$;
create function t.last(p_account uuid, p_kind text) returns public.notifications language sql security definer as $$
  select * from public.notifications where account_id = p_account and kind = p_kind order by created_at desc, id desc limit 1 $$;
create function t.rev(p_table text, p_id uuid) returns bigint language plpgsql security definer as $$
declare r bigint; begin execute format('select revision from public.%I where id = $1', p_table) into r using p_id; return r; end $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set own '00000000-0000-4000-8000-000000000c10'
\set a   '00000000-0000-4000-8000-000000000c11'
\set b   '00000000-0000-4000-8000-000000000c12'
\set v   '00000000-0000-4000-8000-000000000c13'
\set c   '00000000-0000-4000-8000-000000000c14'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', 'wo@test.dev', '{"name":"관리자"}'),
  (:'a',   'wa@test.dev', '{"name":"팀원A"}'),
  (:'b',   'wb@test.dev', '{"name":"멤버B"}'),
  (:'v',   'wv@test.dev', '{"name":"보기V"}'),
  (:'c',   'wc@test.dev', '{"name":"나갈C"}');

\set as_own 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000c10'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_a   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000c11'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_b   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000c12'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_v   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000c13'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_c   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000c14'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

\set p1 '00000000-0000-4000-8000-00000000c001'
\set p2 '00000000-0000-4000-8000-00000000c002'
\set p3 '00000000-0000-4000-8000-00000000c003'
\set pm_a '00000000-0000-4000-8000-00000000c011'
\set pm_own '00000000-0000-4000-8000-00000000c012'
\set k1 '00000000-0000-4000-8000-00000000c021'
\set k2 '00000000-0000-4000-8000-00000000c022'
\set k3 '00000000-0000-4000-8000-00000000c023'
\set k4 '00000000-0000-4000-8000-00000000c024'
\set k5 '00000000-0000-4000-8000-00000000c025'
\set k6 '00000000-0000-4000-8000-00000000c026'
\set e1 '00000000-0000-4000-8000-00000000c031'
\set n1 '00000000-0000-4000-8000-00000000c041'

:as_own
select public.create_workspace('팀 공간') as ws \gset
select (public.create_invite(:'ws', 'EDITOR', 24, 3)) ->> 'code' as c_ed \gset
select (public.create_invite(:'ws', 'VIEWER', 24, 1)) ->> 'code' as c_vw \gset
:as_a
select public.accept_invite(:'c_ed') is not null as x \gset
:as_b
select public.accept_invite(:'c_ed') is not null as x \gset
:as_c
select public.accept_invite(:'c_ed') is not null as x \gset
:as_v
select public.accept_invite(:'c_vw') is not null as x \gset

-- ---------------------------------------------------------------------
-- 1. 설정: project
-- ---------------------------------------------------------------------
:as_b
select public.get_notification_settings() as s0 \gset
select t.ok((:'s0'::jsonb ->> 'project')::boolean and :'s0'::jsonb -> 'briefing_daily' ->> 'time' = '09:00',
  '1.1 기본: 프로젝트 소식 켜짐 (일간 브리핑 09:00 그대로)', :'s0');
select public.set_notification_settings('{"project": false}') ->> 'project' as s1 \gset
select t.ok(:'s1' = 'false', '1.2 project 끄기 저장', :'s1');

-- ---------------------------------------------------------------------
-- 2. 워크스페이스: 역할 변경 · 내보내짐 · 스스로 나감
-- ---------------------------------------------------------------------
:as_own
select public.change_member_role(:'ws', :'a', 'VIEWER') is not null as x \gset
:as_admin
select t.ok(t.nc(:'a', 'WORKSPACE_ROLE_CHANGED') = 1 and (t.last(:'a', 'WORKSPACE_ROLE_CHANGED')).body = '내 역할이 보기 전용(으)로 바뀌었어요'
  and (t.last(:'a', 'WORKSPACE_ROLE_CHANGED')).title = '팀 공간' and (t.last(:'a', 'WORKSPACE_ROLE_CHANGED')).workspace_id = :'ws',
  '2.1 역할이 바뀐 멤버에게 알림 (문구·공간)', (t.last(:'a', 'WORKSPACE_ROLE_CHANGED')).body);
select t.ok(t.nc(:'own', 'WORKSPACE_ROLE_CHANGED') = 0, '2.2 바꾼 사람(관리자)은 안 받음');
:as_own
select public.change_member_role(:'ws', :'a', 'EDITOR') is not null as x \gset
:as_admin
select t.ok(t.nc(:'a', 'WORKSPACE_ROLE_CHANGED') = 2 and (t.last(:'a', 'WORKSPACE_ROLE_CHANGED')).body like '%멤버(으)로%', '2.3 다시 바꾸면 또 알림');
:as_own
select public.remove_member(:'ws', :'v') is not null as x \gset
:as_admin
select t.ok(t.nc(:'v', 'WORKSPACE_REMOVED') = 1 and (t.last(:'v', 'WORKSPACE_REMOVED')).workspace_id is null
  and (t.last(:'v', 'WORKSPACE_REMOVED')).data ->> 'workspace_id' = :'ws' and (t.last(:'v', 'WORKSPACE_REMOVED')).data ->> 'type' = 'workspace_closed',
  '2.4 내보내진 사람에게 알림 (workspace_id는 비우고 data에)');
update public.notifications set status = 'SENT', sent_at = now() where account_id = :'v' and kind = 'WORKSPACE_REMOVED';
:as_v
select t.ok(exists (select 1 from jsonb_array_elements(public.list_notifications(50)) x where x ->> 'kind' = 'WORKSPACE_REMOVED'),
  '2.5 내보내진 뒤에도 알림함에 보임');
:as_c
select public.leave_workspace(:'ws') is not null as x \gset
:as_admin
select t.ok(t.nc(:'c', 'WORKSPACE_REMOVED') = 0 and not exists (select 1 from public.notifications where kind like 'WORKSPACE_%' and kind <> 'WORKSPACE_JOINED' and account_id <> :'a' and account_id <> :'v'),
  '2.6 스스로 나간 사람·다른 멤버에게는 알림 없음');

-- ---------------------------------------------------------------------
-- 3. 프로젝트 팀원 추가
-- ---------------------------------------------------------------------
:as_own
select t.push(:'ws', jsonb_build_array(
  t.op('projects', 'UPSERT', :'p1', null, '{"name":"발표 준비"}'),
  t.op('projects', 'UPSERT', :'p2', null, '{"name":"예산"}'),
  t.op('project_members', 'UPSERT', :'pm_own', null, jsonb_build_object('project_id', :'p1', 'account_id', :'own', 'name', '관리자', 'role', '팀장')),
  t.op('project_members', 'UPSERT', :'pm_a', null, jsonb_build_object('project_id', :'p1', 'account_id', :'a', 'name', '팀원A', 'role', '디자이너')),
  t.op('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'account_id', :'b', 'name', '멤버B')),
  t.op('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', '계정 없는 협력자'))
)) ->> 'status' as st \gset
:as_admin
select t.ok(:'st' = 'ACCEPTED', '3.0 준비 (프로젝트 2개 · 팀원 4명)', :'st');
select t.ok(t.nc(:'a', 'PROJECT_MEMBER_ADDED') = 1 and (t.last(:'a', 'PROJECT_MEMBER_ADDED')).title = '발표 준비'
  and (t.last(:'a', 'PROJECT_MEMBER_ADDED')).body = '팀 공간 · 프로젝트 팀원으로 추가됐어요 (디자이너)'
  and (t.last(:'a', 'PROJECT_MEMBER_ADDED')).data ->> 'type' = 'projects' and (t.last(:'a', 'PROJECT_MEMBER_ADDED')).data ->> 'id' = :'p1',
  '3.1 팀원으로 추가된 사람에게 알림 (문구·이동할 곳)', (t.last(:'a', 'PROJECT_MEMBER_ADDED')).body);
select t.ok(t.nc(:'own', 'PROJECT_MEMBER_ADDED') = 0, '3.2 자기 자신을 넣은 관리자는 안 받음');
select t.ok(t.nc(:'b', 'PROJECT_MEMBER_ADDED') = 0, '3.3 프로젝트 소식을 끈 B는 안 받음');
:as_own
select t.push(:'ws', jsonb_build_array(t.op('project_members', 'UPSERT', :'pm_a', t.rev('project_members', :'pm_a'), '{"role":"발표자"}'))) ->> 'status' as x \gset
:as_admin
select t.ok(t.nc(:'a', 'PROJECT_MEMBER_ADDED') = 1, '3.4 역할만 바꾸면 알림 없음', :'x');
:as_own
select t.push(:'ws', jsonb_build_array(t.op('project_members', 'UPSERT', :'pm_a', t.rev('project_members', :'pm_a'), jsonb_build_object('project_id', :'p2')))) ->> 'status' as x \gset
:as_admin
select t.ok(t.nc(:'a', 'PROJECT_MEMBER_ADDED') = 2 and (t.last(:'a', 'PROJECT_MEMBER_ADDED')).title = '예산', '3.5 다른 프로젝트로 옮기면 그 프로젝트로 알림', :'x');
:as_own
select t.push(:'ws', jsonb_build_array(t.op('project_members', 'UPSERT', :'pm_a', t.rev('project_members', :'pm_a'), jsonb_build_object('project_id', :'p1')))) ->> 'status' as x \gset

-- ---------------------------------------------------------------------
-- 4. 프로젝트 새 항목 (몰아 보내기)
-- ---------------------------------------------------------------------
:as_admin
update public.notifications set status = 'SENT', sent_at = now() where status = 'PENDING';
:as_a
select t.push(:'ws', jsonb_build_array(
  t.op('tasks', 'UPSERT', :'k1', null, jsonb_build_object('title', '슬라이드 만들기', 'project_id', :'p1')),
  t.op('tasks', 'UPSERT', :'k2', null, jsonb_build_object('title', '대본 쓰기', 'project_id', :'p1')),
  t.op('events', 'UPSERT', :'e1', null, jsonb_build_object('title', '리허설', 'project_id', :'p1', 'start_at', now() + interval '1 day', 'end_at', now() + interval '1 day 1 hour')),
  t.op('tasks', 'UPSERT', :'k3', null, jsonb_build_object('title', '프로젝트 없는 할 일'))
)) ->> 'status' as st \gset
:as_admin
select t.ok(:'st' = 'ACCEPTED', '4.0 A가 프로젝트에 할 일 2개·일정 1개', :'st');
select t.ok(t.nc(:'own', 'PROJECT_ITEM_ADDED') = 1 and (t.last(:'own', 'PROJECT_ITEM_ADDED')).body = '팀 공간 · 새 항목 3개가 추가됐어요'
  and ((t.last(:'own', 'PROJECT_ITEM_ADDED')).data ->> 'count')::int = 3,
  '4.1 팀원(관리자)에게 한 알림으로 합침', (t.last(:'own', 'PROJECT_ITEM_ADDED')).body);
select t.ok((t.last(:'own', 'PROJECT_ITEM_ADDED')).scheduled_for > now() + interval '1 minute', '4.2 2분 기다렸다 보냄 (그사이 더 합침)');
select t.ok(t.nc(:'a', 'PROJECT_ITEM_ADDED') = 0, '4.3 넣은 사람(A)은 안 받음');
select t.ok(t.nc(:'b', 'PROJECT_ITEM_ADDED') = 0, '4.4 프로젝트 소식을 끈 B는 안 받음');
:as_a
select t.push(:'ws', jsonb_build_array(t.op('tasks', 'UPSERT', :'k1', t.rev('tasks', :'k1'), '{"title":"슬라이드 다듬기"}'))) ->> 'status' as x \gset
select t.push(:'ws', jsonb_build_array(t.op('tasks', 'UPSERT', :'k3', t.rev('tasks', :'k3'), jsonb_build_object('project_id', :'p1')))) ->> 'status' as x \gset
:as_admin
select t.ok(((t.last(:'own', 'PROJECT_ITEM_ADDED')).data ->> 'count')::int = 4 and t.nc(:'own', 'PROJECT_ITEM_ADDED') = 1,
  '4.5 제목만 고친 할 일은 안 셈 · 나중에 프로젝트로 옮긴 할 일은 셈', (t.last(:'own', 'PROJECT_ITEM_ADDED')).data::text);
-- 메모 연결: B(프로젝트 소식 끔)가 메모를 프로젝트에 연결 → 관리자·A에게
:as_b
select t.push(:'ws', jsonb_build_array(
  t.op('notes', 'UPSERT', :'n1', null, '{"title":"회의 메모","body":"내용"}'),
  t.link(:'n1', :'p1'))) ->> 'status' as st \gset
:as_admin
select t.ok(:'st' = 'ACCEPTED' and ((t.last(:'own', 'PROJECT_ITEM_ADDED')).data ->> 'count')::int = 5
  and t.nc(:'a', 'PROJECT_ITEM_ADDED') = 1 and (t.last(:'a', 'PROJECT_ITEM_ADDED')).body = '팀 공간 · 메모 「회의 메모」이(가) 추가됐어요',
  '4.6 메모 연결도 새 항목 (하나면 제목을 보여 줌)', :'st' || ' / ' || coalesce((t.last(:'a', 'PROJECT_ITEM_ADDED')).body, '-'));
-- 이미 보낸 묶음 뒤에 들어온 항목은 새 알림
update public.notifications set status = 'SENT', sent_at = now() where account_id = :'own' and kind = 'PROJECT_ITEM_ADDED';
:as_a
select t.push(:'ws', jsonb_build_array(t.op('tasks', 'UPSERT', :'k4', null, jsonb_build_object('title', '자료 출력', 'project_id', :'p1')))) ->> 'status' as x \gset
:as_admin
select t.ok(t.nc(:'own', 'PROJECT_ITEM_ADDED') = 2 and (t.last(:'own', 'PROJECT_ITEM_ADDED')).body = '팀 공간 · 할 일 「자료 출력」이(가) 추가됐어요',
  '4.7 보낸 뒤에 들어온 항목은 새 알림');
-- 새 프로젝트를 만들며 팀원·할 일을 한 번에 넣으면 "팀원으로 추가됐어요"만 (새 항목 알림과 겹치지 않게)
:as_own
select t.push(:'ws', jsonb_build_array(
  t.op('projects', 'UPSERT', :'p3', null, '{"name":"새 프로젝트"}'),
  t.op('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p3', 'account_id', :'a', 'name', '팀원A')),
  t.op('tasks', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', '첫 할 일', 'project_id', :'p3')))) ->> 'status' as st \gset
:as_admin
select t.ok(:'st' = 'ACCEPTED' and exists (select 1 from public.notifications where account_id = :'a' and kind = 'PROJECT_MEMBER_ADDED' and ref_id = :'p3')
  and not exists (select 1 from public.notifications where kind = 'PROJECT_ITEM_ADDED' and ref_id = :'p3'),
  '4.8 같은 저장에서 만든 프로젝트의 항목은 새 항목 알림 없음', :'st');

-- ---------------------------------------------------------------------
-- 5. 프로젝트 정보 바뀜 · 삭제
-- ---------------------------------------------------------------------
:as_own
select t.push(:'ws', jsonb_build_array(t.op('projects', 'UPSERT', :'p1', t.rev('projects', :'p1'), '{"progress_status":"IN_PROGRESS"}'))) ->> 'status' as x \gset
:as_admin
select t.ok(t.nc(:'a', 'PROJECT_UPDATED') = 1 and (t.last(:'a', 'PROJECT_UPDATED')).body = '팀 공간 · 진행 상태가 진행 중(으)로 바뀌었어요'
  and t.nc(:'own', 'PROJECT_UPDATED') = 0,
  '5.1 진행 상태 → 팀원(A)에게, 바꾼 관리자는 안 받음', :'x' || ' / ' || coalesce((t.last(:'a', 'PROJECT_UPDATED')).body, '-'));
:as_own
select t.push(:'ws', jsonb_build_array(t.op('projects', 'UPSERT', :'p1', t.rev('projects', :'p1'), '{"due_date":"2026-12-05"}'))) ->> 'status' as x \gset
select t.push(:'ws', jsonb_build_array(t.op('projects', 'UPSERT', :'p1', t.rev('projects', :'p1'), '{"name":"발표 준비 (최종)"}'))) ->> 'status' as x \gset
:as_admin
select t.ok(t.nc(:'a', 'PROJECT_UPDATED') = 1 and (t.last(:'a', 'PROJECT_UPDATED')).body = '팀 공간 · 프로젝트 정보가 2번 바뀌었어요',
  '5.2 마감일 변경은 합치고, 이름만 바꾸면 알림 없음', (t.last(:'a', 'PROJECT_UPDATED')).body);
update public.notifications set status = 'SENT', sent_at = now() where status = 'PENDING';
:as_own
select t.push(:'ws', jsonb_build_array(t.op('projects', 'DELETE', :'p2', t.rev('projects', :'p2')))) ->> 'status' as x \gset
:as_admin
select t.ok(exists (select 1 from public.notifications where kind = 'PROJECT_UPDATED' and ref_id = :'p2' and body = '팀 공간 · 프로젝트가 휴지통으로 옮겨졌어요' and status = 'PENDING')
  and not exists (select 1 from public.notifications where kind = 'PROJECT_UPDATED' and ref_id = :'p2' and account_id = :'own'),
  '5.3 프로젝트를 휴지통으로 → 알림 (지운 사람 빼고)', :'x');

-- ---------------------------------------------------------------------
-- 6. 할 일 담당자
-- ---------------------------------------------------------------------
:as_own
select t.push(:'ws', jsonb_build_array(
  t.op('tasks', 'UPSERT', :'k5', null, jsonb_build_object('title', '견적 받기', 'assignee_id', :'a', 'due_at', '2026-12-01T09:00:00+09:00')),
  t.op('tasks', 'UPSERT', :'k6', null, jsonb_build_object('title', '내 할 일', 'assignee_id', :'own')))) ->> 'status' as st \gset
:as_admin
select t.ok(:'st' = 'ACCEPTED' and t.nc(:'a', 'TASK_ASSIGNED') = 1 and (t.last(:'a', 'TASK_ASSIGNED')).title = '견적 받기'
  and (t.last(:'a', 'TASK_ASSIGNED')).body = '팀 공간 · 할 일 담당자로 정해졌어요 (마감 12월 1일)'
  and (t.last(:'a', 'TASK_ASSIGNED')).data ->> 'type' = 'tasks' and (t.last(:'a', 'TASK_ASSIGNED')).data ->> 'id' = :'k5',
  '6.1 담당자로 정해지면 알림 (마감일·이동할 곳)', :'st' || ' / ' || coalesce((t.last(:'a', 'TASK_ASSIGNED')).body, '-'));
select t.ok(t.nc(:'own', 'TASK_ASSIGNED') = 0, '6.2 스스로 맡은 할 일은 알림 없음');
:as_own
select t.push(:'ws', jsonb_build_array(t.op('tasks', 'UPSERT', :'k5', t.rev('tasks', :'k5'), '{"title":"견적 두 곳 받기"}'))) ->> 'status' as x \gset
:as_admin
select t.ok(t.nc(:'a', 'TASK_ASSIGNED') = 1, '6.3 담당자가 그대로면 다시 안 보냄');

-- ---------------------------------------------------------------------
-- 7. 알림 오류가 저장을 막지 않음
-- ---------------------------------------------------------------------
:as_admin
alter function private.notification_allowed(uuid, text) rename to notification_allowed_off;
:as_a
select t.push(:'ws', jsonb_build_array(t.op('tasks', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('title', '알림이 고장 나도', 'project_id', :'p1')))) ->> 'status' as st \gset
:as_admin
alter function private.notification_allowed_off(uuid, text) rename to notification_allowed;
select t.ok(:'st' = 'ACCEPTED', '7.1 알림 함수가 실패해도 sync_push는 성공', :'st');

-- ---------------------------------------------------------------------
-- 8. 공간 삭제 · 권한
-- ---------------------------------------------------------------------
:as_own
select public.delete_workspace(:'ws') is not null as x \gset
:as_admin
select t.ok(t.nc(:'a', 'WORKSPACE_DELETED') = 1 and t.nc(:'b', 'WORKSPACE_DELETED') = 1
  and (t.last(:'a', 'WORKSPACE_DELETED')).workspace_id is null and (t.last(:'a', 'WORKSPACE_DELETED')).body = '공간이 삭제됐어요',
  '8.1 공간 삭제 → 남아 있던 멤버에게 (workspace_id 비움)');
select t.ok(t.nc(:'own', 'WORKSPACE_DELETED') = 0 and t.nc(:'v', 'WORKSPACE_DELETED') = 0 and t.nc(:'c', 'WORKSPACE_DELETED') = 0,
  '8.2 지운 사람·이미 나간 사람은 안 받음');
select t.ok(not has_function_privilege('authenticated', 'private.notify_grouped(uuid, uuid, text, text, text, text, jsonb, text, text, text, uuid, interval)', 'execute')
  and not has_function_privilege('authenticated', 'private.notification_allowed(uuid, text)', 'execute'), '8.3 내부 함수는 앱이 못 부름');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
