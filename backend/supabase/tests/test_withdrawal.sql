-- 회원 탈퇴 (#33): 공간 정리 · 공유 기록 남기기(작성자 null) · 개인 기록 삭제 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_withdrawal.sql | grep -E "TOTAL|FAIL"
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
create function t.rev(p_table text, p_id uuid) returns bigint language plpgsql security definer as $$
declare r bigint; begin execute format('select revision from public.%I where id = $1', p_table) into r using p_id; return r; end $$;
create function t.gapless(p_ws uuid) returns boolean language sql security definer as $$
  select count(*) = max(seq) and min(seq) = 1 and max(seq) = (select last_seq from public.workspace_sync_heads where workspace_id = p_ws)
    from public.workspace_changes where workspace_id = p_ws $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set wo '00000000-0000-4000-8000-000000000a10'
\set a  '00000000-0000-4000-8000-000000000a11'
\set b  '00000000-0000-4000-8000-000000000a12'
\set c  '00000000-0000-4000-8000-000000000a13'
\set d  '00000000-0000-4000-8000-000000000a14'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'wo', 'wo@test.dev', '{"name":"탈퇴할 사람"}'),
  (:'a',  'wa@test.dev', '{"name":"편집자A"}'),
  (:'b',  'wb@test.dev', '{"name":"보기B"}'),
  (:'c',  'wc@test.dev', '{"name":"관리자C"}'),
  (:'d',  'wd@test.dev', '{"name":"대시보드에서 지울 사람"}');

\set as_wo 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000a10'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_a  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000a11'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_b  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000a12'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_c  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000a13'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_d  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-000000000a14'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_svc 'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

\set n1 '00000000-0000-4000-8000-00000000a101'
\set k1 '00000000-0000-4000-8000-00000000a102'
\set p1 '00000000-0000-4000-8000-00000000a103'
\set pm1 '00000000-0000-4000-8000-00000000a104'
\set pm2 '00000000-0000-4000-8000-00000000a105'
\set n3 '00000000-0000-4000-8000-00000000a301'
\set f1 '00000000-0000-4000-8000-00000000a111'
\set f3 '00000000-0000-4000-8000-00000000a311'
\set bk '00000000-0000-4000-8000-00000000a999'
\set h1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

-- W1: 탈퇴자 OWNER 혼자, 보기 B(먼저 들어옴)·편집 A(나중) → A가 OWNER가 돼야 함
:as_wo
select public.create_workspace('W1 넘길 공간') as w1 \gset
select (public.create_invite(:'w1', 'VIEWER', 24, 1)) ->> 'code' as c1v \gset
select (public.create_invite(:'w1', 'EDITOR', 24, 1)) ->> 'code' as c1e \gset
:as_b
select public.accept_invite(:'c1v') is not null as x \gset
:as_a
select public.accept_invite(:'c1e') is not null as x \gset
:as_admin
update public.workspace_members set joined_at = now() - interval '2 days' where workspace_id = :'w1' and account_id = :'b';
-- W2: C가 OWNER, 탈퇴자는 편집자
:as_c
select public.create_workspace('W2 C의 공간') as w2 \gset
select (public.create_invite(:'w2', 'EDITOR', 24, 1)) ->> 'code' as c2 \gset
:as_wo
select public.accept_invite(:'c2') is not null as x \gset
-- W3: 탈퇴자 혼자 (첨부 있음)
select public.create_workspace('W3 혼자 공간') as w3 \gset
-- W4: 탈퇴자 OWNER, 멤버였던 A는 이미 나감 → 혼자로 봄
select public.create_workspace('W4 다 나간 공간') as w4 \gset
select (public.create_invite(:'w4', 'EDITOR', 24, 1)) ->> 'code' as c4 \gset
:as_a
select public.accept_invite(:'c4') is not null as x \gset
select public.leave_workspace(:'w4') is not null as x \gset
-- W5: 탈퇴자와 C가 둘 다 OWNER → 넘기지 않고 나가기만
:as_wo
select public.create_workspace('W5 공동 관리') as w5 \gset
select (public.create_invite(:'w5', 'EDITOR', 24, 1)) ->> 'code' as c5 \gset
:as_c
select public.accept_invite(:'c5') is not null as x \gset
:as_wo
select public.change_member_role(:'w5', :'c', 'OWNER') is not null as x \gset
-- W6: 탈퇴 전에 이미 지운 공간 (멤버 행은 OWNER ACTIVE로 남아 있음)
select public.create_workspace('W6 지운 공간') as w6 \gset
select public.delete_workspace(:'w6') is not null as x \gset

