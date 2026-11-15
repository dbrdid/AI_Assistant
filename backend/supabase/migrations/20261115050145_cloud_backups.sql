-- =====================================================================
-- #31 백업·복원 (11/15, 화면 BackupScreen 기준) — 개인 공간 기록을 암호화해서 클라우드에
--   화면: 개인 공간에서만 [백업하기] / 목록(최신순·오래된순, 최대 개수, "자동" 표시) / [복원하기] / 삭제
--         복원하기 전에 지금 상태를 "자동" 백업으로 남김
--   흐름 (앱 모듈 backup.ts)
--     ① backup_key(새 키 후보) → 계정별 백업 키 (처음 한 번 만들어 서버에 보관, 11/15 결정: 새 기기에서도 로그인만 하면 복원)
--     ② 기기에서 개인 공간 기록(JSON)을 AES-256-GCM으로 암호화 → 기존 assets 업로드(purpose BACKUP, backups 버킷, 용량은 #28 요금제별)
--     ③ backup_register(asset_id, kind, counts, …) → 목록에 등록. 보관 개수(keep)를 넘는 오래된 백업 id를 돌려줌 → 앱이 assets/delete로 지움
--     ④ list_backups() → 목록 (파일 크기·기록 수). 복원: 받아서 기기에서 풀고 개인 SQLite에 적용
--   키는 private 스키마(앱 API에 안 열림)에 계정별로. 파일은 암호화돼서 저장소만으로는 못 읽지만,
--   DB 관리자는 이론상 풀 수 있음 (서버에 키를 두는 방식의 한계, 11/15 결정 때 확인)
--   공유 공간 기록은 백업 대상 아님 (서버에 이미 있음). 백업 파일 내용은 서버가 보지 않음
-- =====================================================================

create table private.backup_keys (
  account_id  uuid primary key references public.accounts (id) on delete cascade,
  key_b64     text not null check (key_b64 ~ '^[A-Za-z0-9+/]{43}=$'),   -- 32바이트 base64
  created_at  timestamptz not null default now()
);
alter table private.backup_keys enable row level security;
revoke all on private.backup_keys from public, anon, authenticated;
comment on table private.backup_keys is '계정별 백업 암호화 키 (AES-256). 앱은 backup_key()로만 받음';

create table public.backups (
  asset_id        uuid primary key references public.assets (id) on delete cascade,
  account_id      uuid not null references public.accounts (id) on delete cascade,
  kind            text not null check (kind in ('MANUAL', 'AUTO')),
  format_version  integer not null default 1 check (format_version between 1 and 99),
  counts          jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 2048),
  device_name     text check (char_length(device_name) <= 100),
  app_version     text check (char_length(app_version) <= 40),
  created_at      timestamptz not null default now()
);
create index backups_account_idx on public.backups (account_id, created_at desc);
comment on table public.backups is '클라우드 백업 목록 (파일은 assets BACKUP). kind AUTO = 복원 전에 남긴 자동 백업';
comment on column public.backups.counts is '화면 표시용 기록 수 {memos, tasks, projects, ...} (앱이 보냄, 서버는 내용을 못 봄)';

alter table public.backups enable row level security;
revoke all on public.backups from anon;
revoke insert, update, delete on public.backups from authenticated;
create policy backups_select_own on public.backups for select to authenticated using (account_id = (select auth.uid()));

/** 내 백업 키. 없으면 p_new_key(앱이 만든 32바이트 무작위 값, base64)를 저장하고 그 값을 돌려줌. 이미 있으면 있는 키 */
create or replace function public.backup_key(p_new_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_key text; v_created boolean := false;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  select key_b64 into v_key from private.backup_keys where account_id = v_uid;
  if v_key is null then
    if p_new_key is null or p_new_key !~ '^[A-Za-z0-9+/]{43}=$' then
      raise exception 'INVALID_REQUEST: 처음에는 새 키(32바이트 base64)가 필요합니다' using errcode = '22023';
    end if;
    insert into private.backup_keys (account_id, key_b64) values (v_uid, p_new_key) on conflict do nothing;
    get diagnostics v_created = row_count;
    select key_b64 into v_key from private.backup_keys where account_id = v_uid;   -- 동시에 두 기기가 만들어도 하나로
  end if;
  return jsonb_build_object('key', v_key, 'created', v_created);
end $$;

-- 화면용 행
create or replace function private.backup_json(b public.backups, a public.assets)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', b.asset_id, 'kind', b.kind, 'auto', b.kind = 'AUTO', 'created_at', b.created_at,
    'counts', b.counts, 'size_bytes', a.actual_size_bytes, 'sha256', a.declared_sha256,
    'format_version', b.format_version, 'device_name', b.device_name, 'app_version', b.app_version,
    'bucket_id', a.bucket_id, 'object_path', a.object_path)
