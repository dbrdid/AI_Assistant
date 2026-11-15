-- 프로젝트 팀원 · 프로젝트 초대 (migration 20261114162335_project_team) 시나리오 테스트 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_project_team.sql | grep -E "TOTAL|FAIL"
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
create function t.seq(p_ws uuid) returns bigint language sql security definer as $$
  select last_seq from public.workspace_sync_heads where workspace_id = p_ws $$;
create function t.change_entity(p_ws uuid, p_seq bigint) returns text language sql security definer as $$
  select entity_table from public.workspace_changes where workspace_id = p_ws and seq = p_seq $$;
create function t.inv_status(p_pi uuid) returns text language sql security definer as $$
  select w.status from public.project_invites p join public.workspace_invites w on w.id = p.invite_id where p.id = p_pi $$;
grant execute on all functions in schema t to authenticated, anon;

\set own '00000000-0000-4000-8000-0000000000c0'
\set ed  '00000000-0000-4000-8000-0000000000c1'
\set vw  '00000000-0000-4000-8000-0000000000c2'
\set nw  '00000000-0000-4000-8000-0000000000c3'
\set nw2 '00000000-0000-4000-8000-0000000000c4'
\set out '00000000-0000-4000-8000-0000000000c9'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'own', 'own@test.dev', '{"name":"관리자"}'),
  (:'ed',  'ed@test.dev',  '{"name":"편집자"}'),
  (:'vw',  'vw@test.dev',  '{"name":"보기"}'),
  (:'nw',  'newbie@test.dev', '{"name":"새팀원"}'),
  (:'nw2', 'n2@test.dev',  '{}'),
  (:'out', 'out@test.dev', '{"name":"외부인"}');

\set as_own  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_ed   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_vw   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c2'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_nw   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c3'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_nw2  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c4'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_out  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c9'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_anon 'reset role; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', false); set role anon;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

-- 준비: 공간 + EDITOR·VIEWER, 프로젝트 2개 (+ 외부인의 다른 공간·프로젝트)
:as_own
select public.create_workspace('팀 공간') as ws \gset
select (public.create_invite(:'ws', 'EDITOR', 24, 1)) ->> 'code' as c_ed \gset
select (public.create_invite(:'ws', 'VIEWER', 24, 1)) ->> 'code' as c_vw \gset
:as_ed
select public.accept_invite(:'c_ed') as x \gset
:as_vw
select public.accept_invite(:'c_vw') as x \gset
\set p1 '00000000-0000-4000-8000-00000000e101'
\set p2 '00000000-0000-4000-8000-00000000e102'
\set p3 '00000000-0000-4000-8000-00000000e103'
:as_own
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'p1', 'data', jsonb_build_object('name', '발표 준비')),
  jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'p2', 'data', jsonb_build_object('name', '앱 개발')),
  jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', :'p3', 'data', jsonb_build_object('name', '지울 프로젝트')))) as r \gset
:as_out
select public.create_workspace('남의 공간') as ws_out \gset
\set pout '00000000-0000-4000-8000-00000000e1ff'
select t.push(:'ws_out', t.one('projects', 'UPSERT', :'pout', null, jsonb_build_object('name', '남의 프로젝트'))) as r \gset

