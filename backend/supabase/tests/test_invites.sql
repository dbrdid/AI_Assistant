-- 공간 초대·멤버 관리 시나리오 테스트 (로컬 전용)
--   실행: psql -v ON_ERROR_STOP=1 -f test_invites.sql
--   결과: t.results에 이름·통과 여부. 마지막에 실패 목록 출력
\set QUIET on
\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------
-- 테스트 도구
-- ---------------------------------------------------------------------
drop schema if exists t cascade;
create schema t;
create table t.results (n serial, name text, pass boolean, detail text);
grant usage on schema t to authenticated, anon;
grant insert, select on t.results to authenticated, anon;
grant usage on sequence t.results_n_seq to authenticated, anon;

create function t.ok(p_cond boolean, p_name text, p_detail text default null) returns void
language sql as $$ insert into t.results (name, pass, detail) values (p_name, coalesce(p_cond, false), p_detail) $$;

-- p_sql 실행 시 "CODE: ..." 로 시작하는 오류가 나야 통과 (실행 결과는 되돌려짐)
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
grant execute on all functions in schema t to authenticated, anon;

-- ---------------------------------------------------------------------
-- 사용자
-- ---------------------------------------------------------------------
\set owner '00000000-0000-4000-8000-0000000000a0'
\set alice '00000000-0000-4000-8000-0000000000a1'
\set bob   '00000000-0000-4000-8000-0000000000b0'
\set carol '00000000-0000-4000-8000-0000000000c0'
\set xout  '00000000-0000-4000-8000-0000000000f0'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'owner', 'owner@test.dev', '{"name":"Owner"}'),
  (:'alice', 'alice@test.dev', '{"name":"Alice"}'),
  (:'bob',   'bob@test.dev',   '{"name":"Bob"}'),
  (:'carol', 'carol@test.dev', '{"name":"Carol"}'),
  (:'xout',  'x@test.dev',     '{"name":"Outsider"}');

\set as_owner 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_alice 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_bob   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000b0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_carol 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000c0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_xout  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000f0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_anon  'reset role; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', false); set role anon;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