-- 탈퇴자가 W1에 남긴 기록: 메모 · 휴지통에 보낸 할 일 · 계정 연결된 팀원 칸 · 대기 중 초대
select t.push(:'w1', jsonb_build_array(
  t.op('notes', 'UPSERT', :'n1', null, '{"title":"남길 메모","body":"공유 기록"}'),
  t.op('tasks', 'UPSERT', :'k1', null, '{"title":"휴지통 할 일"}'),
  t.op('projects', 'UPSERT', :'p1', null, '{"name":"발표"}'),
  t.op('project_members', 'UPSERT', :'pm1', null, jsonb_build_object('project_id', :'p1', 'account_id', :'wo', 'name', '탈퇴할 사람', 'role', '팀장')),
  t.op('project_members', 'UPSERT', :'pm2', null, jsonb_build_object('project_id', :'p1', 'account_id', :'a', 'name', '편집자A')))) ->> 'status' as x \gset
select t.push(:'w1', jsonb_build_array(t.op('tasks', 'DELETE', :'k1', 1))) ->> 'status' as x \gset
select (public.create_invite(:'w1', 'EDITOR', 24, 1)) ->> 'invite_id' as inv_w1 \gset
select public.create_project_invite(:'p1', 'LINK') ->> 'project_invite_id' as pinv \gset
select t.push(:'w3', jsonb_build_array(t.op('notes', 'UPSERT', :'n3', null, '{"title":"혼자 메모","body":""}'))) ->> 'status' as x \gset
select public.set_note_favorites(:'w1', array[:'n1'::uuid], true) ->> 'changed' as x \gset
select public.backup_key('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') ->> 'created' as x \gset
:as_admin
select public.asset_prepare(:'wo', :'f1', 'ATTACHMENT', :'w1', '공유 자료.pdf', 'application/pdf', 5, :'h1') is not null as x \gset
select public.asset_complete(:'wo', :'f1', 5, :'h1') is not null as x \gset
select public.asset_prepare(:'wo', :'f3', 'ATTACHMENT', :'w3', '혼자 자료.pdf', 'application/pdf', 5, :'h1') is not null as x \gset
select public.asset_complete(:'wo', :'f3', 5, :'h1') is not null as x \gset
select public.asset_prepare(:'wo', :'bk', 'BACKUP', null, 'stella-backup', 'application/octet-stream', 100, :'h1') is not null as x \gset
select public.asset_complete(:'wo', :'bk', 100, :'h1') is not null as x \gset
:as_wo
select public.backup_register(:'bk') ->> 'ok' as x \gset
:as_admin
select object_path as f1_path from public.assets where id = :'f1' \gset
select object_path as f3_path from public.assets where id = :'f3' \gset
select object_path as bk_path from public.assets where id = :'bk' \gset
insert into private.stt_uploads (id, account_id, object_path, ext, mime_type, declared_size_bytes)
values (gen_random_uuid(), :'wo', :'wo' || '/u1.m4a', 'm4a', 'audio/mp4', 100);
insert into public.devices (account_id, installation_id, platform, app_version) values (:'wo', 'inst-1', 'ios', '1.0');
insert into public.consents (account_id, consent_type, policy_version) values (:'wo', 'EXTERNAL_AI', 'v1');
select count(*) as before_w1_changes from public.workspace_changes where workspace_id = :'w1' \gset

