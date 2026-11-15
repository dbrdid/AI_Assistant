-- Supabase 흉내: 역할, auth, storage, cron 스텁 (로컬 테스트 전용)
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant anon, authenticated, service_role to postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  instance_id uuid, aud text, role text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now(),
                              updated_at timestamptz default now(), metadata jsonb, unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, update on storage.objects to authenticated;

create schema cron;
create table cron.job (jobname text primary key, schedule text, command text);
create function cron.schedule(p_name text, p_sched text, p_cmd text) returns bigint language sql as $$
  insert into cron.job values (p_name, p_sched, p_cmd) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command;
  select 1::bigint $$;

-- Vault 흉내 (원격: vault.create_secret / vault.decrypted_secrets)
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql as $$ insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;

-- pg_net 흉내: 호출 기록만 남김 (원격: net.http_post → Edge Function 호출)
create schema net;
create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb, created_at timestamptz default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                              headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $$ insert into net.calls (url, headers, body) values (url, headers, body) returning id $$;

-- Supabase 프로젝트에 있는 자동 RLS 이벤트 트리거 함수 자리 (advisor_fixes가 권한을 회수함)
create function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;

-- Realtime 흉내: 원격과 같은 열·권한·함수 정의 (2026-11-14 원격에서 확인)
create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;
create table realtime.messages (
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  updated_at timestamp not null default timezone('utc', clock_timestamp()),
  inserted_at timestamp not null default timezone('utc', clock_timestamp()),
  id uuid not null default gen_random_uuid(),
  primary key (id, inserted_at)
);
alter table realtime.messages enable row level security;
grant insert, select, update on realtime.messages to anon, authenticated, service_role;
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text;
$$;
grant execute on function realtime.topic() to anon, authenticated, service_role;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language plpgsql as $$
declare
  generated_id uuid;
  final_payload jsonb;
begin
  begin
    generated_id := gen_random_uuid();
    if payload ? 'id' then final_payload := payload;
    else final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    end if;
    execute format('SET LOCAL realtime.topic TO %L', topic);
    insert into realtime.messages (id, payload, event, topic, private, extension)
    values (generated_id, final_payload, event, topic, private, 'broadcast');
  exception when others then
    raise warning 'WarnSendingBroadcastMessage: %', sqlerrm;
  end;
end $$;