-- ---------------------------------------------------------------------
-- 1. 팀원 만들기 (sync_push project_members)
-- ---------------------------------------------------------------------
\set m1 '00000000-0000-4000-8000-00000000f001'
\set m2 '00000000-0000-4000-8000-00000000f002'
\set m3 '00000000-0000-4000-8000-00000000f003'
:as_own
select t.push(:'ws', jsonb_build_array(
  jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', :'m1', 'data', jsonb_build_object('project_id', :'p1', 'account_id', :'own', 'name', '관리자', 'role', '팀장')),
  jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', :'m2', 'data', jsonb_build_object('project_id', :'p1', 'name', '  김디자  ', 'role', '디자이너', 'position', 1)))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '1.1 프로젝트를 만든 사람이 팀장, 이름만 있는 팀원(디자이너) 함께 추가', :'r');
select t.ok((select account_id = :'own' and role = '팀장' and revision = 1 from public.project_members where id = :'m1')
        and (select name = '김디자' and role = '디자이너' and account_id is null and position = 1 from public.project_members where id = :'m2'),
        '1.2 저장 모양: 계정 연결·이름 앞뒤 공백 정리·역할 직접 입력');
select t.push(:'ws', t.one('project_members', 'UPSERT', :'m3', null, jsonb_build_object('project_id', :'p1', 'name', '역할 없음'))) as r \gset
select t.ok((select role = '팀원' from public.project_members where id = :'m3'), '1.3 역할을 안 보내면 팀원', :'r');
select t.seq(:'ws') as s0 \gset
select t.push(:'ws', t.one('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', '   '))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '1.4 빈 이름 → CHECK_FAILED', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', repeat('가', 21)))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '1.5 이름 21자 → CHECK_FAILED (화면 20자)', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', 'x', 'role', repeat('가', 13)))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23514', '1.6 역할 13자 → CHECK_FAILED (화면 12자)', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', 'x', 'account_id', :'out'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '22023' and :'r'::jsonb ->> 'msg' like '%ACTIVE 멤버%', '1.7 공간 멤버가 아닌 계정 연결 → INVALID_REQUEST', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'pout', 'name', 'x'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23503', '1.8 다른 공간 프로젝트에 추가 → REFERENCE_NOT_FOUND', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', '중복', 'account_id', :'own'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23505', '1.9 같은 계정을 같은 프로젝트에 두 번 → DUPLICATE', :'r');
select t.ok(t.seq(:'ws') = :s0, '1.10 거절된 요청은 순번을 쓰지 않음');
:as_vw
select t.push(:'ws', t.one('project_members', 'UPSERT', gen_random_uuid(), null, jsonb_build_object('project_id', :'p1', 'name', 'v'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '42501', '1.11 보기 전용 멤버는 팀원 편집 불가', :'r');
select t.ok((select count(*) = 3 from public.project_members where project_id = :'p1'), '1.12 보기 전용 멤버도 팀원 목록은 봄');
:as_out
select t.ok((select count(*) = 0 from public.project_members where workspace_id = :'ws'), '1.13 외부인은 팀원 목록 안 보임');
:as_own
select t.err($$insert into public.project_members (workspace_id, project_id, name, created_by) values ('$$ || :'ws' || $$', '$$ || :'p1' || $$', 'x', '$$ || :'own' || $$')$$,
        '42501', '1.14 앱에서 직접 추가 불가 (sync_push로만)');

-- ---------------------------------------------------------------------
-- 2. 이름·역할 수정, 다른 프로젝트로 이동, 삭제
--    #30부터 팀원 관리·프로젝트 초대는 팀장만 → 관리자가 ed를 p1의 팀장으로 넣고 시작 (팀장 규칙 자체는 test_project_extras.sql)
-- ---------------------------------------------------------------------
:as_own
\set med '00000000-0000-4000-8000-00000000f0ed'
select t.push(:'ws', t.one('project_members', 'UPSERT', :'med', null, jsonb_build_object('project_id', :'p1', 'account_id', :'ed', 'name', '편집자', 'role', '팀장', 'position', 9))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '2.0 관리자가 편집자를 p1 팀장으로 추가 (#30)', :'r');
:as_ed
select t.push(:'ws', t.one('project_members', 'UPSERT', :'m2', 1, jsonb_build_object('name', '김디자이너', 'role', '팀장'))) as r \gset
select t.ok((select name = '김디자이너' and role = '팀장' and revision = 2 from public.project_members where id = :'m2'), '2.1 EDITOR가 이름·역할 수정 (revision 2)', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', :'m2', 2, jsonb_build_object('project_id', :'p2'))) as r \gset
select t.ok((select project_id = :'p2' and name = '김디자이너' and revision = 3 from public.project_members where id = :'m2'), '2.2 다른 프로젝트로 이동 (이름·역할 그대로)', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', :'m2', 3, jsonb_build_object('project_id', :'pout'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '23503', '2.3 다른 공간 프로젝트로 이동 불가', :'r');
select t.push(:'ws', t.one('project_members', 'UPSERT', :'m2', 1, jsonb_build_object('name', '옛 값'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'CONFLICT' and :'r'::jsonb -> 'conflicts' -> 0 ->> 'reason' = 'REVISION_MISMATCH', '2.4 오래된 revision → 충돌', :'r');
select t.push(:'ws', t.one('project_members', 'DELETE', :'m3', 1, '{}'::jsonb)) as r \gset
select t.ok((select deleted_at is not null and deleted_by = :'ed' from public.project_members where id = :'m3'), '2.5 삭제 → 휴지통 표시 (다른 기기가 받을 수 있게)', :'r');
:as_own
select t.push(:'ws', t.one('project_members', 'DELETE', :'m1', 1, '{}'::jsonb)) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '2.6 서버는 마지막 팀장 삭제를 막지 않음 (화면처럼 앱에서 막음)', :'r');
\set m4 '00000000-0000-4000-8000-00000000f004'
select t.push(:'ws', t.one('project_members', 'UPSERT', :'m4', null, jsonb_build_object('project_id', :'p1', 'account_id', :'own', 'name', '관리자', 'role', '팀장'))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '2.7 삭제한 계정은 같은 프로젝트에 다시 추가 가능', :'r');
:as_vw
select public.sync_pull(:'ws', 0, 500) as pl \gset
select t.ok((select count(*) from jsonb_array_elements(:'pl'::jsonb -> 'changes') c where c ->> 'entity' = 'project_members') >= 6
        and exists (select 1 from jsonb_array_elements(:'pl'::jsonb -> 'changes') c
                     where c ->> 'entity' = 'project_members' and c ->> 'key' = :'m2' and c -> 'data' ->> 'project_id' = :'p2'),
        '2.8 다른 기기는 sync_pull로 팀원 변경(이동 포함)을 받음');

-- ---------------------------------------------------------------------
-- 3. 프로젝트 초대 만들기
-- ---------------------------------------------------------------------
:as_ed
select public.get_project_invite_quota() as q0 \gset
select t.ok((:'q0'::jsonb ->> 'limit')::int = 10 and (:'q0'::jsonb ->> 'used')::int = 0 and :'q0'::jsonb ->> 'plan' = 'FREE', '3.1 이번 달 초대 한도 FREE 10회', :'q0');
select t.seq(:'ws') as s1 \gset
select public.create_project_invite(:'p1', 'LINK') as i1 \gset
select t.ok(:'i1'::jsonb ->> 'code' ~ '^[A-Z2-9]{5}-[A-Z2-9]{5}$' and :'i1'::jsonb ->> 'method' = 'LINK' and :'i1'::jsonb -> 'email' = 'null'::jsonb
        and (:'i1'::jsonb -> 'quota' ->> 'remaining')::int = 9, '3.2 EDITOR가 링크 초대 → 코드, 남은 횟수 9', :'i1');
select t.ok(t.seq(:'ws') = :s1 + 1 and t.change_entity(:'ws', :s1 + 1) = 'project_invites',
        '3.3 초대 대기가 원장에 기록 (다른 기기 "초대 대기" 목록)');
select public.create_project_invite(:'p1', 'EMAIL', '  New.Person@Example.com ') as i2 \gset
select t.ok(:'i2'::jsonb ->> 'email' = 'new.person@example.com', '3.4 메일 초대: 이메일 소문자·공백 정리', :'i2');
select t.err($$select public.create_project_invite('$$ || :'p1' || $$', 'EMAIL', 'new.person@example.com')$$, 'ALREADY_INVITED', '3.5 같은 프로젝트에 같은 이메일 대기 중 → ALREADY_INVITED');
select public.create_project_invite(:'p2', 'EMAIL', 'new.person@example.com') as i3 \gset
select t.ok(:'i3'::jsonb ->> 'code' is not null, '3.6 다른 프로젝트에는 같은 이메일 초대 가능', :'i3');
select t.err($$select public.create_project_invite('$$ || :'p1' || $$', 'EMAIL', 'not-an-email')$$, 'INVALID_EMAIL', '3.7 이메일 형식 틀림 → INVALID_EMAIL');
select t.err($$select public.create_project_invite('$$ || :'p1' || $$', 'EMAIL')$$, 'INVALID_EMAIL', '3.8 메일 초대인데 이메일 없음 → INVALID_EMAIL');
select t.err($$select public.create_project_invite('$$ || :'p1' || $$', 'SMS')$$, 'INVALID_REQUEST', '3.9 없는 초대 방법 → INVALID_REQUEST');
select t.err($$select public.create_project_invite('$$ || :'p1' || $$', 'LINK', null, 0)$$, 'INVALID_REQUEST', '3.10 유효 기간 0시간 → INVALID_REQUEST');
select t.err($$select public.create_project_invite('$$ || :'pout' || $$', 'LINK')$$, 'NOT_FOUND', '3.11 남의 공간 프로젝트 → NOT_FOUND');
:as_vw
select t.err($$select public.create_project_invite('$$ || :'p1' || $$', 'LINK')$$, 'FORBIDDEN', '3.12 보기 전용 멤버는 초대 불가');
select t.ok((select count(*) = 3 from public.project_invites where workspace_id = :'ws'), '3.13 같은 공간 멤버는 초대 대기 목록을 봄');
select t.err($$select token_hash from public.workspace_invites$$, '42501', '3.14 초대 코드 해시는 여전히 안 보임');
:as_out
select t.ok((select count(*) = 0 from public.project_invites where workspace_id = :'ws'), '3.15 외부인은 초대 목록 안 보임');
:as_anon
select t.err($$select public.create_project_invite('00000000-0000-4000-8000-00000000e101', 'LINK')$$, '42501', '3.16 비로그인 → 실행 권한 없음');

-- ---------------------------------------------------------------------
-- 4. 초대 코드로 참여 → 프로젝트 팀원
-- ---------------------------------------------------------------------
:as_nw
select public.join_with_invite(:'i1'::jsonb ->> 'code') as j1 \gset
select t.ok(:'j1'::jsonb ->> 'workspace_id' = :'ws' and :'j1'::jsonb ->> 'role' = 'EDITOR' and jsonb_array_length(:'j1'::jsonb -> 'projects') = 1
        and :'j1'::jsonb -> 'projects' -> 0 ->> 'project_id' = :'p1', '4.1 새 사람이 링크 코드로 참여 → 공간 멤버(멤버) + 그 프로젝트', :'j1');
select t.ok((select name = '새팀원' and role = '팀원' and account_id = :'nw' from public.project_members
              where id = (:'j1'::jsonb -> 'projects' -> 0 ->> 'member_id')::uuid), '4.2 프로필 이름으로 팀원 추가, 역할 팀원');
select t.ok((select status = 'ACCEPTED' and accepted_by = :'nw' and member_id is not null from public.project_invites where id = (:'i1'::jsonb ->> 'project_invite_id')::uuid)
        and t.inv_status((:'i1'::jsonb ->> 'project_invite_id')::uuid) = 'ACCEPTED', '4.3 초대는 수락 완료, 코드도 사용 완료');
:as_nw2
select t.err($$select public.join_with_invite('$$ || (:'i1'::jsonb ->> 'code') || $$')$$, 'INVITE_USED_UP', '4.4 같은 코드를 다른 사람이 → INVITE_USED_UP (1명용)');
-- 이미 공간 멤버(EDITOR 편집자)가 프로젝트 초대를 받음
:as_own
select public.create_project_invite(:'p2', 'LINK') as i4 \gset
:as_ed
select public.join_with_invite(:'i4'::jsonb ->> 'code') as j2 \gset
select t.ok((:'j2'::jsonb ->> 'already_member')::boolean and :'j2'::jsonb ->> 'role' = 'EDITOR'
        and exists (select 1 from public.project_members where project_id = :'p2' and account_id = :'ed' and deleted_at is null),
        '4.5 이미 공간 멤버 → 공간 역할 그대로, 프로젝트에만 추가', :'j2');
select t.ok(t.inv_status((:'i4'::jsonb ->> 'project_invite_id')::uuid) = 'ACCEPTED', '4.6 이미 멤버여도 프로젝트 초대 코드는 사용 완료 (재사용 불가)');
-- 이미 그 프로젝트 팀원인 사람이 또 초대받음 → 중복 추가 안 함
:as_own
select public.create_project_invite(:'p2', 'LINK') as i5 \gset
:as_ed
select public.join_with_invite(:'i5'::jsonb ->> 'code') as j3 \gset
select t.ok((select count(*) = 1 from public.project_members where project_id = :'p2' and account_id = :'ed' and deleted_at is null)
        and :'j3'::jsonb -> 'projects' -> 0 ->> 'member_id' is not null, '4.7 이미 팀원이면 새로 추가하지 않고 기존 팀원으로 연결', :'j3');
-- 공간 초대 코드도 그대로 받음
:as_own
select (public.create_invite(:'ws', 'EDITOR', 24, 1)) ->> 'code' as c_plain \gset
:as_nw2
select public.join_with_invite(:'c_plain') as j4 \gset
select t.ok(:'j4'::jsonb ->> 'role' = 'EDITOR' and jsonb_array_length(:'j4'::jsonb -> 'projects') = 0, '4.8 공간 초대 코드 → 공간만 참여 (프로젝트 없음)', :'j4');
select t.err($$select public.join_with_invite('ZZZZZ-ZZZZZ')$$, 'INVITE_INVALID', '4.9 없는 코드 → INVITE_INVALID');
select t.err($$select public.join_with_invite('???')$$, 'INVITE_INVALID', '4.10 형식 틀린 코드 → INVITE_INVALID');
-- 삭제된 프로젝트의 초대
:as_own
select public.create_project_invite(:'p3', 'LINK') as i6 \gset
select t.push(:'ws', t.one('projects', 'DELETE', :'p3', 1, '{}'::jsonb)) as r \gset
:as_out
select public.join_with_invite(:'i6'::jsonb ->> 'code') as j5 \gset
select t.ok(:'j5'::jsonb -> 'projects' -> 0 -> 'member_id' = 'null'::jsonb
        and not exists (select 1 from public.project_members where project_id = :'p3'), '4.11 프로젝트가 휴지통에 있으면 공간만 참여, 팀원 추가 안 함', :'j5');
:as_admin
select t.ok((select count(*) from public.workspace_changes where workspace_id = :'ws' and entity_table = 'project_members' and actor_id = :'nw') = 1
        and (select count(*) from public.workspace_changes where workspace_id = :'ws' and entity_table = 'project_invites') >= 8,
        '4.12 참여로 생긴 팀원·초대 변경이 원장에 기록');
select t.ok((select bool_and(seq_ok) from (select seq = row_number() over (order by seq) as seq_ok from public.workspace_changes where workspace_id = :'ws') s),
        '4.13 원장 순번이 빈틈 없이 이어짐');

-- ---------------------------------------------------------------------
-- 5. 초대 취소
-- ---------------------------------------------------------------------
:as_own
select public.create_project_invite(:'p1', 'LINK') as i7 \gset
:as_nw
select t.err($$select public.revoke_project_invite('$$ || (:'i7'::jsonb ->> 'project_invite_id') || $$')$$, 'FORBIDDEN', '5.1 만든 사람·관리자가 아니면 취소 불가');
:as_ed
select public.revoke_project_invite((:'i2'::jsonb ->> 'project_invite_id')::uuid) as v1 \gset
select t.ok(:'v1'::jsonb ->> 'status' = 'REVOKED' and t.inv_status((:'i2'::jsonb ->> 'project_invite_id')::uuid) = 'REVOKED', '5.2 만든 사람이 취소 → 초대·코드 모두 취소', :'v1');
select public.revoke_project_invite((:'i2'::jsonb ->> 'project_invite_id')::uuid) as v2 \gset
select t.ok((:'v2'::jsonb ->> 'unchanged')::boolean, '5.3 두 번 취소 → 그대로', :'v2');
:as_out
select t.err($$select public.join_with_invite('$$ || (:'i2'::jsonb ->> 'code') || $$')$$, 'INVITE_REVOKED', '5.4 취소된 코드 → INVITE_REVOKED');
:as_own
select public.revoke_project_invite((:'i3'::jsonb ->> 'project_invite_id')::uuid) as v3 \gset
select t.ok(:'v3'::jsonb ->> 'status' = 'REVOKED', '5.5 관리자는 남이 만든 초대도 취소', :'v3');
-- 공간 초대 쪽에서 취소되면 프로젝트 초대도 취소 표시
select (select invite_id from public.project_invites where id = (:'i7'::jsonb ->> 'project_invite_id')::uuid) as w7 \gset
select public.revoke_invite(:'w7') as v4 \gset
select t.ok((select status = 'REVOKED' and revoked_at is not null from public.project_invites where id = (:'i7'::jsonb ->> 'project_invite_id')::uuid),
        '5.6 공간 초대가 취소되면(관리자 취소·강등 등) 프로젝트 초대도 취소 표시');

-- ---------------------------------------------------------------------
-- 6. 월 초대 한도
-- ---------------------------------------------------------------------
:as_ed
select public.get_project_invite_quota() as q1 \gset
select t.ok((:'q1'::jsonb ->> 'used')::int = 3 and (:'q1'::jsonb ->> 'remaining')::int = 7, '6.1 취소해도 이번 달 사용 횟수는 그대로 (3회 사용, 7회 남음)', :'q1');
select count(*) from (select public.create_project_invite(:'p1', 'LINK') from generate_series(1, 7)) x \gset
select t.err($$select public.create_project_invite('$$ || :'p1' || $$', 'LINK')$$, 'INVITE_LIMIT', '6.2 10회를 다 쓰면 → INVITE_LIMIT');
:as_admin
update public.subscriptions set plan = 'PRO', current_period_start = now(), current_period_end = now() + interval '1 month' where account_id = :'ed';
:as_ed
select public.create_project_invite(:'p1', 'LINK') as i8 \gset
select t.ok((:'i8'::jsonb -> 'quota' ->> 'limit')::int = 50 and (:'i8'::jsonb -> 'quota' ->> 'used')::int = 11, '6.3 PRO면 한도 50회로 바로 늘어남', :'i8');
:as_admin
update public.project_invites set created_at = created_at - interval '40 days' where created_by = :'ed';
:as_ed
select t.ok((public.get_project_invite_quota() ->> 'used')::int = 0, '6.4 지난달 초대는 이번 달 횟수에 안 셈');
:as_own
select t.ok((public.get_project_invite_quota() ->> 'used')::int = 4, '6.5 한도는 사람마다 따로');

-- ---------------------------------------------------------------------
-- 7. 처음 받기 (sync_snapshot)
-- ---------------------------------------------------------------------
:as_vw
select public.sync_snapshot(:'ws') as sn \gset
select t.ok(jsonb_array_length(:'sn'::jsonb -> 'project_members') >= 6 and jsonb_array_length(:'sn'::jsonb -> 'project_invites') >= 10
        and exists (select 1 from jsonb_array_elements(:'sn'::jsonb -> 'project_members') m where m ->> 'id' = :'m2' and m ->> 'project_id' = :'p2'),
        '7.1 전체 받기에 팀원·초대 대기 포함');
select t.ok(not exists (select 1 from jsonb_array_elements(:'sn'::jsonb -> 'project_invites') i where i ? 'token_hash' or i ? 'code'),
        '7.2 전체 받기에도 초대 코드·해시 없음');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