-- ---------------------------------------------------------------------
-- 0. 미리 보기 (바꾸는 것 없음)
-- ---------------------------------------------------------------------
:as_wo
select public.account_withdraw_preview() as pv \gset
select t.ok((select jsonb_object_agg(x ->> 'workspace_id', x ->> 'action') from jsonb_array_elements(:'pv'::jsonb) x)
            = jsonb_build_object(:'w1', 'TRANSFER', :'w2', 'LEAVE', :'w3', 'DELETE', :'w4', 'DELETE', :'w5', 'LEAVE')
  and exists (select 1 from jsonb_array_elements(:'pv'::jsonb) x where x ->> 'workspace_id' = :'w1'
              and x ->> 'next_owner_id' = :'a' and x ->> 'next_owner_name' = '편집자A'),
  '0.1 미리 보기: W1 편집자A에게 넘김 · W2·W5 나가기 · W3·W4 삭제 (지운 W6는 없음)', :'pv');
:as_admin
select t.ok((select status = 'ACTIVE' from public.workspace_members where workspace_id = :'w1' and account_id = :'wo'), '0.2 미리 보기는 아무것도 안 바꿈');

-- ---------------------------------------------------------------------
-- 1. 권한
-- ---------------------------------------------------------------------
:as_wo
select t.err(format('select public.account_withdraw_prepare(%L)', :'wo'), '42501', '1.1 앱(본인 토큰)은 탈퇴 함수를 직접 못 부름');
select t.err(format('select public.account_withdraw_finish(%L)', :'wo'), '42501', '1.2 마무리 함수도');
:as_svc
select t.err(format('select public.account_withdraw_prepare(%L)', gen_random_uuid()), 'NOT_FOUND', '1.3 없는 계정 → NOT_FOUND');

-- ---------------------------------------------------------------------
-- 2. ① 준비: 공간 정리 + 지울 파일 목록
-- ---------------------------------------------------------------------
select public.account_withdraw_prepare(:'wo') as prep \gset
:as_admin
select t.ok((select role = 'OWNER' and status = 'ACTIVE' from public.workspace_members where workspace_id = :'w1' and account_id = :'a')
  and (select role = 'VIEWER' from public.workspace_members where workspace_id = :'w1' and account_id = :'b')
  and (select status = 'LEFT' from public.workspace_members where workspace_id = :'w1' and account_id = :'wo'),
  '2.1 혼자 OWNER인 공간 → 먼저 들어온 보기 전용보다 편집자에게 OWNER, 탈퇴자는 나감', :'prep');
select t.ok(:'prep'::jsonb -> 'owner_moved' = jsonb_build_array(jsonb_build_object('workspace_id', :'w1', 'owner', :'a'))
  and exists (select 1 from public.workspace_changes where workspace_id = :'w1' and entity_table = 'workspace_members'
              and entity_key = :'a' and data ->> 'role' = 'OWNER'),
  '2.2 결과에 넘긴 공간·새 OWNER, 원장에도 (다른 기기 멤버 목록 갱신)', :'prep');
select t.ok((select status = 'LEFT' from public.workspace_members where workspace_id = :'w2' and account_id = :'wo')
  and (select role = 'OWNER' from public.workspace_members where workspace_id = :'w2' and account_id = :'c'), '2.3 남의 공간은 나가기만');
select t.ok((select count(*) = 2 from public.workspaces where id in (:'w3', :'w4'))
  and (select jsonb_agg(x order by x) from jsonb_array_elements_text(:'prep'::jsonb -> 'deleted_workspaces') x) = jsonb_build_array(least(:'w3', :'w4'), greatest(:'w3', :'w4')),
  '2.4 혼자인 공간(나간 멤버만 있던 곳 포함)은 지울 목록에 (실제 삭제는 ③, 파일 삭제가 실패해도 다시 목록을 받게)', :'prep');
select t.ok((select role = 'OWNER' from public.workspace_members where workspace_id = :'w5' and account_id = :'c')
  and (select status = 'LEFT' from public.workspace_members where workspace_id = :'w5' and account_id = :'wo')
  and not exists (select 1 from jsonb_array_elements(:'prep'::jsonb -> 'owner_moved') x where x ->> 'workspace_id' = :'w5'),
  '2.5 OWNER가 또 있으면 넘기지 않고 나가기만');
