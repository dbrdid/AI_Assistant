-- 원격 확인: 공유 휴지통 · 회원 탈퇴 · 푸시 알림 · 초대 메일 (#32~#35)
--   DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림 (계정·공간·알림·메일 기록이 남지 않음)
--   결과는 오류 메시지 SMOKE_RESULT {...}에 항목별 true/false로 나옴. 실제 메일·푸시는 보내지 않음
do $test$
declare
  u_o uuid := gen_random_uuid(); u_e uuid := gen_random_uuid(); u_v uuid := gen_random_uuid();
  ws uuid; solo uuid; n1 uuid := gen_random_uuid(); k1 uuid := gen_random_uuid(); p1 uuid := gen_random_uuid();
  r jsonb; code text; inv jsonb; res jsonb := '{}'::jsonb; v_n integer; dev uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, jsonb_build_object('name', nm), now(), now()
    from (values (u_o, 'jobs-smoke-o@stella.test', '관리자'), (u_e, 'jobs-smoke-e@stella.test', '편집자'),
                 (u_v, 'jobs-smoke-v@stella.test', '보기')) v(id, e, nm);

  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ws := public.create_workspace('작업 스모크');
  code := public.create_invite(ws, 'EDITOR', 1, 1) ->> 'code';
  perform set_config('request.jwt.claims', json_build_object('sub', u_e, 'role', 'authenticated')::text, true);
  perform public.accept_invite(code);
  execute 'reset role';
  res := res || jsonb_build_object('J0 새 멤버 → 관리자에게 공간 소식 알림', exists (
    select 1 from public.notifications where account_id = u_o and kind = 'WORKSPACE_JOINED' and data ->> 'account_id' = u_e::text));

  -- #32 휴지통
  perform set_config('request.jwt.claims', json_build_object('sub', u_e, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', n1, 'data', jsonb_build_object('title', '휴지통', 'body', '')),
    jsonb_build_object('entity', 'tasks', 'op', 'UPSERT', 'id', k1, 'data', jsonb_build_object('title', '할 일', 'note_id', n1,
      'due_at', now() + interval '30 minutes', 'reminder_minutes', 30))));
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('entity', 'tasks', 'op', 'DELETE', 'id', k1, 'base_revision', 1, 'data', '{}'::jsonb),
    jsonb_build_object('entity', 'notes', 'op', 'DELETE', 'id', n1, 'base_revision', 1, 'data', '{}'::jsonb)));
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('entity', 'tasks', 'op', 'RESTORE', 'id', k1, 'base_revision', 2, 'data', '{}'::jsonb)));
  res := res || jsonb_build_object('J1 할 일 복구 (#32 전에는 메모만)', r ->> 'status' = 'ACCEPTED'
    and (select deleted_at is null from public.tasks where id = k1));
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('entity', 'notes', 'op', 'PURGE', 'id', n1, 'base_revision', 2, 'data', '{}'::jsonb)));
  res := res || jsonb_build_object('J2 관리자가 영구 삭제 → 메모 없음, 할 일은 남고 연결만 끊김', r ->> 'status' = 'ACCEPTED'
    and not exists (select 1 from public.notes where id = n1) and (select note_id is null from public.tasks where id = k1));
  execute 'reset role';
  res := res || jsonb_build_object('J3 원장 순번 빈틈 없음', (select count(*) = max(seq) and min(seq) = 1 from public.workspace_changes where workspace_id = ws));
  res := res || jsonb_build_object('J4 cron: 휴지통 자동 삭제 · 알림 · 메일 정리 등록', (select count(*) = 3 from cron.job
    where jobname in ('trash-purge-expired', 'push-tick', 'invite-mails-cleanup')));

  -- #34 알림
  perform private.enqueue_reminders();
  res := res || jsonb_build_object('J5 공유 할 일 마감 30분 전 알림 → 공간 멤버 둘 다', (select count(distinct account_id) = 2
    from public.notifications where ref_id = k1 and kind = 'TASK_REMINDER'));
  perform set_config('request.jwt.claims', json_build_object('sub', u_e, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.set_notification_settings('{"briefing_daily": {"on": true, "time": "07:30"}}');
  res := res || jsonb_build_object('J6 알림 설정 저장', r -> 'briefing_daily' ->> 'time' = '07:30');
  begin
    perform public.push_claim(10);
    res := res || jsonb_build_object('J7 앱은 보낼 목록을 못 가져감', false);
  exception when others then
    res := res || jsonb_build_object('J7 앱은 보낼 목록을 못 가져감', sqlstate = '42501');
  end;
  execute 'reset role';
  insert into public.devices (account_id, installation_id, platform, app_version, push_provider, push_token)
  values (u_o, 'jobs-smoke', 'ios', '1', 'EXPO', 'ExponentPushToken[jobssmokejobssmoke00]') returning id into dev;
  execute 'set local role service_role';
  r := public.push_claim(500);
  execute 'reset role';
  res := res || jsonb_build_object('J8 보낼 목록: 토큰 있는 관리자 것만, 기기 없는 편집자 것은 SKIPPED',
    exists (select 1 from jsonb_array_elements(r) x where x -> 'tokens' ? 'ExponentPushToken[jobssmokejobssmoke00]')
    and not exists (select 1 from public.notifications where account_id = u_e and status = 'PENDING'));

  -- #35 초대 메일 (발송은 안 함: 확인·기록만)
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  code := public.create_invite(ws, 'VIEWER', 1, 1) ->> 'code';
  r := public.invite_mail_prepare(u_o, code, 'friend@example.com');
  res := res || jsonb_build_object('J9 초대 메일 확인 → 보낼 내용', r ->> 'email' = 'friend@example.com' and r ->> 'kind' = 'WORKSPACE');
  begin
    perform public.invite_mail_prepare(u_e, code, 'x@example.com');
    res := res || jsonb_build_object('J10 초대한 사람만', false);
  exception when others then
    res := res || jsonb_build_object('J10 초대한 사람만', sqlerrm like 'FORBIDDEN%');
  end;
  r := public.invite_mail_result((r ->> 'mail_id')::uuid, true);
  execute 'reset role';
  res := res || jsonb_build_object('J11 보낸 결과 기록', r ->> 'status' = 'SENT');

  -- #33 탈퇴 (보기 전용 V를 넣고, 관리자 O가 탈퇴 → 편집자 E가 관리자, 혼자 공간은 삭제)
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.create_invite(ws, 'VIEWER', 1, 1);
  solo := public.create_workspace('혼자 공간');
  r := public.account_withdraw_preview();
  res := res || jsonb_build_object('J12 탈퇴 미리 보기: 같이 쓰는 공간은 넘김, 혼자 공간은 삭제',
    exists (select 1 from jsonb_array_elements(r) x where (x ->> 'workspace_id')::uuid = ws and x ->> 'action' = 'TRANSFER' and (x ->> 'next_owner_id')::uuid = u_e)
    and exists (select 1 from jsonb_array_elements(r) x where (x ->> 'workspace_id')::uuid = solo and x ->> 'action' = 'DELETE'));
  execute 'reset role';
  execute 'set local role service_role';
  r := public.account_withdraw_prepare(u_o);
  r := public.account_withdraw_finish(u_o);
  execute 'reset role';
  res := res || jsonb_build_object('J13 탈퇴: 계정 삭제, 편집자가 관리자, 혼자 공간 삭제',
    (r ->> 'deleted')::boolean and not exists (select 1 from public.accounts where id = u_o)
    and (select role = 'OWNER' from public.workspace_members where workspace_id = ws and account_id = u_e)
    and not exists (select 1 from public.workspaces where id = solo));
  res := res || jsonb_build_object('J14 공유 기록은 남고 작성자 칸만 비움', (select created_by is null from public.workspaces where id = ws)
    and exists (select 1 from public.tasks where id = k1) and not exists (select 1 from public.devices where id = dev));
  res := res || jsonb_build_object('J15 원장 순번 빈틈 없음 (탈퇴 뒤)', (select count(*) = max(seq) and min(seq) = 1 from public.workspace_changes where workspace_id = ws));
  raise exception 'SMOKE_RESULT %', res;
end
$test$;
