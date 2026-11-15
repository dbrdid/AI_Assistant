-- 원격 확인: 메모 즐겨찾기 · 프로젝트 파일 직접 연결 · 팀장 권한 · 백업 (#29~#31)
--   DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림 (계정·공간·파일 기록이 남지 않음)
--   결과는 오류 메시지 SMOKE_RESULT {...}에 항목별 true/false로 나옴
do $test$
declare
  u_o uuid := gen_random_uuid(); u_e uuid := gen_random_uuid();
  ws uuid; n1 uuid := gen_random_uuid(); pl uuid := gen_random_uuid(); pn uuid := gen_random_uuid();
  ml uuid := gen_random_uuid(); me uuid := gen_random_uuid(); f1 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid(); h text := repeat('a', 64);
  r jsonb; k1 jsonb; k2 jsonb; res jsonb := '{}'::jsonb; code text;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, jsonb_build_object('name', nm), now(), now()
    from (values (u_o, 'ex-smoke-o@stella.test', '관리자'), (u_e, 'ex-smoke-e@stella.test', '팀원')) v(id, e, nm);

  -- 준비: 공간 + 편집자 초대
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ws := public.create_workspace('추가 기능 스모크');
  code := public.create_invite(ws, 'EDITOR', 1, 1) ->> 'code';
  perform set_config('request.jwt.claims', json_build_object('sub', u_e, 'role', 'authenticated')::text, true);
  perform public.accept_invite(code);

  -- 관리자: 메모 + 팀장 있는 프로젝트(PL, 팀원 = 편집자) + 팀장 없는 프로젝트(PN)
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', n1, 'data', jsonb_build_object('title', '즐겨찾기 메모', 'body', '')),
    jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', pl, 'data', jsonb_build_object('name', '팀장 있음')),
    jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', pn, 'data', jsonb_build_object('name', '팀장 없음')),
    jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', ml, 'data', jsonb_build_object('project_id', pl, 'account_id', u_o, 'name', '관리자', 'role', '팀장')),
    jsonb_build_object('entity', 'project_members', 'op', 'UPSERT', 'id', me, 'data', jsonb_build_object('project_id', pl, 'account_id', u_e, 'name', '팀원', 'role', '팀원'))));
  res := res || jsonb_build_object('X0 준비 저장', r ->> 'status' = 'ACCEPTED');

  -- 즐겨찾기 (사람마다 따로)
  r := public.set_note_favorites(ws, array[n1], true);
  res := res || jsonb_build_object('X1 즐겨찾기 추가 → 내 목록', (r ->> 'changed')::int = 1
    and exists (select 1 from jsonb_array_elements(public.list_note_favorites(ws)) f where (f ->> 'note_id')::uuid = n1));
  perform set_config('request.jwt.claims', json_build_object('sub', u_e, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('X2 다른 사람 목록엔 없음', jsonb_array_length(public.list_note_favorites(ws)) = 0);

  -- 팀장 권한
  r := public.get_project_permissions(ws);
  res := res || jsonb_build_object('X3 권한표: 팀원은 PL 불가, PN 가능', (r ->> pl::text)::boolean = false and (r ->> pn::text)::boolean = true);
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', pl, 'base_revision', 1,
         'data', jsonb_build_object('name', '팀원이 바꿈'))));
  res := res || jsonb_build_object('X4 팀원이 PL 수정 → 충돌 NOT_PROJECT_LEADER, 그대로', r ->> 'status' = 'CONFLICT'
    and r -> 'conflicts' -> 0 ->> 'reason' = 'NOT_PROJECT_LEADER'
    and (select name = '팀장 있음' from public.projects where id = pl));
  begin
    perform public.create_project_invite(pl, 'LINK');
    res := res || jsonb_build_object('X5 팀원은 PL 초대 불가', false);
  exception when others then
    res := res || jsonb_build_object('X5 팀원은 PL 초대 불가', sqlerrm like 'FORBIDDEN%');
  end;
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'projects', 'op', 'UPSERT', 'id', pn, 'base_revision', 1,
         'data', jsonb_build_object('name', '팀원도 바꿈'))));
  res := res || jsonb_build_object('X6 팀장 없는 PN은 수정 가능', r ->> 'status' = 'ACCEPTED');

  -- 프로젝트 파일 직접 연결 (편집자가 올린 첨부)
  execute 'reset role';
  perform public.asset_prepare(u_e, f1, 'ATTACHMENT', ws, '자료.pdf', 'application/pdf', 5, h);
  perform public.asset_complete(u_e, f1, 5, h);
  execute 'set local role authenticated';
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'project_files', 'op', 'UPSERT',
         'data', jsonb_build_object('project_id', pl, 'asset_id', f1))));
  res := res || jsonb_build_object('X7 팀원이 PL에 파일 연결 (메모 없이)', r ->> 'status' = 'ACCEPTED'
    and exists (select 1 from public.project_files where project_id = pl and asset_id = f1));
  r := public.sync_snapshot(ws);
  res := res || jsonb_build_object('X8 전체 받기에 project_files', exists (
    select 1 from jsonb_array_elements(r -> 'project_files') x where (x ->> 'asset_id')::uuid = f1));
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('entity', 'project_files', 'op', 'DELETE', 'data', jsonb_build_object('project_id', pl, 'asset_id', f1)),
    jsonb_build_object('entity', 'project_files', 'op', 'UPSERT', 'data', jsonb_build_object('project_id', pn, 'asset_id', f1))));
  res := res || jsonb_build_object('X9 다른 프로젝트로 옮김', r ->> 'status' = 'ACCEPTED'
    and (select array_agg(project_id) = array[pn] from public.project_files where asset_id = f1));

  -- 백업: 계정별 키 (처음 제안한 키가 남음) + 등록·목록·보관 개수
  k1 := public.backup_key(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'));
  k2 := public.backup_key(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'));
  res := res || jsonb_build_object('X10 백업 키: 처음 것이 남음', (k1 ->> 'created')::boolean and not (k2 ->> 'created')::boolean and k1 ->> 'key' = k2 ->> 'key');
  execute 'reset role';
  perform public.asset_prepare(u_e, b1, 'BACKUP', null, 'stella-backup', 'application/octet-stream', 100, h);
  perform public.asset_complete(u_e, b1, 100, h);
  perform public.asset_prepare(u_e, b2, 'BACKUP', null, 'stella-backup', 'application/octet-stream', 100, h);
  perform public.asset_complete(u_e, b2, 100, h);
  execute 'set local role authenticated';
  r := public.backup_register(b1, 'MANUAL', '{"memos": 3}', '스모크 기기', 'smoke', 1);
  res := res || jsonb_build_object('X11 백업 등록', (r ->> 'ok')::boolean and r -> 'backup' -> 'counts' ->> 'memos' = '3');
  r := public.backup_register(b2, 'AUTO', '{}', null, null, 1);
  res := res || jsonb_build_object('X12 보관 1개 → 오래된 것 지울 목록', r -> 'remove_asset_ids' = jsonb_build_array(b1) and (r -> 'backup' ->> 'auto')::boolean);
  res := res || jsonb_build_object('X13 내 백업 목록', jsonb_array_length(public.list_backups('new')) = 2);
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('X14 다른 사람 백업은 안 보임', jsonb_array_length(public.list_backups('new')) = 0
    and not exists (select 1 from public.backups where asset_id in (b1, b2)));
  begin
    perform public.backup_register(b1);
    res := res || jsonb_build_object('X15 남의 파일로 백업 등록 불가', false);
  exception when others then
    res := res || jsonb_build_object('X15 남의 파일로 백업 등록 불가', sqlerrm like 'NOT_FOUND%');
  end;
  execute 'reset role';
  res := res || jsonb_build_object('X16 키는 앱에서 표로 못 읽음', not has_table_privilege('authenticated', 'private.backup_keys', 'select'));
  res := res || jsonb_build_object('X17 원장 순번 빈틈 없음', (select count(*) = max(seq) and min(seq) = 1 from public.workspace_changes where workspace_id = ws));
  raise exception 'SMOKE_RESULT %', res;
end
$test$;