select t.ok((select name = '탈퇴한 사용자' and account_id is null and role = '팀장' from public.project_members where id = :'pm1')
  and exists (select 1 from public.workspace_changes where workspace_id = :'w1' and entity_table = 'project_members' and entity_key = :'pm1'
              and data ->> 'name' = '탈퇴한 사용자'),
  '2.6 계정 연결된 팀원 칸 → 이름 "탈퇴한 사용자", 연결 끊음 (원장에도)');
select t.ok((select status = 'REVOKED' from public.workspace_invites where id = :'inv_w1')
  and (select status = 'REVOKED' from public.project_invites where id = :'pinv'), '2.7 탈퇴자가 만든 대기 중 초대(공간·프로젝트) 취소');
select t.ok(not exists (select 1 from public.workspace_changes where entity_table = 'workspace_members' and entity_key = :'wo'
                         and (data ->> 'display_name') is not null)
  and exists (select 1 from public.workspace_changes where workspace_id = :'w1' and entity_table = 'workspace_members' and entity_key = :'wo'
              and data ->> 'status' = 'LEFT' and (data ->> 'withdrawn')::boolean),
  '2.8 원장의 멤버 기록에서 이름 지움, 마지막 기록은 LEFT + withdrawn');
select t.ok(:'prep'::jsonb -> 'objects' @> jsonb_build_array(
    jsonb_build_object('bucket', 'attachments', 'path', :'f3_path'), jsonb_build_object('bucket', 'backups', 'path', :'bk_path'),
    jsonb_build_object('bucket', 'stt-uploads', 'path', :'wo' || '/u1.m4a'))
  and not (:'prep'::jsonb -> 'objects' @> jsonb_build_array(jsonb_build_object('bucket', 'attachments', 'path', :'f1_path'))),
  '2.9 지울 파일 = 혼자인 공간 첨부 · 백업 · 녹음 (공유 공간 첨부는 남김)', :'prep');
select t.ok(t.gapless(:'w1') and t.gapless(:'w2') and t.gapless(:'w5'), '2.10 원장 순번 빈틈 없음');
:as_svc
select public.account_withdraw_prepare(:'wo') as prep2 \gset
select t.ok(jsonb_array_length(:'prep2'::jsonb -> 'left') = 0 and jsonb_array_length(:'prep2'::jsonb -> 'owner_moved') = 0
  and jsonb_array_length(:'prep2'::jsonb -> 'deleted_workspaces') = 2
  and (:'prep2'::jsonb -> 'objects') @> jsonb_build_array(jsonb_build_object('bucket', 'attachments', 'path', :'f3_path')),
  '2.11 다시 불러도 안전 (나갈 공간 없음, 혼자 공간 파일 목록은 다시 줌)', :'prep2');

-- ---------------------------------------------------------------------
-- 3. ③ 계정 삭제: 공유 기록은 남고 작성자 null, 개인 기록은 삭제
-- ---------------------------------------------------------------------
select public.account_withdraw_finish(:'wo') as fin \gset
:as_admin
select t.ok((:'fin'::jsonb ->> 'deleted')::boolean and not exists (select 1 from public.accounts where id = :'wo')
  and not exists (select 1 from public.profiles where account_id = :'wo') and not exists (select 1 from public.user_settings where account_id = :'wo')
  and not exists (select 1 from public.subscriptions where account_id = :'wo'), '3.1 계정·프로필·설정·구독 삭제', :'fin');
select t.ok(not exists (select 1 from public.workspaces where id in (:'w3', :'w4')) and not exists (select 1 from public.notes where id = :'n3')
  and not exists (select 1 from public.assets where id = :'f3'), '3.1b 혼자인 공간은 기록·첨부 행째 삭제');
select t.ok(not exists (select 1 from public.workspace_members where workspace_id = :'w6')
  and (select created_by is null from public.workspaces where id = :'w6'), '3.1c 이미 지운 공간의 OWNER여도 탈퇴됨 (마지막 OWNER 검사 안 함)');
