-- 원격 확인: 가짜 결제 (DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림 → 테스트 계정·결제 기록이 안 남음)
--   결과는 오류 메시지 SMOKE_RESULT {...}에 항목별 true/false로 나옴
do $test$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  rid uuid := gen_random_uuid(); r jsonb; s jsonb; res jsonb := '{}'::jsonb; n int;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}'::jsonb, now(), now()
    from (values (u1, 'bill-smoke-1@stella.test'), (u2, 'bill-smoke-2@stella.test')) v(id, e);

  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  s := public.get_my_subscription();
  res := res || jsonb_build_object('B1 가입 직후 FREE', s ->> 'state' = 'FREE' and (s -> 'price_krw' ->> 'PRO')::int = 4900);
  r := public.subscription_checkout('PRO', gen_random_uuid(), 'DECLINE');
  res := res || jsonb_build_object('B2 결제 실패 시연 → FREE 그대로', r ->> 'code' = 'PAYMENT_DECLINED' and r -> 'subscription' ->> 'plan' = 'FREE');
  r := public.subscription_checkout('PRO', rid);
  res := res || jsonb_build_object('B3 구독 → SUBSCRIBED 4,900원', r ->> 'action' = 'SUBSCRIBED' and (r -> 'payment' ->> 'amount_krw')::int = 4900);
  r := public.subscription_checkout('PRO', rid);
  res := res || jsonb_build_object('B4 같은 요청 재시도 → 결제 1번', (r ->> 'replayed')::boolean and (select count(*) from public.payments where status = 'PAID') = 1);
  r := public.subscription_cancel();
  res := res || jsonb_build_object('B5 해지 → CANCELING, 다음 결제 없음', r -> 'subscription' ->> 'state' = 'CANCELING' and r -> 'subscription' -> 'next_payment_at' = 'null'::jsonb);
  r := public.subscription_checkout('PRO', gen_random_uuid());
  res := res || jsonb_build_object('B6 해지 예약 중 PRO → RESUMED', r ->> 'action' = 'RESUMED');
  begin
    perform public.subscription_checkout('GOLD', gen_random_uuid());
    res := res || jsonb_build_object('B7 없는 요금제 → INVALID_REQUEST', false);
  exception when others then
    res := res || jsonb_build_object('B7 없는 요금제 → INVALID_REQUEST', sqlerrm like 'INVALID_REQUEST%');
  end;
  begin
    perform private.subscription_tick();
    res := res || jsonb_build_object('B8 정리 함수는 앱에서 못 부름', false);
  exception when others then
    res := res || jsonb_build_object('B8 정리 함수는 앱에서 못 부름', sqlerrm like 'permission denied%');
  end;
  execute 'reset role';
  res := res || jsonb_build_object('B9 PRO 한도 (녹음 600분)', (private.stt_minutes_left(u1) ->> 'limit_minutes')::int = 600);

  -- 기간 끝 (자동 연장): 기간을 과거로 옮기고 cron 함수 실행
  update public.subscriptions set current_period_start = now() - interval '1 month' - interval '1 hour', current_period_end = now() - interval '1 hour' where account_id = u1;
  n := private.subscription_tick();
  res := res || jsonb_build_object('B10 기간 끝 → 가짜 자동 결제로 연장', n >= 1
    and (select current_period_end > now() from public.subscriptions where account_id = u1)
    and (select count(*) = 1 from public.payments where account_id = u1 and kind = 'RENEWAL'));
  -- 해지 후 기간 끝 → FREE
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.subscription_cancel();
  execute 'reset role';
  update public.subscriptions set current_period_start = now() - interval '1 month' - interval '1 hour', current_period_end = now() - interval '1 hour' where account_id = u1;
  perform private.subscription_tick();
  res := res || jsonb_build_object('B11 해지 후 기간 끝 → FREE, 한도 60분', (select plan = 'FREE' from public.subscriptions where account_id = u1)
    and (private.stt_minutes_left(u1) ->> 'limit_minutes')::int = 60);

  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  res := res || jsonb_build_object('B12 남의 결제 내역 안 보임', (select count(*) = 0 from public.payments));
  -- Team 요금제 (#28)
  r := public.subscription_checkout('TEAM', gen_random_uuid());
  res := res || jsonb_build_object('B14 FREE → TEAM 9,900원 (다음 결제 9,900원)', r ->> 'action' = 'SUBSCRIBED' and r -> 'payment' ->> 'plan' = 'TEAM'
    and (r -> 'payment' ->> 'amount_krw')::int = 9900 and (r -> 'subscription' ->> 'next_payment_krw')::int = 9900);
  perform public.create_workspace('bill-smoke Team 공간');
  execute 'reset role';
  res := res || jsonb_build_object('B15 TEAM: AI 한도 = PRO(녹음 600분), 초대 200회, 내 공간 TEAM(첨부 10GB)',
    (private.stt_minutes_left(u2) ->> 'limit_minutes')::int = 600 and (private.project_invite_quota(u2) ->> 'limit')::int = 200
    and private.workspace_plan((select w.id from public.workspaces w where w.created_by = u2 order by w.created_at desc limit 1)) = 'TEAM'
    and private.storage_quota_bytes('ATTACHMENT', 'TEAM') = 10737418240);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.subscription_checkout('PRO', gen_random_uuid());
  execute 'reset role';
  res := res || jsonb_build_object('B16 TEAM → PRO 바로 변경(CHANGED) 4,900원, 초대 50회', r ->> 'action' = 'CHANGED' and r ->> 'previous_plan' = 'TEAM'
    and (r -> 'payment' ->> 'amount_krw')::int = 4900 and (private.project_invite_quota(u2) ->> 'limit')::int = 50);
  res := res || jsonb_build_object('B17 첨부 용량이 요금제별 (asset_prepare 패치)',
    position('private.workspace_plan(p_workspace_id)' in pg_get_functiondef('public.asset_prepare(uuid, uuid, text, uuid, text, text, bigint, text)'::regprocedure)) > 0
    and position('private.account_plan(p_account_id)' in pg_get_functiondef('public.asset_prepare(uuid, uuid, text, uuid, text, text, bigint, text)'::regprocedure)) > 0);
  res := res || jsonb_build_object('B13 cron 등록 (매분)', (select count(*) = 1 from cron.job where jobname = 'subscription-tick' and schedule = '* * * * *'));
  raise exception 'SMOKE_RESULT %', res;
end
$test$;
