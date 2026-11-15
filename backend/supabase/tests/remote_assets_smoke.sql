-- 원격 확인: 첨부 업로드 RPC (DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림)
--   Storage 업로드·다운로드는 빼고 DB 판단만. 실제 업로드는 stella-sync-verify 11번 묶음으로 확인
do $test$
declare
  u_o uuid := gen_random_uuid(); u_x uuid := gen_random_uuid();
  ws uuid; a uuid := gen_random_uuid(); r jsonb; res jsonb := '[]'::jsonb; seq0 bigint; h text := repeat('c', 64);
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}'::jsonb, now(), now()
    from (values (u_o, 'as-smoke-o@stella.test'), (u_x, 'as-smoke-x@stella.test')) v(id, e);
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ws := public.create_workspace('첨부 스모크');
  begin
    perform public.asset_prepare(u_o, a, 'ATTACHMENT', ws, null, 'text/plain', 5, h);
    res := res || jsonb_build_object('S1 앱은 준비 RPC 직접 호출 불가', false);
  exception when others then
    res := res || jsonb_build_object('S1 앱은 준비 RPC 직접 호출 불가', sqlerrm like 'permission denied%');
  end;
  execute 'reset role';
  select last_seq into seq0 from public.workspace_sync_heads where workspace_id = ws;
  r := public.asset_prepare(u_o, a, 'ATTACHMENT', ws, 'a.txt', 'text/plain', 5, h);
  res := res || jsonb_build_object('S2 준비 → PENDING', r ->> 'status' = 'PENDING' and r ->> 'path' = ws || '/' || a);
  begin
    perform public.asset_prepare(u_x, gen_random_uuid(), 'ATTACHMENT', ws, null, 'text/plain', 5, h);
    res := res || jsonb_build_object('S3 외부인 거절', false);
  exception when others then
    res := res || jsonb_build_object('S3 외부인 거절', sqlerrm like 'FORBIDDEN%');
  end;
  r := public.asset_complete(u_o, a, 5, h, 'text/plain');
  res := res || jsonb_build_object('S4 확인 → AVAILABLE + 원장', r ->> 'status' = 'AVAILABLE' and (r ->> 'seq')::bigint = seq0 + 1);
  res := res || jsonb_build_object('S5 실시간 신호', (select count(*) = 1 from realtime.messages where topic = 'workspace:' || ws and (payload ->> 'last_seq')::bigint = seq0 + 1));
  r := public.asset_delete(u_o, a);
  res := res || jsonb_build_object('S6 삭제 → DELETED + 원장', r ->> 'status' = 'DELETED' and (r ->> 'seq')::bigint = seq0 + 2);
  res := res || jsonb_build_object('S7 cron 등록', (select count(*) = 1 from cron.job where jobname = 'assets-expire-pending'));
  raise exception 'SMOKE_RESULT %', res;
end
$test$;
