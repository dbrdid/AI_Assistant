-- 첨부·백업 업로드 RPC 시나리오 테스트 (로컬 전용)
--   실행: ./reset.sh ../migrations/*.sql && psql ... -f test_assets.sql
--   Edge Function이 하는 일(JWT 확인, Storage 업로드·다운로드)은 빼고, service_role로 RPC를 직접 부름
\set QUIET on
\pset format unaligned
\pset tuples_only on

drop schema if exists t cascade;
create schema t;
create table t.results (n serial, name text, pass boolean, detail text);
grant usage on schema t to authenticated, anon, service_role;
grant insert, select on t.results to authenticated, anon, service_role;
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
    insert into t.results (name, pass, detail) values (p_name, sqlerrm like p_code || '%', sqlerrm);
  end;
end $$;
grant execute on all functions in schema t to authenticated, anon, service_role;

\set owner '00000000-0000-4000-8000-0000000000a0'
\set alice '00000000-0000-4000-8000-0000000000a1'
\set vic   '00000000-0000-4000-8000-0000000000a2'
\set xout  '00000000-0000-4000-8000-0000000000f0'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'owner', 'owner@test.dev', '{"name":"Owner"}'),
  (:'alice', 'alice@test.dev', '{"name":"Alice"}'),
  (:'vic',   'vic@test.dev',   '{"name":"Viewer"}'),
  (:'xout',  'x@test.dev',     '{"name":"Outsider"}');

\set as_owner 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_alice 'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a1'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_vic   'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000a2'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_xout  'reset role; select set_config(''request.jwt.claims'', json_build_object(''sub'', ''00000000-0000-4000-8000-0000000000f0'', ''role'', ''authenticated'')::text, false); set role authenticated;'
\set as_anon  'reset role; select set_config(''request.jwt.claims'', ''{"role":"anon"}'', false); set role anon;'
\set as_svc   'reset role; select set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false); set role service_role;'
\set as_admin 'reset role; select set_config(''request.jwt.claims'', '''', false);'

-- 공간: owner(OWNER) + alice(EDITOR) + vic(VIEWER)
:as_owner
select public.create_workspace('첨부 테스트') as ws \gset
select (public.create_invite(:'ws', 'EDITOR', 24, 1)) ->> 'code' as c1 \gset
select (public.create_invite(:'ws', 'VIEWER', 24, 1)) ->> 'code' as c2 \gset
:as_alice
select public.accept_invite(:'c1') \gset
:as_vic
select public.accept_invite(:'c2') \gset

\set h1 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
\set h2 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
\set a1 '00000000-0000-4000-8000-00000000e001'
\set a2 '00000000-0000-4000-8000-00000000e002'
\set a3 '00000000-0000-4000-8000-00000000e003'
\set a4 '00000000-0000-4000-8000-00000000e004'
\set b1 '00000000-0000-4000-8000-00000000e0b1'

-- ---------------------------------------------------------------------
-- 0. 실행 권한: Edge Function(service_role)만
-- ---------------------------------------------------------------------
:as_alice
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, ''a.txt'', ''text/plain'', 5, %L)', :'alice', :'a1', :'ws', :'h1'),
             'permission denied', '0.1 앱(로그인 사용자)은 준비 RPC를 직접 못 부름');
select t.err(format('select public.asset_complete(%L, %L, 5, %L)', :'alice', :'a1', :'h1'), 'permission denied', '0.2 완료 RPC도 직접 못 부름');
select t.err(format('select public.asset_delete(%L, %L)', :'alice', :'a1'), 'permission denied', '0.3 삭제 RPC도 직접 못 부름');
:as_anon
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, ''a.txt'', ''text/plain'', 5, %L)', :'alice', :'a1', :'ws', :'h1'),
             'permission denied', '0.4 비로그인도 못 부름');

-- ---------------------------------------------------------------------
-- 1. 준비
-- ---------------------------------------------------------------------
:as_svc
select public.asset_prepare(:'alice', :'a1', 'ATTACHMENT', :'ws', ' 회의 사진.png ', 'IMAGE/PNG', 5, upper(:'h1')) as p1 \gset
select t.ok(:'p1'::jsonb ->> 'status' = 'PENDING' and :'p1'::jsonb ->> 'bucket' = 'attachments'
        and :'p1'::jsonb ->> 'path' = :'ws' || '/' || :'a1' and (:'p1'::jsonb ->> 'reused')::boolean = false, '1.1 EDITOR 준비 → PENDING, 경로 {공간}/{id}', :'p1');
:as_admin
select t.ok((select mime_type = 'image/png' and declared_sha256 = :'h1' and original_name = '회의 사진.png' and upload_expires_at > now() + interval '55 minutes'
             from public.assets where id = :'a1'), '1.2 형식·해시는 소문자로, 이름은 앞뒤 공백 제거, 기한 1시간');
:as_svc
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 5, %L)', :'vic', :'a2', :'ws', :'h1'), 'FORBIDDEN', '1.3 VIEWER는 못 올림');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 5, %L)', :'xout', :'a2', :'ws', :'h1'), 'FORBIDDEN', '1.4 외부인은 못 올림');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''application/x-msdownload'', 5, %L)', :'alice', :'a2', :'ws', :'h1'), 'UNSUPPORTED_TYPE', '1.5 실행 파일 형식 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/svg+xml;x'', 5, %L)', :'alice', :'a2', :'ws', :'h1'), 'UNSUPPORTED_TYPE', '1.6 이상한 형식 문자열 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 52428801, %L)', :'alice', :'a2', :'ws', :'h1'), 'TOO_LARGE', '1.7 50MB 넘으면 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 0, %L)', :'alice', :'a2', :'ws', :'h1'), 'INVALID_REQUEST', '1.8 크기 0 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 5, ''xyz'')', :'alice', :'a2', :'ws'), 'INVALID_REQUEST', '1.9 잘못된 해시 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', null, null, ''image/png'', 5, %L)', :'alice', :'a2', :'h1'), 'INVALID_REQUEST', '1.10 공유 첨부에 공간 없음 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''BACKUP'', %L, null, ''application/octet-stream'', 5, %L)', :'alice', :'a2', :'ws', :'h1'), 'INVALID_REQUEST', '1.11 백업에 공간 넣으면 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, %L, ''image/png'', 5, %L)', :'alice', :'a2', :'ws', repeat('x', 256), :'h1'), 'INVALID_REQUEST', '1.12 이름 255자 초과 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 5, %L)', :'alice', :'a2', gen_random_uuid(), :'h1'), 'NOT_FOUND', '1.13 없는 공간 → NOT_FOUND');

-- 같은 id로 다시
select public.asset_prepare(:'alice', :'a1', 'ATTACHMENT', :'ws', null, 'image/png', 5, :'h1') as p1b \gset
select t.ok(:'p1b'::jsonb ->> 'status' = 'PENDING' and (:'p1b'::jsonb ->> 'reused')::boolean, '1.14 같은 내용으로 다시 준비 → 이어서 (reused)');
:as_admin
select t.ok((select original_name = '회의 사진.png' from public.assets where id = :'a1'), '1.15 이름 없이 다시 준비해도 이름 유지');
:as_svc
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 5, %L)', :'alice', :'a1', :'ws', :'h2'), 'ASSET_ID_TAKEN', '1.16 같은 id에 다른 해시 → 거절');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''image/png'', 5, %L)', :'owner', :'a1', :'ws', :'h1'), 'ASSET_ID_TAKEN', '1.17 남의 id 재사용 → 거절');

-- ---------------------------------------------------------------------
-- 2. 완료 확인
-- ---------------------------------------------------------------------
:as_admin
select last_seq as seq0 from public.workspace_sync_heads where workspace_id = :'ws' \gset
:as_svc
select public.asset_complete(:'alice', :'a1', null, null) as c0 \gset
select t.ok(:'c0'::jsonb ->> 'status' = 'PENDING' and :'c0'::jsonb ->> 'reason' = 'NOT_UPLOADED', '2.1 아직 안 올렸으면 NOT_UPLOADED, PENDING 유지', :'c0');
select t.err(format('select public.asset_complete(%L, %L, 5, %L)', :'owner', :'a1', :'h1'), 'NOT_FOUND', '2.2 올린 사람이 아니면 완료 못 함');
select public.asset_complete(:'alice', :'a1', 5, :'h1', 'image/png') as c1 \gset
select t.ok(:'c1'::jsonb ->> 'status' = 'AVAILABLE' and :'c1'::jsonb -> 'asset' ->> 'status' = 'AVAILABLE'
        and (:'c1'::jsonb ->> 'seq')::bigint = :'seq0'::bigint + 1, '2.3 크기·해시·형식이 맞으면 AVAILABLE, 원장 seq +1', :'c1');
:as_admin
select t.ok((select entity_table = 'assets' and entity_key = :'a1' and op = 'UPSERT' and data ->> 'status' = 'AVAILABLE' and actor_id = :'alice'
             from public.workspace_changes where workspace_id = :'ws' and seq = :'seq0'::bigint + 1), '2.4 원장에 assets 변경 기록 (다른 기기에 전달)');
select t.ok((select count(*) from realtime.messages where topic = 'workspace:' || :'ws' and (payload ->> 'last_seq')::bigint = :'seq0'::bigint + 1) = 1,
        '2.5 실시간 신호도 나감');
:as_svc
select public.asset_complete(:'alice', :'a1', 5, :'h1') as c1b \gset
:as_admin
select t.ok(:'c1b'::jsonb ->> 'status' = 'AVAILABLE' and (:'c1b'::jsonb ->> 'replayed')::boolean
        and (select last_seq from public.workspace_sync_heads where workspace_id = :'ws') = :'seq0'::bigint + 1, '2.6 완료 다시 → 같은 결과, 원장 추가 없음');
:as_svc
select public.asset_prepare(:'alice', :'a1', 'ATTACHMENT', :'ws', null, 'image/png', 5, :'h1') as p1c \gset
select t.ok(:'p1c'::jsonb ->> 'status' = 'AVAILABLE', '2.7 완료된 id로 다시 준비 → AVAILABLE (다시 올릴 필요 없음)');

-- 불일치
select public.asset_prepare(:'alice', :'a2', 'ATTACHMENT', :'ws', null, 'text/plain', 10, :'h1') \gset
select public.asset_complete(:'alice', :'a2', 10, :'h2') as c2 \gset
select t.ok(:'c2'::jsonb ->> 'status' = 'FAILED' and :'c2'::jsonb ->> 'reason' = 'HASH_MISMATCH' and :'c2'::jsonb ->> 'path' = :'ws' || '/' || :'a2',
        '2.8 해시가 다르면 FAILED(HASH_MISMATCH) + 지울 경로', :'c2');
select t.err(format('select public.asset_prepare(%L, %L, ''ATTACHMENT'', %L, null, ''text/plain'', 10, %L)', :'alice', :'a2', :'ws', :'h1'), 'ASSET_FAILED', '2.9 실패한 id로 다시 준비 → 새 id로');
select public.asset_prepare(:'alice', :'a3', 'ATTACHMENT', :'ws', null, 'text/plain', 10, :'h1') \gset
select public.asset_complete(:'alice', :'a3', 11, :'h1') ->> 'reason' as r3 \gset
select t.ok(:'r3' = 'SIZE_MISMATCH', '2.10 크기가 다르면 SIZE_MISMATCH');
select public.asset_prepare(:'alice', :'a4', 'ATTACHMENT', :'ws', null, 'text/plain', 10, :'h1') \gset
select public.asset_complete(:'alice', :'a4', 10, :'h1', 'text/html; charset=utf-8') ->> 'reason' as r4 \gset
select t.ok(:'r4' = 'TYPE_MISMATCH', '2.11 실제 형식이 다르면 TYPE_MISMATCH');
:as_admin
select t.ok((select count(*) from public.workspace_changes where workspace_id = :'ws' and entity_key in (:'a2', :'a3', :'a4')) = 0, '2.12 실패한 업로드는 원장에 안 남음');

-- 업로드 중에 VIEWER로 바뀜
\set a5 '00000000-0000-4000-8000-00000000e005'
:as_svc
select public.asset_prepare(:'alice', :'a5', 'ATTACHMENT', :'ws', null, 'text/plain', 10, :'h1') \gset
:as_owner
select public.change_member_role(:'ws', :'alice', 'VIEWER') \gset
:as_svc
select public.asset_complete(:'alice', :'a5', 10, :'h1') ->> 'reason' as r5 \gset
select t.ok(:'r5' = 'FORBIDDEN', '2.13 올리는 사이 VIEWER가 되면 FAILED(FORBIDDEN)');
:as_owner
select public.change_member_role(:'ws', :'alice', 'EDITOR') \gset

-- ---------------------------------------------------------------------
-- 3. 다른 기기·권한
-- ---------------------------------------------------------------------
:as_vic
select t.ok((select count(*) from public.assets where id = :'a1') = 1, '3.1 같은 공간 VIEWER도 AVAILABLE 첨부는 봄');
select t.ok(private.can_read_asset_object('attachments', :'ws' || '/' || :'a1'), '3.2 VIEWER도 다운로드 URL 권한 있음');
select t.ok((select count(*) from public.assets where id = :'a2') = 0, '3.3 남의 FAILED 업로드는 안 보임');
select public.sync_pull(:'ws', :'seq0'::bigint) as pl \gset
select t.ok((select count(*) from jsonb_array_elements(:'pl'::jsonb -> 'changes') c where c ->> 'entity' = 'assets' and c ->> 'key' = :'a1') = 1
        or (select count(*) from jsonb_array_elements(:'pl'::jsonb -> 'changes') c where c ->> 'entity' = 'assets') = 1,
        '3.4 다른 기기 sync_pull로 첨부 정보 받음', left(:'pl', 300));
select t.ok((select count(*) from jsonb_array_elements(public.sync_snapshot(:'ws') -> 'assets') a where a ->> 'id' = :'a1') = 1, '3.5 전체 받기에도 들어 있음');
:as_xout
select t.ok((select count(*) from public.assets where id = :'a1') = 0, '3.6 외부인은 안 보임');
select t.ok(not private.can_read_asset_object('attachments', :'ws' || '/' || :'a1'), '3.7 외부인은 다운로드 URL 권한 없음');

-- 메모에 첨부 연결 (sync_push)
\set n1 '00000000-0000-4000-8000-00000000d001'
:as_alice
select public.sync_push(:'ws', gen_random_uuid(), jsonb_build_array(
  jsonb_build_object('entity', 'notes', 'op', 'UPSERT', 'id', :'n1', 'data', jsonb_build_object('title', '사진 메모', 'body', 'b')),
  jsonb_build_object('entity', 'note_attachments', 'op', 'UPSERT', 'data', jsonb_build_object('note_id', :'n1', 'asset_id', :'a1', 'position', 0)))) as lk \gset
select t.ok(:'lk'::jsonb ->> 'status' = 'ACCEPTED', '3.8 완료된 첨부는 메모에 연결 가능', :'lk');
select t.err(format($q$select public.sync_push(%L, gen_random_uuid(), jsonb_build_array(jsonb_build_object('entity', 'note_attachments', 'op', 'UPSERT',
               'data', jsonb_build_object('note_id', %L, 'asset_id', %L, 'position', 1))))$q$, :'ws', :'n1', :'a2'),
             'INVALID_REQUEST', '3.9 실패한 첨부는 연결 불가');

-- ---------------------------------------------------------------------
-- 4. 한도
-- ---------------------------------------------------------------------
:as_svc
-- 공간 500MB: 50MB × 9개 PENDING + 이미 있는 것들 → 10번째에서 넘침
select count(*) as made from (
  select public.asset_prepare(:'owner', gen_random_uuid(), 'ATTACHMENT', :'ws', null, 'audio/mp4', 52428800, :'h1') from generate_series(1, 9)) s \gset
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''ATTACHMENT'', %L, null, ''audio/mp4'', 52428800, %L)', :'owner', :'ws', :'h1'),
             'QUOTA_EXCEEDED', '4.1 공간 첨부 합계 500MB 넘으면 거절');
:as_admin
update public.assets set upload_expires_at = now() - interval '1 minute' where owner_account_id = :'owner' and status = 'PENDING';
:as_svc
select t.ok((public.asset_prepare(:'owner', gen_random_uuid(), 'ATTACHMENT', :'ws', null, 'audio/mp4', 52428800, :'h1')) ->> 'status' = 'PENDING',
        '4.2 기한 지난 PENDING은 용량에서 빠짐');
:as_admin
select t.ok(private.expire_pending_assets() >= 0, '4.3 (정리 함수 실행)');
update public.assets set upload_expires_at = now() - interval '11 minutes' where owner_account_id = :'owner' and status = 'PENDING' and upload_expires_at < now();
select private.expire_pending_assets() as expired \gset
select t.ok(:'expired'::int = 9 and (select count(*) from public.assets where owner_account_id = :'owner' and failure_reason = 'EXPIRED') = 9,
        '4.4 기한+10분 지난 PENDING → FAILED(EXPIRED)', :'expired');
:as_svc
-- 완료 안 된 업로드 20개
select count(*) from (select public.asset_prepare(:'vic', gen_random_uuid(), 'BACKUP', null, null, 'application/octet-stream', 1, :'h1') from generate_series(1, 20)) s \gset
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''BACKUP'', null, null, ''application/octet-stream'', 1, %L)', :'vic', :'h1'),
             'TOO_MANY_PENDING', '4.5 완료 안 된 업로드 20개 넘으면 거절');
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''BACKUP'', null, null, ''application/octet-stream'', 209715201, %L)', :'xout', :'h1'),
             'TOO_LARGE', '4.6 (참고) 파일 한도가 먼저');

-- ---------------------------------------------------------------------
-- 5. 백업
-- ---------------------------------------------------------------------
select public.asset_prepare(:'xout', :'b1', 'BACKUP', null, 'backup.bin', 'application/octet-stream', 7, :'h2') as pb \gset
select t.ok(:'pb'::jsonb ->> 'bucket' = 'backups' and :'pb'::jsonb ->> 'path' = :'xout' || '/' || :'b1', '5.1 백업 경로 {계정}/{id}');
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''BACKUP'', null, null, ''image/png'', 7, %L)', :'xout', :'h2'), 'UNSUPPORTED_TYPE', '5.2 백업은 암호화한 바이너리만');
select t.err(format('select public.asset_complete(%L, %L, 7, %L)', :'alice', :'b1', :'h2'), 'NOT_FOUND', '5.3 남의 백업은 완료 못 함');
select public.asset_complete(:'xout', :'b1', 7, :'h2') as cb \gset
select t.ok(:'cb'::jsonb ->> 'status' = 'AVAILABLE' and :'cb'::jsonb ->> 'seq' is null, '5.4 백업 완료 → AVAILABLE, 공유 원장 없음');
:as_xout
select t.ok((select count(*) from public.assets where id = :'b1') = 1 and private.can_read_asset_object('backups', :'xout' || '/' || :'b1'), '5.5 본인은 백업을 보고 받음');
:as_alice
select t.ok((select count(*) from public.assets where id = :'b1') = 0 and not private.can_read_asset_object('backups', :'xout' || '/' || :'b1'), '5.6 다른 사람은 못 봄');

-- ---------------------------------------------------------------------
-- 6. 삭제
-- ---------------------------------------------------------------------
\set a6 '00000000-0000-4000-8000-00000000e006'
:as_svc
select public.asset_prepare(:'owner', :'a6', 'ATTACHMENT', :'ws', null, 'text/plain', 3, :'h2') \gset
select public.asset_complete(:'owner', :'a6', 3, :'h2') \gset
select t.err(format('select public.asset_delete(%L, %L)', :'alice', :'a6'), 'FORBIDDEN', '6.1 EDITOR는 남이 올린 첨부를 못 지움');
select t.err(format('select public.asset_delete(%L, %L)', :'vic', :'a1'), 'FORBIDDEN', '6.2 VIEWER는 못 지움');
select t.err(format('select public.asset_delete(%L, %L)', :'xout', :'a1'), 'NOT_FOUND', '6.3 외부인 → NOT_FOUND (있는지도 안 알려줌)');
:as_admin
select last_seq as seq1 from public.workspace_sync_heads where workspace_id = :'ws' \gset
:as_svc
select public.asset_delete(:'alice', :'a1') as d1 \gset
select t.ok(:'d1'::jsonb ->> 'status' = 'DELETED' and :'d1'::jsonb ->> 'path' = :'ws' || '/' || :'a1' and (:'d1'::jsonb ->> 'seq')::bigint = :'seq1'::bigint + 1,
        '6.4 올린 EDITOR가 삭제 → DELETED + 원장 + 지울 경로', :'d1');
select t.ok((public.asset_delete(:'alice', :'a1')) ->> 'replayed' = 'true', '6.5 다시 삭제 → 같은 결과');
select t.ok((public.asset_delete(:'owner', :'a6')) ->> 'status' = 'DELETED', '6.6 OWNER는 남이 올린 것도 삭제');
select t.ok((public.asset_delete(:'xout', :'b1')) ->> 'status' = 'DELETED', '6.7 백업 본인 삭제');
:as_vic
select t.ok((select count(*) from public.assets where id = :'a1') = 0 and not private.can_read_asset_object('attachments', :'ws' || '/' || :'a1'),
        '6.8 삭제된 첨부는 안 보이고 다운로드도 막힘');
select t.ok((select count(*) from public.note_attachments where asset_id = :'a1') = 1, '6.9 메모 연결은 남음 (앱이 "삭제된 첨부"로 표시)');
:as_admin
select t.ok((select data ->> 'status' = 'DELETED' and data ->> 'deleted_at' is not null from public.workspace_changes
             where workspace_id = :'ws' and seq = :'seq1'::bigint + 1), '6.10 원장 데이터에 삭제 표시 (다른 기기에서 숨김)');

-- 공간이 삭제되면 준비 불가
:as_owner
select public.delete_workspace(:'ws') \gset
:as_svc
select t.err(format('select public.asset_prepare(%L, gen_random_uuid(), ''ATTACHMENT'', %L, null, ''text/plain'', 3, %L)', :'owner', :'ws', :'h1'), 'NOT_FOUND', '6.11 삭제된 공간에는 못 올림');

:as_admin
select 'TOTAL ' || count(*) || ' / PASS ' || count(*) filter (where pass) || ' / FAIL ' || count(*) filter (where not pass) from t.results;
select 'FAIL ' || name || ' :: ' || coalesce(detail, '') from t.results where not pass order by n;
