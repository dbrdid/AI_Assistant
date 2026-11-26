-- PC 브리지 로그인: PC에 짧은 코드가 뜨고, 같은 계정으로 로그인한 휴대폰 앱에서 그 코드를 승인한다 (TV 로그인 방식).
-- 승인된 브리지는 계정에 등록되고, 같은 계정의 앱은 연결 문자열 없이 그 브리지를 찾아 중계 연결로 쓴다.
--
-- bridge_logins : 로그인 대기 (10분). 브리지는 비밀값을 가지고 있고 서버에는 그 해시만 둔다.
-- bridges       : 계정에 등록된 브리지. token은 해시만 저장. relay_key는 브리지의 연결 키 (앱이 중계 채널·암호 키를 만드는 값)
--   ponytail: relay_key는 계정 주인만 RPC로 읽지만 DB 관리자는 볼 수 있음. 기기끼리 키를 직접 나누려면 공개키 교환을 추가
-- 표는 정책 없이 RLS만 켜 두고, 아래 함수로만 읽고 쓴다.

create table public.bridge_logins (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  secret_hash  text not null,
  account_id   uuid references public.accounts (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '10 minutes',
  approved_at  timestamptz
);
create table public.bridges (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  token_hash  text not null unique,
  relay_key   text not null check (char_length(relay_key) between 32 and 128),
  created_at  timestamptz not null default now(),
  last_seen   timestamptz,
  revoked_at  timestamptz
);
create index bridges_account_idx on public.bridges (account_id) where revoked_at is null;
alter table public.bridge_logins enable row level security;
alter table public.bridges enable row level security;

create or replace function private.sha256_hex(p text)
returns text language sql immutable set search_path = '' as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

-- 1) 브리지: 로그인 시작 → 화면에 보여 줄 코드 (로그인 없이 부름)
create or replace function public.bridge_login_start(p_secret_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.bridge_logins%rowtype; v_code text; v_try int := 0;
begin
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST: 잘못된 요청입니다' using errcode = '22023';
  end if;
  delete from public.bridge_logins where expires_at < now() - interval '1 hour';
  -- ponytail: 대기 중 로그인 수 전체 상한만 둠. 남용이 보이면 IP·시간당 한도를 추가
  if (select count(*) from public.bridge_logins where expires_at > now()) > 1000 then
    raise exception 'RATE_LIMITED: 잠시 후 다시 시도해 주세요' using errcode = 'P0001';
  end if;
  loop
    v_try := v_try + 1;
    -- 헷갈리는 글자(0 O 1 I) 없는 8자리, 4-4로 끊어 보여 줌
    v_code := (select string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 8));
    begin
      insert into public.bridge_logins (code, secret_hash) values (v_code, p_secret_hash) returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try >= 5 then raise; end if;
    end;
  end loop;
  return jsonb_build_object('id', v_row.id, 'code', left(v_code, 4) || '-' || right(v_code, 4), 'expires_at', v_row.expires_at);
end $$;

-- 2) 앱(로그인한 사람): PC에 뜬 코드를 승인 → 이 계정의 브리지가 됨
create or replace function public.bridge_login_approve(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_norm text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')); v_row public.bridge_logins%rowtype;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  update public.bridge_logins set account_id = v_uid, approved_at = now()
   where code = v_norm and expires_at > now() and approved_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'NOT_FOUND: 코드가 없거나 만료됐어요. PC에서 다시 login을 실행해 주세요' using errcode = 'P0002'; end if;
  return jsonb_build_object('status', 'APPROVED');
end $$;

-- 3) 브리지: 승인됐는지 확인하고, 됐으면 브리지 토큰을 받음 (비밀값으로 본인 확인, 로그인 행은 지움)
create or replace function public.bridge_login_finish(p_id uuid, p_secret text, p_name text, p_relay_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.bridge_logins%rowtype; v_token text; v_bridge public.bridges%rowtype; v_email text;
begin
  select * into v_row from public.bridge_logins where id = p_id and expires_at > now() for update;
  if v_row.id is null or v_row.secret_hash <> private.sha256_hex(coalesce(p_secret, '')) then
    raise exception 'NOT_FOUND: 로그인 요청이 없거나 만료됐어요' using errcode = 'P0002';
  end if;
  if v_row.approved_at is null then return jsonb_build_object('status', 'PENDING'); end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.bridges (account_id, name, token_hash, relay_key)
  values (v_row.account_id, left(coalesce(nullif(btrim(p_name), ''), 'PC 브리지'), 60), private.sha256_hex(v_token), p_relay_key)
  returning * into v_bridge;
  delete from public.bridge_logins where id = v_row.id;
  select email into v_email from public.accounts where id = v_row.account_id;
  return jsonb_build_object('status', 'OK', 'bridge_id', v_bridge.id, 'token', v_token, 'email', v_email);
end $$;

-- 4) 브리지: 켜져 있음을 알리고(마지막 접속), 연결 키가 바뀌었으면 함께 바꿈
create or replace function public.bridge_heartbeat(p_token text, p_relay_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_bridge public.bridges%rowtype;
begin
  update public.bridges set last_seen = now(), relay_key = coalesce(p_relay_key, relay_key)
   where token_hash = private.sha256_hex(coalesce(p_token, '')) and revoked_at is null
  returning * into v_bridge;
  if v_bridge.id is null then raise exception 'FORBIDDEN: 로그아웃된 브리지예요. PC에서 다시 login을 실행해 주세요' using errcode = '42501'; end if;
  return jsonb_build_object('status', 'OK', 'bridge_id', v_bridge.id);
end $$;

-- 5) 앱: 내 계정의 브리지 목록 (연결 키 포함: 같은 계정의 앱만)
create or replace function public.my_bridges()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'relay_key', b.relay_key, 'last_seen', b.last_seen)
                            order by b.last_seen desc nulls last), '[]'::jsonb)
    from public.bridges b where b.account_id = (select auth.uid()) and b.revoked_at is null
$$;

-- 6) 앱: 브리지 로그아웃 (그 브리지는 다시 login 해야 함)
create or replace function public.revoke_bridge(p_bridge_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.bridges set revoked_at = now() where id = p_bridge_id and account_id = (select auth.uid()) and revoked_at is null
$$;

revoke all on function private.sha256_hex(text) from public, anon, authenticated;
revoke all on function public.bridge_login_start(text), public.bridge_login_approve(text), public.bridge_login_finish(uuid, text, text, text),
  public.bridge_heartbeat(text, text), public.my_bridges(), public.revoke_bridge(uuid) from public;
grant execute on function public.bridge_login_start(text), public.bridge_login_finish(uuid, text, text, text), public.bridge_heartbeat(text, text) to anon, authenticated;
grant execute on function public.bridge_login_approve(text), public.my_bridges(), public.revoke_bridge(uuid) to authenticated;
