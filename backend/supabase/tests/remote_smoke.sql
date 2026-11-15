-- 원격 검증: DO 블록 하나로 실행하고 마지막에 일부러 예외를 내서 전부 되돌림 (테스트 계정·공간 남지 않음)
do $test$
declare
  u_o uuid := gen_random_uuid();
  u_a uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid();
  u_c uuid := gen_random_uuid();
  ws uuid; r jsonb; code1 text; code2 text; inv1 uuid; pull jsonb;
  res jsonb := '[]'::jsonb;
  msg text;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, jsonb_build_object('name', n), now(), now()
    from (values (u_o, 'smoke-o@stella.test', 'SmokeOwner'), (u_a, 'smoke-a@stella.test', 'SmokeA'),
                 (u_b, 'smoke-b@stella.test', 'SmokeB'), (u_c, 'smoke-c@stella.test', 'SmokeC')) v(id, e, n);
  res := res || jsonb_build_object('R0 가입 트리거로 계정 생성', (select count(*) = 4 from public.accounts where id in (u_o, u_a, u_b, u_c)));

  -- OWNER: 공간 + 2명 초대
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ws := public.create_workspace('원격 스모크');
  r := public.create_invite(ws, 'EDITOR', 24, 2);
  code1 := r ->> 'code'; inv1 := (r ->> 'invite_id')::uuid;
  res := res || jsonb_build_object('R1 초대 코드 형식', code1 ~ '^[A-Z2-9]{5}-[A-Z2-9]{5}$');
  begin
    perform token_hash from public.workspace_invites;
    res := res || jsonb_build_object('R2 OWNER도 token_hash 조회 불가', false);
  exception when insufficient_privilege then
    res := res || jsonb_build_object('R2 OWNER도 token_hash 조회 불가', true);
  end;
  res := res || jsonb_build_object('R3 OWNER 초대 목록 컬럼 조회', (select use_count = 0 and max_uses = 2 from public.workspace_invites where id = inv1));

  -- A: 미리보기 → 수락
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.preview_invite(lower(replace(code1, '-', '')));
  res := res || jsonb_build_object('R4 미리보기 (소문자 입력)', r ->> 'workspace_name' = '원격 스모크' and r ->> 'invited_by_name' = 'SmokeOwner' and (r ->> 'member_count')::int = 1);
  r := public.accept_invite(code1);
  res := res || jsonb_build_object('R5 수락 → EDITOR, seq 1', r ->> 'role' = 'EDITOR' and (r ->> 'seq')::int = 1);
  res := res || jsonb_build_object('R6 수락 후 공간·멤버 보임', (select count(*) = 1 from public.workspaces where id = ws) and (select count(*) = 2 from public.workspace_members where workspace_id = ws));
  begin
    perform public.create_invite(ws);
    res := res || jsonb_build_object('R7 EDITOR 초대 생성 거절', false);
  exception when others then
    res := res || jsonb_build_object('R7 EDITOR 초대 생성 거절', sqlerrm like 'FORBIDDEN%');
  end;
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', gen_random_uuid(), 'data', jsonb_build_object('title', 't', 'body', 'b'))));
  res := res || jsonb_build_object('R8 EDITOR 저장 → seq 2', r ->> 'status' = 'ACCEPTED' and (r -> 'results' -> 0 ->> 'seq')::int = 2);

  -- B: 수락(2/2) → C: 다 쓴 초대
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.accept_invite(code1);
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_c, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.accept_invite(code1);
    res := res || jsonb_build_object('R9 다 쓴 초대 거절', false);
  exception when others then
    res := res || jsonb_build_object('R9 다 쓴 초대 거절', sqlerrm like 'INVITE_USED_UP%');
  end;

  -- OWNER: B 내보내기, A를 OWNER로, 마지막 OWNER 보호
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  code2 := public.create_invite(ws, 'VIEWER', 24, 1) ->> 'code';
  begin
    perform public.leave_workspace(ws);
    res := res || jsonb_build_object('R10 혼자인 OWNER 나가기 거절', false);
  exception when others then
    res := res || jsonb_build_object('R10 혼자인 OWNER 나가기 거절', sqlerrm like 'LAST_OWNER%');
  end;
  perform public.remove_member(ws, u_b);
  perform public.change_member_role(ws, u_a, 'OWNER');
  r := public.leave_workspace(ws);
  res := res || jsonb_build_object('R11 OWNER 둘이면 나가기 가능', r ->> 'status' = 'LEFT');

  -- B: 내보내기 전에 만든 초대로 재참여 불가
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.accept_invite(code2);
    res := res || jsonb_build_object('R12 내보내진 사람 기존 초대 거절', false);
  exception when others then
    -- code2는 OWNER가 나가며 함께 취소됐으므로 REVOKED가 먼저 걸림
    res := res || jsonb_build_object('R12 내보내진 사람 기존 초대 거절', sqlerrm like 'INVITE_REVOKED%' or sqlerrm like 'INVITE_BLOCKED%');
  end;
  res := res || jsonb_build_object('R13 내보내진 B에게 공간 안 보임', (select count(*) = 0 from public.workspaces where id = ws));

  -- A(새 OWNER): pull로 멤버 변화 확인 → 공간 삭제
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  pull := public.sync_pull(ws, 0);
  res := res || jsonb_build_object('R14 pull 순서',
    (select string_agg(c ->> 'entity' || ':' || coalesce(c -> 'data' ->> 'status', '') || ':' || coalesce(c -> 'data' ->> 'role', ''), ',' order by (c ->> 'seq')::int)
       from jsonb_array_elements(pull -> 'changes') c)
    = 'workspace_members:ACTIVE:EDITOR,notes::,workspace_members:ACTIVE:EDITOR,workspace_members:REMOVED:EDITOR,workspace_members:ACTIVE:OWNER,workspace_members:LEFT:OWNER');
  r := public.delete_workspace(ws);
  res := res || jsonb_build_object('R15 공간 삭제 후 안 보임', (select count(*) = 0 from public.workspaces where id = ws));

  execute 'reset role';
  raise exception 'SMOKE_RESULT %', res;
end
$test$;
