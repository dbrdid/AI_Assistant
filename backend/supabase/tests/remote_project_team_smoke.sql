-- 원격 확인: 프로젝트 팀원·초대 (DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림)
--   결과는 오류 메시지 SMOKE_RESULT {...}에 항목별 true/false로 나옴
do $test$
declare
  u_o uuid := gen_random_uuid(); u_n uuid := gen_random_uuid(); u_v uuid := gen_random_uuid();
  ws uuid; p1 uuid := gen_random_uuid(); p2 uuid := gen_random_uuid(); m1 uuid := gen_random_uuid();
  r jsonb; inv jsonb; j jsonb; res jsonb := '{}'::jsonb; mid uuid; s0 bigint; code text;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, jsonb_build_object('name', nm), now(), now()
    from (values (u_o, 'pt-smoke-o@stella.test', '관리자'), (u_n, 'pt-smoke-n@stella.test', '새팀원'), (u_v, 'pt-smoke-v@stella.test', '보기')) v(id, e, nm);

  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ws := public.create_workspace('팀원 스모크');
  code := public.create_invite(ws, 'VIEWER', 1, 1) ->> 'code';
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', p1, 'data', jsonb_build_object('name', '발표')),
    jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', p2, 'data', jsonb_build_object('name', '개발')),
    jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', m1, 'data', jsonb_build_object('project_id', p1, 'account_id', u_o, 'name', '관리자', 'role', '팀장'))));
  res := res || jsonb_build_object('T1 프로젝트 + 팀장 저장', r ->> 'status' = 'ACCEPTED' and (select role = '팀장' from public.project_members where id = m1));
  inv := public.create_project_invite(p1, 'LINK');
  res := res || jsonb_build_object('T2 링크 초대 → 코드·남은 횟수', inv ->> 'code' ~ '^[A-Z2-9]{5}-[A-Z2-9]{5}$' and (inv -> 'quota' ->> 'remaining')::int = 9);
  begin
    perform public.create_project_invite(p1, 'EMAIL', 'nope');
    res := res || jsonb_build_object('T3 이메일 형식 검사', false);
  exception when others then
    res := res || jsonb_build_object('T3 이메일 형식 검사', sqlerrm like 'INVALID_EMAIL%');
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', u_n, 'role', 'authenticated')::text, true);
  j := public.join_with_invite(inv ->> 'code');
  mid := (j -> 'projects' -> 0 ->> 'member_id')::uuid;
  res := res || jsonb_build_object('T4 코드로 참여 → 공간 멤버 + 프로젝트 팀원', j ->> 'role' = 'EDITOR'
    and (select name = '새팀원' and role = '팀원' and account_id = u_n from public.project_members where id = mid));
  s0 := (j ->> 'last_seq')::bigint;   -- 참여 결과가 돌려준 마지막 순번
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', mid, 'base_revision', 1,
         'data', jsonb_build_object('role', '디자이너', 'project_id', p2))));
  -- 11/15 팀장 권한: 팀장이 있는 프로젝트의 팀원 관리는 팀장(또는 공간 관리자)만 → 충돌로 돌려줌, 행은 그대로
  res := res || jsonb_build_object('T5a 팀원은 팀원 관리 불가 (충돌 NOT_PROJECT_LEADER)', r ->> 'status' = 'CONFLICT'
    and r -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER'
    and (select role = '팀원' and project_id = p1 from public.project_members where id = mid));
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', mid, 'base_revision', 1,
         'data', jsonb_build_object('role', '디자이너', 'project_id', p2))));
  res := res || jsonb_build_object('T5 관리자가 역할 수정 + 다른 프로젝트로 이동', r ->> 'status' = 'ACCEPTED'
    and (select role = '디자이너' and project_id = p2 from public.project_members where id = mid));
  perform set_config('request.jwt.claims', json_build_object('sub', u_n, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('T6 다른 기기가 받을 변경 (sync_pull)', exists (
    select 1 from jsonb_array_elements(public.sync_pull(ws, s0, 100) -> 'changes') c where c ->> 'entity' = 'project_members' and c ->> 'key' = mid::text));

  perform set_config('request.jwt.claims', json_build_object('sub', u_v, 'role', 'authenticated')::text, true);
  perform public.accept_invite(code);
  begin
    perform public.create_project_invite(p1, 'LINK');
    res := res || jsonb_build_object('T7 보기 전용은 초대 불가', false);
  exception when others then
    res := res || jsonb_build_object('T7 보기 전용은 초대 불가', sqlerrm like 'FORBIDDEN%');
  end;
  r := public.sync_snapshot(ws);
  res := res || jsonb_build_object('T8 전체 받기에 팀원·초대 (코드 없음)', jsonb_array_length(r -> 'project_members') = 2
    and jsonb_array_length(r -> 'project_invites') = 1 and not (r -> 'project_invites' -> 0 ? 'token_hash'));
  execute 'reset role';
  res := res || jsonb_build_object('T9 초대 사용 완료', (select status = 'ACCEPTED' from public.project_invites where id = (inv ->> 'project_invite_id')::uuid));
  res := res || jsonb_build_object('T10 원장 순번 빈틈 없음', (select count(*) = max(seq) and min(seq) = 1 from public.workspace_changes where workspace_id = ws));
  raise exception 'SMOKE_RESULT %', res;
end
$test$;