-- ---------------------------------------------------------------------
-- 1. 초대 만들기
-- ---------------------------------------------------------------------
:as_owner
select public.create_workspace('스텔라 팀') as ws \gset
select (public.create_invite(:'ws', 'EDITOR', 168, 2)) as inv1 \gset
select :'inv1'::jsonb ->> 'code' as code1, :'inv1'::jsonb ->> 'invite_id' as inv1_id \gset
select t.ok(:'code1' ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$', '1.1 코드 형식 XXXXX-XXXXX', :'code1');
select t.ok((:'inv1'::jsonb ->> 'max_uses')::int = 2 and :'inv1'::jsonb ->> 'role' = 'EDITOR', '1.2 반환값 역할·인원');
select t.ok(abs(extract(epoch from ((:'inv1'::jsonb ->> 'expires_at')::timestamptz - now() - interval '168 hours'))) < 5, '1.3 기본 유효 기간 7일');
select t.err(format('select public.create_invite(%L, %L)', :'ws', 'OWNER'), 'INVALID_REQUEST', '1.4 OWNER 역할 초대 거절');
select t.err(format('select public.create_invite(%L, %L, 0)', :'ws', 'EDITOR'), 'INVALID_REQUEST', '1.5 유효 기간 0 거절');
select t.err(format('select public.create_invite(%L, %L, 721)', :'ws', 'EDITOR'), 'INVALID_REQUEST', '1.6 유효 기간 30일 초과 거절');
select t.err(format('select public.create_invite(%L, %L, 1, 51)', :'ws', 'EDITOR'), 'INVALID_REQUEST', '1.7 인원 50 초과 거절');
:as_xout
select t.err(format('select public.create_invite(%L)', :'ws'), 'FORBIDDEN', '1.8 외부인 초대 생성 거절');
:as_anon
select t.err(format('select public.create_invite(%L)', :'ws'), 'permission denied', '1.9 비로그인 실행 권한 없음');
select t.err(format('select public.accept_invite(%L)', :'code1'), 'permission denied', '1.10 비로그인 수락 권한 없음');
:as_admin
select t.ok((select token_hash from public.workspace_invites where id = :'inv1_id')
            = encode(sha256(convert_to(replace(:'code1', '-', ''), 'UTF8')), 'hex'), '1.11 DB에는 해시만 저장');
select t.ok(not exists (select 1 from public.workspace_invites where token_hash like '%' || replace(:'code1', '-', '') || '%'), '1.12 코드 원문은 저장 안 됨');

-- ---------------------------------------------------------------------
-- 2. 미리보기
-- ---------------------------------------------------------------------
:as_alice
select public.preview_invite(:'code1') as pv \gset
select t.ok(:'pv'::jsonb ->> 'workspace_name' = '스텔라 팀'
        and :'pv'::jsonb ->> 'role' = 'EDITOR'
        and :'pv'::jsonb ->> 'invited_by_name' = 'Owner'
        and (:'pv'::jsonb ->> 'member_count')::int = 1
        and (:'pv'::jsonb ->> 'already_member')::boolean = false
        and (:'pv'::jsonb ->> 'blocked')::boolean = false, '2.1 미리보기 내용', :'pv');
select t.ok((public.preview_invite('  ' || lower(replace(:'code1', '-', ' ')) || ' ')) ->> 'workspace_id' = :'ws', '2.2 소문자·공백 입력도 인식');
select t.err('select public.preview_invite(''hello'')', 'INVITE_INVALID', '2.3 형식 틀린 코드');
select t.err('select public.preview_invite(''AAAAA-AAAAA'')', 'INVITE_INVALID', '2.4 없는 코드');
select t.err('select public.preview_invite(''OOOOO-11111'')', 'INVITE_INVALID', '2.5 헷갈리는 글자(O·1) 코드는 형식 오류');

-- ---------------------------------------------------------------------
-- 3. 수락
-- ---------------------------------------------------------------------
:as_admin
select auth_epoch as epoch0 from public.workspaces where id = :'ws' \gset
:as_alice
select t.ok((select count(*) from public.workspaces) = 0, '3.0 수락 전에는 공간이 안 보임');
select public.accept_invite(:'code1') as acc \gset
select t.ok(:'acc'::jsonb ->> 'role' = 'EDITOR' and (:'acc'::jsonb ->> 'already_member')::boolean = false
        and (:'acc'::jsonb ->> 'seq')::int = 1, '3.1 수락 결과', :'acc');
select t.ok((select count(*) from public.workspaces) = 1, '3.2 수락 후 공간이 보임');
select t.ok((select count(*) from public.workspace_members where workspace_id = :'ws') = 2, '3.3 멤버 목록 2명');
select t.ok((select display_name from public.profiles where account_id = :'owner') = 'Owner', '3.4 같은 공간 OWNER 이름이 보임');
select t.ok((public.accept_invite(:'code1')) ->> 'already_member' = 'true', '3.5 다시 수락하면 already_member');
select t.ok((public.preview_invite(:'code1')) ->> 'already_member' = 'true', '3.6 미리보기에도 already_member');
:as_admin
select t.ok((select use_count from public.workspace_invites where id = :'inv1_id') = 1, '3.7 이미 멤버면 사용 횟수 안 씀');
select t.ok((select status from public.workspace_invites where id = :'inv1_id') = 'PENDING', '3.8 1/2 사용 → PENDING 유지');
select t.ok((select auth_epoch from public.workspaces where id = :'ws') > :epoch0, '3.9 참여 시 auth_epoch 증가');
select t.ok((select invite_id from public.workspace_members where workspace_id = :'ws' and account_id = :'alice') = :'inv1_id', '3.10 멤버에 초대 id 기록');
:as_bob
select t.ok((public.accept_invite(:'code1')) ->> 'role' = 'EDITOR', '3.11 Bob 수락 (2/2)');
:as_admin
select t.ok((select status = 'ACCEPTED' and use_count = 2 and accepted_by = :'bob' from public.workspace_invites where id = :'inv1_id'), '3.12 인원 다 차면 ACCEPTED');
:as_carol
select t.err(format('select public.accept_invite(%L)', :'code1'), 'INVITE_USED_UP', '3.13 다 쓴 초대 거절');
select t.err(format('select public.preview_invite(%L)', :'code1'), 'INVITE_USED_UP', '3.14 다 쓴 초대 미리보기도 거절');

-- ---------------------------------------------------------------------
-- 4. 권한: EDITOR는 초대·역할·내보내기 불가, 초대 목록 안 보임
-- ---------------------------------------------------------------------
:as_alice
select t.err(format('select public.create_invite(%L)', :'ws'), 'FORBIDDEN', '4.1 EDITOR 초대 생성 거절');
select t.err(format('select public.change_member_role(%L, %L, %L)', :'ws', :'bob', 'VIEWER'), 'FORBIDDEN', '4.2 EDITOR 역할 변경 거절');
select t.err(format('select public.remove_member(%L, %L)', :'ws', :'bob'), 'FORBIDDEN', '4.3 EDITOR 내보내기 거절');
select t.err(format('select public.revoke_invite(%L)', :'inv1_id'), 'FORBIDDEN', '4.4 EDITOR 초대 취소 거절');
select t.ok((select count(*) from public.workspace_invites) = 0, '4.5 EDITOR에게 초대 목록 안 보임');
:as_owner
select t.ok((select count(*) from public.workspace_invites where workspace_id = :'ws') = 1, '4.6 OWNER는 초대 목록 보임');
select t.err('select token_hash from public.workspace_invites', 'permission denied', '4.7 OWNER도 token_hash는 못 봄');
select t.ok((select use_count from public.workspace_invites where id = :'inv1_id') = 2, '4.8 목록 컬럼 조회 가능');
:as_xout
select t.err(format('select public.revoke_invite(%L)', :'inv1_id'), 'NOT_FOUND', '4.9 외부인은 초대 존재도 모름');

-- ---------------------------------------------------------------------
-- 5. 취소 · 만료
-- ---------------------------------------------------------------------
:as_owner
select (public.create_invite(:'ws', 'VIEWER', 1, 1)) as inv2 \gset
select :'inv2'::jsonb ->> 'code' as code2, :'inv2'::jsonb ->> 'invite_id' as inv2_id \gset
select t.ok((public.revoke_invite(:'inv2_id')) ->> 'status' = 'REVOKED', '5.1 초대 취소');
select t.ok((public.revoke_invite(:'inv2_id')) ->> 'status' = 'REVOKED', '5.2 다시 취소해도 같은 결과');
:as_carol
select t.err(format('select public.accept_invite(%L)', :'code2'), 'INVITE_REVOKED', '5.3 취소된 초대 거절');
:as_owner
select (public.create_invite(:'ws', 'VIEWER', 1, 1)) as inv3 \gset
select :'inv3'::jsonb ->> 'code' as code3, :'inv3'::jsonb ->> 'invite_id' as inv3_id \gset
:as_admin
update public.workspace_invites set created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id = :'inv3_id';
:as_carol
select t.err(format('select public.accept_invite(%L)', :'code3'), 'INVITE_EXPIRED', '5.4 기간 지난 초대 거절');
:as_owner
select public.create_invite(:'ws', 'VIEWER', 24, 1) as inv4 \gset
:as_admin
select t.ok((select status from public.workspace_invites where id = :'inv3_id') = 'EXPIRED', '5.5 새 초대 만들 때 지난 초대는 EXPIRED로 정리');

-- ---------------------------------------------------------------------
-- 6. 역할 변경 + sync_push 권한 반영
-- ---------------------------------------------------------------------
:as_owner
select t.ok((public.change_member_role(:'ws', :'bob', 'VIEWER')) ->> 'role' = 'VIEWER', '6.1 Bob → VIEWER');
select t.ok((public.change_member_role(:'ws', :'bob', 'VIEWER')) ->> 'unchanged' = 'true', '6.2 같은 역할이면 unchanged');
select t.err(format('select public.change_member_role(%L, %L, %L)', :'ws', :'bob', 'ADMIN'), 'INVALID_REQUEST', '6.3 없는 역할 거절');
select t.err(format('select public.change_member_role(%L, %L, %L)', :'ws', :'carol', 'EDITOR'), 'NOT_FOUND', '6.4 멤버 아닌 사람 역할 변경 거절');
:as_bob
select t.err(format('select public.sync_push(%L, gen_random_uuid(), %L::jsonb)', :'ws',
         '[{"entity":"notes","op":"UPSERT","id":"' || gen_random_uuid() || '","data":{"title":"b","body":"x"}}]'),
         'FORBIDDEN', '6.5 VIEWER가 된 Bob은 저장 불가');
:as_alice
select public.sync_push(:'ws', gen_random_uuid(), ('[{"entity":"notes","op":"UPSERT","id":"' || gen_random_uuid() || '","data":{"title":"a","body":"x"}}]')::jsonb) as push1 \gset
select t.ok(:'push1'::jsonb ->> 'status' = 'ACCEPTED', '6.6 EDITOR Alice 저장 성공', :'push1');
:as_admin
select t.ok((select last_seq from public.workspace_sync_heads where workspace_id = :'ws') = 4
        and (select count(*) from public.workspace_changes where workspace_id = :'ws') = 4, '6.7 멤버 변경과 메모가 같은 seq 줄에 기록 (1~4)');

-- ---------------------------------------------------------------------
-- 7. 마지막 OWNER 보호 · OWNER 넘기기 · 나가기
-- ---------------------------------------------------------------------
:as_owner
select t.err(format('select public.change_member_role(%L, %L, %L)', :'ws', :'owner', 'EDITOR'), 'LAST_OWNER', '7.1 혼자인 OWNER 강등 거절');
select t.err(format('select public.leave_workspace(%L)', :'ws'), 'LAST_OWNER', '7.2 혼자인 OWNER 나가기 거절');
select t.err(format('select public.remove_member(%L, %L)', :'ws', :'owner'), 'INVALID_REQUEST', '7.3 본인 내보내기 거절');
select public.create_invite(:'ws', 'EDITOR', 24, 3) as inv5 \gset
select :'inv5'::jsonb ->> 'invite_id' as inv5_id \gset
select t.ok((public.change_member_role(:'ws', :'alice', 'OWNER')) ->> 'role' = 'OWNER', '7.4 Alice를 OWNER로');
select t.ok((public.leave_workspace(:'ws')) ->> 'status' = 'LEFT', '7.5 OWNER가 둘이면 나갈 수 있음');
select t.ok((select count(*) from public.workspaces) = 0, '7.6 나간 뒤 공간이 안 보임');
select t.err(format('select public.sync_pull(%L, 0)', :'ws'), 'FORBIDDEN', '7.7 나간 뒤 받기 거절');
select t.ok((public.leave_workspace(:'ws')) ->> 'status' = 'LEFT', '7.8 다시 나가기는 그대로 LEFT');
:as_admin
select t.ok((select count(*) from public.workspace_invites where workspace_id = :'ws' and invited_by = :'owner' and status = 'PENDING') = 0,
            '7.9 OWNER가 아니게 되면 그 사람이 만든 초대는 취소');
select t.ok((select status from public.workspace_invites where id = :'inv5_id') = 'REVOKED', '7.10 (inv5 취소 확인)');

-- ---------------------------------------------------------------------
-- 8. 내보내기 · 재참여 규칙
-- ---------------------------------------------------------------------
:as_alice
select public.create_invite(:'ws', 'EDITOR', 24, 5) as inv6 \gset
select :'inv6'::jsonb ->> 'code' as code6 \gset
select t.ok((public.remove_member(:'ws', :'bob')) ->> 'status' = 'REMOVED', '8.1 Bob 내보내기');
select t.err(format('select public.remove_member(%L, %L)', :'ws', :'bob'), 'NOT_FOUND', '8.2 이미 내보낸 사람 다시 내보내기 거절');
:as_bob
select t.ok((select count(*) from public.workspaces) = 0, '8.3 내보내진 Bob에게 공간 안 보임');
select t.err(format('select public.sync_snapshot(%L)', :'ws'), 'FORBIDDEN', '8.4 내보내진 Bob 스냅샷 거절');
select t.ok((public.preview_invite(:'code6')) ->> 'blocked' = 'true', '8.5 내보내기 전에 만든 초대 → 미리보기 blocked');
select t.err(format('select public.accept_invite(%L)', :'code6'), 'INVITE_BLOCKED', '8.6 내보내기 전에 만든 초대로는 재참여 불가');
select t.err(format('select public.leave_workspace(%L)', :'ws'), 'FORBIDDEN', '8.7 내보내진 사람 나가기 거절');
:as_alice
select (public.create_invite(:'ws', 'VIEWER', 24, 1)) ->> 'code' as code7 \gset
:as_bob
select t.ok((public.accept_invite(:'code7')) ->> 'role' = 'VIEWER', '8.8 내보낸 뒤 새로 만든 초대로는 재참여');
:as_owner
select t.ok((public.accept_invite(:'code6')) ->> 'role' = 'EDITOR', '8.9 스스로 나간 사람은 기존 초대로 재참여 가능');
:as_admin
select t.ok((select status = 'ACTIVE' and ended_at is null and role = 'EDITOR' from public.workspace_members where workspace_id = :'ws' and account_id = :'owner'), '8.10 재참여 시 행 재사용 (ACTIVE, ended_at 비움)');

-- ---------------------------------------------------------------------
-- 9. 동기화로 멤버 변화 받기
-- ---------------------------------------------------------------------
:as_alice
select public.sync_pull(:'ws', 0) as pull \gset
select t.ok((select string_agg(c ->> 'entity' || ':' || coalesce(c -> 'data' ->> 'status', '') || ':' || coalesce(c -> 'data' ->> 'role', ''), ',' order by (c ->> 'seq')::int)
               from jsonb_array_elements(:'pull'::jsonb -> 'changes') c)
            = 'workspace_members:ACTIVE:EDITOR,workspace_members:ACTIVE:EDITOR,workspace_members:ACTIVE:VIEWER,notes::,'
              'workspace_members:ACTIVE:OWNER,workspace_members:LEFT:OWNER,workspace_members:REMOVED:VIEWER,'
              'workspace_members:ACTIVE:VIEWER,workspace_members:ACTIVE:EDITOR',
            '9.1 pull 순서: 참여·역할·나감·내보냄·재참여', :'pull');
select t.ok((select bool_and(c -> 'data' ? 'display_name' and c -> 'data' ->> 'workspace_id' = :'ws')
               from jsonb_array_elements(:'pull'::jsonb -> 'changes') c where c ->> 'entity' = 'workspace_members'),
            '9.2 멤버 변경 data에 이름·공간 id 포함');
select t.ok((select c -> 'data' ->> 'display_name' from jsonb_array_elements(:'pull'::jsonb -> 'changes') c where (c ->> 'seq')::int = 1) = 'Alice', '9.3 첫 변경 = Alice 참여');
select t.ok((public.sync_snapshot(:'ws')) -> 'members' @> '[{"display_name":"Bob","role":"VIEWER","status":"ACTIVE"}]', '9.4 스냅샷 멤버 목록 반영');

-- ---------------------------------------------------------------------
-- 10. 초대 개수 제한
-- ---------------------------------------------------------------------
:as_alice
select count(*) as pending_now from public.workspace_invites where workspace_id = :'ws' and status = 'PENDING' \gset
select public.create_invite(:'ws') from generate_series(1, 20 - :pending_now) \g /dev/null
select t.err(format('select public.create_invite(%L)', :'ws'), 'TOO_MANY_INVITES', '10.1 사용 가능한 초대 20개 제한');
select public.revoke_invite((select id from public.workspace_invites where workspace_id = :'ws' and status = 'PENDING' limit 1)) \g /dev/null
select t.ok((public.create_invite(:'ws')) ? 'code', '10.2 하나 취소하면 다시 만들 수 있음');

-- ---------------------------------------------------------------------
-- 11. 공간 삭제
-- ---------------------------------------------------------------------
:as_alice
select public.revoke_invite((select id from public.workspace_invites where workspace_id = :'ws' and status = 'PENDING' limit 1)) \g /dev/null
select (public.create_invite(:'ws', 'EDITOR', 24, 1)) ->> 'code' as code8 \gset
:as_bob
select t.err(format('select public.delete_workspace(%L)', :'ws'), 'FORBIDDEN', '11.1 VIEWER 공간 삭제 거절');
:as_alice
select t.ok((public.delete_workspace(:'ws')) ->> 'deleted' = 'true', '11.2 OWNER 공간 삭제');
select t.ok((select count(*) from public.workspaces) = 0, '11.3 삭제 후 공간 안 보임');
select t.err(format('select public.sync_pull(%L, 0)', :'ws'), 'FORBIDDEN', '11.4 삭제 후 받기 거절');
select t.err(format('select public.create_invite(%L)', :'ws'), 'FORBIDDEN', '11.5 삭제 후 초대 생성 거절');
select t.err(format('select public.leave_workspace(%L)', :'ws'), 'NOT_FOUND', '11.6 삭제 후 나가기 → NOT_FOUND');
:as_carol
select t.err(format('select public.accept_invite(%L)', :'code8'), 'INVITE_INVALID', '11.7 삭제된 공간 초대 거절');
:as_admin
select t.ok((select count(*) from public.workspace_invites where workspace_id = :'ws' and status = 'PENDING') = 0, '11.8 삭제 시 남은 초대 모두 취소');

-- ---------------------------------------------------------------------
-- 12. 코드 생성 품질
-- ---------------------------------------------------------------------
:as_admin
with c as (select private.new_invite_code() as code from generate_series(1, 5000))
select t.ok(count(distinct code) = 5000 and bool_and(code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$'), '12.1 코드 5000개 중복 없음·문자 범위')
  from c;
with c as (select private.new_invite_code() as code from generate_series(1, 4000)),
     ch as (select substr(code, i, 1) as ch from c, generate_series(1, 10) i),
     f as (select ch, count(*) as n from ch group by ch)
select t.ok(count(*) = 31 and min(n) > 1000 and max(n) < 1600, '12.2 31개 글자가 고르게 나옴', min(n) || '~' || max(n))
  from f;

-- ---------------------------------------------------------------------
-- 결과
-- ---------------------------------------------------------------------
:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
