-- 원격 확인: 실시간 신호 트리거·받기 권한 (DO 블록 하나, 마지막에 일부러 예외를 내서 전부 되돌림)
--   되돌리므로 실제로 신호가 전달되지는 않음. 전달은 stella-sync-verify 10번 묶음으로 확인
do $test$
declare
  u_o uuid := gen_random_uuid();
  u_a uuid := gen_random_uuid();
  u_x uuid := gen_random_uuid();
  ws uuid; r jsonb; code1 text; v_topic text; n int;
  res jsonb := '[]'::jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, jsonb_build_object('name', nm), now(), now()
    from (values (u_o, 'rt-smoke-o@stella.test', 'RtOwner'), (u_a, 'rt-smoke-a@stella.test', 'RtA'),
                 (u_x, 'rt-smoke-x@stella.test', 'RtOut')) v(id, e, nm);

  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ws := public.create_workspace('실시간 스모크');
  v_topic := 'workspace:' || ws::text;
  code1 := public.create_invite(ws, 'EDITOR', 1, 1) ->> 'code';
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.accept_invite(code1);
  r := public.sync_push(ws, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'notes', 'op', 'UPSERT',
         'id', gen_random_uuid(), 'data', jsonb_build_object('title', '스모크 비밀', 'body', 'b'))));
  execute 'reset role';

  select count(*) into n from realtime.messages m where m.topic = v_topic and event = 'changed';
  res := res || jsonb_build_object('T1 참여+저장 → changed 신호 2개', n = 2);
  res := res || jsonb_build_object('T2 마지막 신호 순번 = 서버 순번',
    (select max((payload ->> 'last_seq')::bigint) from realtime.messages m where m.topic = v_topic)
    = (select last_seq from public.workspace_sync_heads where workspace_id = ws));
  res := res || jsonb_build_object('T3 신호에 내용 없음', (select count(*) = 0 from realtime.messages m where m.topic = v_topic and m.payload::text like '%스모크 비밀%'));
  res := res || jsonb_build_object('T4 private broadcast', (select bool_and(private and extension = 'broadcast') from realtime.messages m where m.topic = v_topic));

  -- 받기 권한 (Realtime 서버처럼 role·JWT·topic 설정 후 SELECT)
  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text, true);
  perform set_config('realtime.topic', v_topic, true);
  execute 'set local role authenticated';
  select count(*) into n from realtime.messages m where m.topic = v_topic;
  execute 'reset role';
  res := res || jsonb_build_object('T5 멤버는 받음', n = 2);

  perform set_config('request.jwt.claims', json_build_object('sub', u_x, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from realtime.messages m where m.topic = v_topic;
  execute 'reset role';
  res := res || jsonb_build_object('T6 외부인은 못 받음', n = 0);

  -- 앱(멤버)은 신호를 넣을 수 없음
  perform set_config('request.jwt.claims', json_build_object('sub', u_a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into realtime.messages (topic, extension, event, payload, private) values (v_topic, 'broadcast', 'changed', '{"last_seq": 999}', true);
    res := res || jsonb_build_object('T7 멤버가 신호 직접 넣기 거절', false);
  exception when others then
    res := res || jsonb_build_object('T7 멤버가 신호 직접 넣기 거절', sqlerrm like '%row-level security%');
  end;
  execute 'reset role';

  -- 공간 삭제 → closed
  perform set_config('request.jwt.claims', json_build_object('sub', u_o, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.delete_workspace(ws);
  execute 'reset role';
  res := res || jsonb_build_object('T8 공간 삭제 → closed 신호', (select count(*) = 1 from realtime.messages m where m.topic = v_topic and m.event = 'closed'));

  raise exception 'SMOKE_RESULT %', res;
end
$test$;