$$;

/** 업로드한 백업 파일을 목록에 등록. 같은 asset_id로 다시 부르면 처음 결과. 보관 개수(keep)를 넘는 오래된 백업 id를 돌려줌 */
create or replace function public.backup_register(
  p_asset_id uuid,
  p_kind text default 'MANUAL',
  p_counts jsonb default '{}'::jsonb,
  p_device_name text default null,
  p_app_version text default null,
  p_keep integer default 10,
  p_format_version integer default 1
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  a      public.assets;
  b      public.backups;
  v_old  jsonb;
  v_rep  boolean := false;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_kind is null or upper(p_kind) not in ('MANUAL', 'AUTO') then
    raise exception 'INVALID_REQUEST: kind는 MANUAL 또는 AUTO' using errcode = '22023';
  end if;
  if p_keep is null or p_keep not between 1 and 50 then
    raise exception 'INVALID_REQUEST: 보관 개수(keep)는 1~50' using errcode = '22023';
  end if;
  if p_counts is null or jsonb_typeof(p_counts) <> 'object' or pg_column_size(p_counts) > 2048
     or exists (select 1 from jsonb_each(p_counts) e where jsonb_typeof(e.value) <> 'number') then
    raise exception 'INVALID_REQUEST: counts는 {이름: 숫자} 객체 (2KB 이하)' using errcode = '22023';
  end if;
  if p_device_name is not null and char_length(p_device_name) > 100 or p_app_version is not null and char_length(p_app_version) > 40 then
    raise exception 'INVALID_REQUEST: 기기 이름 100자, 앱 버전 40자까지' using errcode = '22023';
  end if;

  -- 같은 사람의 등록은 한 줄로 (보관 개수 계산이 겹치지 않게)
  perform pg_advisory_xact_lock(hashtextextended('backup-register:' || v_uid::text, 0));

  select * into a from public.assets where id = p_asset_id and owner_account_id = v_uid and purpose = 'BACKUP';
  if not found or a.status = 'DELETED' then
    raise exception 'NOT_FOUND: 내 백업 파일이 없습니다' using errcode = '22023';
  end if;
  if a.status <> 'AVAILABLE' then
    raise exception 'NOT_UPLOADED: 업로드 확인이 끝나지 않은 파일입니다 (assets/complete 먼저)' using errcode = '22023';
  end if;

  select * into b from public.backups where asset_id = p_asset_id;
  if found then
    v_rep := true;
  else
    insert into public.backups (asset_id, account_id, kind, format_version, counts, device_name, app_version)
    values (p_asset_id, v_uid, upper(p_kind), coalesce(p_format_version, 1), p_counts, p_device_name, p_app_version)
    returning * into b;
  end if;

  -- 보관 개수를 넘는 오래된 백업 (방금 것은 빼고): 앱이 assets/delete로 지움
  select coalesce(jsonb_agg(x.asset_id order by x.created_at), '[]'::jsonb) into v_old from (
    select bb.asset_id, bb.created_at
      from public.backups bb join public.assets aa on aa.id = bb.asset_id and aa.status = 'AVAILABLE'
     where bb.account_id = v_uid
     order by bb.created_at desc, bb.asset_id desc
     offset p_keep) x
   where x.asset_id <> p_asset_id;

  return jsonb_build_object('ok', true, 'replayed', v_rep, 'backup', private.backup_json(b, a), 'remove_asset_ids', v_old,
    'count', (select count(*) from public.backups bb join public.assets aa on aa.id = bb.asset_id and aa.status = 'AVAILABLE'
               where bb.account_id = v_uid));
end $$;

/** 내 백업 목록 (지운 것 제외). p_order: 'new' 최신순(기본) | 'old' 오래된순 */
create or replace function public.list_backups(p_order text default 'new')
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(private.backup_json(b, a)
                            order by case when p_order = 'old' then extract(epoch from b.created_at) else -extract(epoch from b.created_at) end,
                                     b.asset_id), '[]'::jsonb)
    from public.backups b join public.assets a on a.id = b.asset_id and a.status = 'AVAILABLE'
   where b.account_id = (select auth.uid())
$$;

revoke all on function private.backup_json(public.backups, public.assets) from public, anon, authenticated;
revoke all on function public.backup_key(text), public.backup_register(uuid, text, jsonb, text, text, integer, integer),
  public.list_backups(text) from public, anon;
grant execute on function public.backup_key(text), public.backup_register(uuid, text, jsonb, text, text, integer, integer),
  public.list_backups(text) to authenticated;