select t.ok(not exists (select 1 from public.devices where account_id = :'wo') and not exists (select 1 from public.consents where account_id = :'wo')
  and not exists (select 1 from public.note_favorites where account_id = :'wo') and not exists (select 1 from private.backup_keys where account_id = :'wo')
  and not exists (select 1 from public.backups where account_id = :'wo') and not exists (select 1 from public.assets where id = :'bk')
  and not exists (select 1 from private.stt_uploads where account_id = :'wo'), '3.2 기기·동의·즐겨찾기·백업(키·목록·파일 행)·녹음 삭제');
select t.ok((select created_by is null and title = '남길 메모' from public.notes where id = :'n1')
  and (select created_by is null and deleted_by is null and deleted_at is not null from public.tasks where id = :'k1')
  and (select owner_account_id is null and status = 'AVAILABLE' from public.assets where id = :'f1'),
  '3.3 공유 기록·공유 첨부는 남고 작성자 칸만 비움 (휴지통 할 일은 휴지통 그대로)');
select t.ok(not exists (select 1 from public.workspace_members where account_id = :'wo')
  and (select count(*) from public.workspace_changes where workspace_id = :'w1') >= :before_w1_changes
  and not exists (select 1 from public.workspace_changes where actor_id = :'wo'), '3.4 멤버 행 삭제, 원장은 남고 행위자만 비움');
select t.ok(exists (select 1 from auth.users where id = :'wo'), '3.5 ④ 로그인 계정 삭제는 Edge Function 몫 (DB 함수는 안 지움)');
:as_svc
select public.account_withdraw_finish(:'wo') as fin2 \gset
select t.ok(not (:'fin2'::jsonb ->> 'deleted')::boolean, '3.6 다시 불러도 안전', :'fin2');

-- 남은 사람 화면: 공간·기록 그대로, 휴지통 영구 삭제는 새 관리자가
:as_a
select public.sync_snapshot(:'w1') as sn \gset
select t.ok(exists (select 1 from jsonb_array_elements(:'sn'::jsonb -> 'notes') x where x ->> 'id' = :'n1' and x ->> 'created_by' is null),
  '3.7 남은 멤버 전체 받기: 메모 그대로 (작성자 null = 탈퇴한 사용자)');
select t.push(:'w1', jsonb_build_array(t.op('tasks', 'PURGE', :'k1', t.rev('tasks', :'k1')))) as r \gset
select t.ok(:'r'::jsonb ->> 'status' = 'ACCEPTED', '3.8 탈퇴자가 휴지통에 보낸 것은 새 관리자가 영구 삭제 가능', :'r');
:as_b
select t.push(:'w1', jsonb_build_array(t.op('notes', 'UPSERT', :'n1', t.rev('notes', :'n1'), '{"title":"x"}'))) as r \gset
select t.ok(:'r'::jsonb ->> 'error' = '42501' or :'r'::jsonb ->> 'msg' like 'FORBIDDEN%', '3.9 보기 전용 B는 그대로 보기 전용', :'r');
:as_c
select t.ok((select count(*) = 1 from public.workspace_members where workspace_id = :'w2' and status = 'ACTIVE'), '3.10 W2에는 C만 남음');

-- ---------------------------------------------------------------------
-- 4. 대시보드에서 Auth 사용자를 바로 지워도 같은 정리 (트리거)
-- ---------------------------------------------------------------------
:as_d
select public.create_workspace('D 공간') as wd \gset
select (public.create_invite(:'wd', 'EDITOR', 24, 1)) ->> 'code' as cd \gset
:as_a
select public.accept_invite(:'cd') is not null as x \gset
:as_admin
delete from auth.users where id = :'d';
select t.ok(not exists (select 1 from public.accounts where id = :'d')
  and (select role = 'OWNER' from public.workspace_members where workspace_id = :'wd' and account_id = :'a')
  and (select created_by is null from public.workspaces where id = :'wd'),
  '4.1 Auth 사용자 삭제 → 계정 삭제 + OWNER 넘김 (LAST_OWNER로 막히지 않음)');
select t.ok(t.gapless(:'wd'), '4.2 원장 순번 빈틈 없음');
select t.ok(not has_function_privilege('authenticated', 'private.account_withdraw_cleanup(uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.account_withdraw_finish(uuid)', 'execute'), '4.3 내부 함수 권한 없음');

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
