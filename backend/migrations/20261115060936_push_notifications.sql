-- =====================================================================
-- #34 푸시 알림 · 브리핑 (11/15, 정한 정책: Expo Push로 발송)
--   보내는 것
--     · 공유 공간 할 일 마감·일정 시작·프로젝트 마감 전 (reminder_minutes)
--         받는 사람 = 그 기록의 프로젝트에 계정 연결된 팀원(ACTIVE 멤버), 없으면 공간의 ACTIVE 멤버 전체
--         개인 할 일·일정 알림은 지금처럼 기기 로컬 알림 (서버에 기록이 없음)
--     · 공간 소식: 새 멤버가 들어오면 다른 멤버에게
--     · 긴 녹음 → 글자 변환이 끝나면 녹음한 사람에게
--     · 일간·주간 브리핑: 설정한 시각(사용자 시간대)에 "오늘의 브리핑" 푸시만. 내용은 기기가 개인+공유 기록으로 만듦
--   설정: user_settings.preferences.notifications (종류별 켜기·끄기, 브리핑 시각) — get/set_notification_settings
--   기기 토큰: set_push_token (Expo 토큰, 같은 휴대폰에 다른 계정이 로그인하면 예전 계정에서 토큰을 뺌)
--   발송: 매분 cron → 알림 만들기(마감·브리핑) → 보낼 것이 있으면 Edge Function push-send를 깨움
--         push-send: push_claim(보낼 알림 + 토큰) → Expo Push API → push_report(결과, 잘못된 토큰 정리)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 기기 알림 토큰: Expo 토큰
-- ---------------------------------------------------------------------
alter table public.devices drop constraint devices_push_provider_check,
  add constraint devices_push_provider_check check (push_provider in ('FCM', 'APNS', 'EXPO'));

/** 이 기기의 알림 토큰 저장 (null이면 끄기). 같은 토큰을 다른 계정·기기가 쓰고 있으면 그쪽에서 뺌 */
create or replace function public.set_push_token(p_device_id uuid, p_token text, p_provider text default 'EXPO')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from public.devices where id = p_device_id and account_id = v_uid and revoked_at is null) then
    raise exception 'NOT_FOUND: 등록되지 않은 기기입니다' using errcode = '22023';
  end if;
  if p_token is not null then
    if p_provider not in ('EXPO', 'FCM', 'APNS') then
      raise exception 'INVALID_REQUEST: push_provider는 EXPO·FCM·APNS' using errcode = '22023';
    end if;
    if char_length(p_token) > 300 or (p_provider = 'EXPO' and p_token !~ '^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{10,200}\]$') then
      raise exception 'INVALID_REQUEST: 알림 토큰 형식이 아닙니다' using errcode = '22023';
    end if;
    update public.devices set push_token = null, push_provider = null
     where push_token = p_token and id <> p_device_id;
  end if;
  update public.devices
     set push_token = p_token, push_provider = case when p_token is null then null else p_provider end, last_seen_at = now()
   where id = p_device_id;
  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'enabled', p_token is not null);
end $$;

-- ---------------------------------------------------------------------
-- 2. 알림 설정 (user_settings.preferences.notifications)
--    push: 전체 · workspace: 공간 소식 · recording: 녹음 변환 · reminders: 공유 기록 마감·시작 전
--    briefing_daily: { on, time 'HH:MM' } · briefing_weekly: { on, day 0(일)~6(토), time }
-- ---------------------------------------------------------------------
create or replace function private.notification_defaults()
returns jsonb language sql immutable as $$
  select jsonb_build_object('push', true, 'workspace', true, 'recording', true, 'reminders', true,
    'briefing_daily', jsonb_build_object('on', false, 'time', '08:00'),
    'briefing_weekly', jsonb_build_object('on', false, 'day', 1, 'time', '09:00'))
$$;

create or replace function private.notification_settings(p_account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.notification_defaults()
         || coalesce((select s.preferences -> 'notifications' from public.user_settings s where s.account_id = p_account), '{}'::jsonb)
$$;

create or replace function public.get_notification_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  return private.notification_settings(v_uid);
end $$;

/** 바꿀 항목만 보내면 됨. 반환: 저장된 전체 설정 */
create or replace function public.set_notification_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_cur jsonb;
  k text;
  v jsonb;
  b jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'INVALID_REQUEST: 설정은 객체로 보내 주세요' using errcode = '22023';
  end if;
  v_cur := private.notification_settings(v_uid);
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('push', 'workspace', 'recording', 'reminders') then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'INVALID_REQUEST: %는 true/false', k using errcode = '22023'; end if;
      v_cur := v_cur || jsonb_build_object(k, v);
    elsif k in ('briefing_daily', 'briefing_weekly') then
      if jsonb_typeof(v) <> 'object' then raise exception 'INVALID_REQUEST: %는 객체', k using errcode = '22023'; end if;
      b := v_cur -> k;
      if v ? 'on' then
        if jsonb_typeof(v -> 'on') <> 'boolean' then raise exception 'INVALID_REQUEST: %.on은 true/false', k using errcode = '22023'; end if;
        b := b || jsonb_build_object('on', v -> 'on');
      end if;
      if v ? 'time' then
        if coalesce(v ->> 'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
          raise exception 'INVALID_REQUEST: %.time은 HH:MM (24시간)', k using errcode = '22023';
        end if;
        b := b || jsonb_build_object('time', v -> 'time');
      end if;
      if v ? 'day' then
        if k <> 'briefing_weekly' or jsonb_typeof(v -> 'day') <> 'number' or (v ->> 'day')::numeric not in (0, 1, 2, 3, 4, 5, 6) then
          raise exception 'INVALID_REQUEST: briefing_weekly.day는 0(일)~6(토)' using errcode = '22023';
        end if;
        b := b || jsonb_build_object('day', (v ->> 'day')::int);
      end if;
      v_cur := v_cur || jsonb_build_object(k, b);
    else
      raise exception 'INVALID_REQUEST: 모르는 알림 설정 %', k using errcode = '22023';
    end if;
  end loop;
  update public.user_settings
     set preferences = jsonb_set(coalesce(preferences, '{}'::jsonb), '{notifications}', v_cur, true)
   where account_id = v_uid;
  return v_cur;
end $$;

-- ---------------------------------------------------------------------
-- 3. 알림 목록 (보낼 것 + 받은 알림함)
-- ---------------------------------------------------------------------
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (kind in (
    'BRIEFING_DAILY', 'BRIEFING_WEEKLY', 'EVENT_REMINDER', 'TASK_REMINDER', 'PROJECT_REMINDER',
    'WORKSPACE_JOINED', 'RECORDING_DONE', 'INVITE', 'SYSTEM')),
  add column title      text check (char_length(title) <= 100),
  add column body       text check (char_length(body) <= 300),
  add column data       jsonb not null default '{}'::jsonb,
  add column dedupe_key text,
  add column status     text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  add column attempts   integer not null default 0,
  add column last_error text,
  add column locked_at  timestamptz;
create unique index notifications_dedupe_idx on public.notifications (dedupe_key) where dedupe_key is not null;
create index notifications_send_idx on public.notifications (scheduled_for) where status = 'PENDING';
comment on table public.notifications is '푸시 알림 (보낼 것·보낸 것). 본문은 짧게, 열면 ref로 권한 확인 후 조회 (#34)';

-- 종류 → 설정 키
create or replace function private.notification_category(p_kind text)
returns text language sql immutable as $$
  select case
    when p_kind in ('TASK_REMINDER', 'EVENT_REMINDER', 'PROJECT_REMINDER') then 'reminders'
    when p_kind in ('WORKSPACE_JOINED', 'INVITE') then 'workspace'
    when p_kind = 'RECORDING_DONE' then 'recording'
    when p_kind = 'BRIEFING_DAILY' then 'briefing_daily'
    when p_kind = 'BRIEFING_WEEKLY' then 'briefing_weekly'
    else 'system' end
$$;

/** 알림 하나 넣기 (설정에서 끈 종류는 넣지 않음, 같은 dedupe_key는 한 번만). 반환: 넣었으면 true */
create or replace function private.notify(p_account uuid, p_workspace uuid, p_kind text, p_title text, p_body text,
                                          p_data jsonb, p_dedupe text, p_ref_table text default null, p_ref_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_set jsonb := private.notification_settings(p_account);
  v_cat text := private.notification_category(p_kind);
  v_ok  boolean;
begin
  if not coalesce((v_set ->> 'push')::boolean, true) then return false; end if;
  if v_cat in ('reminders', 'workspace', 'recording') and not coalesce((v_set ->> v_cat)::boolean, true) then return false; end if;
  insert into public.notifications (account_id, workspace_id, kind, ref_table, ref_id, title, body, data, dedupe_key)
  values (p_account, p_workspace, p_kind, p_ref_table, p_ref_id, left(p_title, 100), left(p_body, 300), coalesce(p_data, '{}'::jsonb), p_dedupe)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- 공유 기록 알림을 받을 사람: 프로젝트의 계정 연결된 팀원(ACTIVE 멤버), 없으면 공간 ACTIVE 멤버 전체
create or replace function private.item_recipients(p_workspace uuid, p_project uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  with team as (
    select distinct pm.account_id
      from public.project_members pm
      join public.workspace_members m on m.workspace_id = pm.workspace_id and m.account_id = pm.account_id and m.status = 'ACTIVE'
     where p_project is not null and pm.workspace_id = p_workspace and pm.project_id = p_project
       and pm.deleted_at is null and pm.account_id is not null)
  select account_id from team
  union all
  select m.account_id from public.workspace_members m
   where m.workspace_id = p_workspace and m.status = 'ACTIVE' and not exists (select 1 from team)
$$;

-- "30분 뒤 마감" 같은 문구
create or replace function private.lead_text(p_minutes integer)
returns text language sql immutable as $$
  select case
    when p_minutes is null or p_minutes <= 0 then '지금'
    when p_minutes % 1440 = 0 then (p_minutes / 1440) || '일 뒤'
    when p_minutes % 60 = 0 then (p_minutes / 60) || '시간 뒤'
    else p_minutes || '분 뒤' end
$$;

-- ---------------------------------------------------------------------
-- 4. 알림 만들기
-- ---------------------------------------------------------------------
/** 매분: 공유 기록 마감·시작 알림 (알릴 시각이 최근 10분 안인 것, 같은 기록·시각·사람은 한 번만) */
create or replace function private.enqueue_reminders(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_to uuid;
  n integer := 0;
  v_from timestamptz := p_now - interval '10 minutes';
begin
  for r in
    select 'TASK_REMINDER'::text as kind, 'tasks'::text as tbl, t.id, t.workspace_id, t.project_id, t.title,
           t.due_at - make_interval(mins => t.reminder_minutes) as fire_at, t.reminder_minutes as lead, w.name as ws_name
      from public.tasks t join public.workspaces w on w.id = t.workspace_id and w.deleted_at is null
     where t.deleted_at is null and t.due_at is not null and t.reminder_minutes is not null
       and t.completed_at is null and t.status not in ('DONE', 'CANCELED')
       and t.due_at - make_interval(mins => t.reminder_minutes) > v_from
       and t.due_at - make_interval(mins => t.reminder_minutes) <= p_now
    union all
    select 'EVENT_REMINDER', 'events', e.id, e.workspace_id, e.project_id, e.title,
           e.start_at - make_interval(mins => e.reminder_minutes), e.reminder_minutes, w.name
      from public.events e join public.workspaces w on w.id = e.workspace_id and w.deleted_at is null
     where e.deleted_at is null and e.reminder_minutes is not null and e.status <> 'CANCELED'
       and e.start_at - make_interval(mins => e.reminder_minutes) > v_from
       and e.start_at - make_interval(mins => e.reminder_minutes) <= p_now
    union all
    -- 프로젝트 마감일(날짜)은 그날 09:00(서울) 기준
    select 'PROJECT_REMINDER', 'projects', p.id, p.workspace_id, p.id, p.name,
           ((p.due_date + time '09:00') at time zone 'Asia/Seoul') - make_interval(mins => p.reminder_minutes),
           p.reminder_minutes, w.name
      from public.projects p join public.workspaces w on w.id = p.workspace_id and w.deleted_at is null
     where p.deleted_at is null and p.due_date is not null and p.reminder_minutes is not null
       and ((p.due_date + time '09:00') at time zone 'Asia/Seoul') - make_interval(mins => p.reminder_minutes) > v_from
       and ((p.due_date + time '09:00') at time zone 'Asia/Seoul') - make_interval(mins => p.reminder_minutes) <= p_now
  loop
    for v_to in select private.item_recipients(r.workspace_id, r.project_id) loop
      if private.notify(v_to, r.workspace_id, r.kind, r.title,
           r.ws_name || ' · ' || case r.kind
             when 'TASK_REMINDER' then private.lead_text(r.lead) || ' 마감이에요'
             when 'EVENT_REMINDER' then private.lead_text(r.lead) || ' 시작해요'
             else '프로젝트 마감 ' || private.lead_text(r.lead) || '이에요' end,
           jsonb_build_object('type', r.tbl, 'workspace_id', r.workspace_id, 'id', r.id),
           r.kind || ':' || r.id || ':' || v_to || ':' || extract(epoch from r.fire_at)::bigint,
           r.tbl, r.id) then
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end $$;

/** 매분: 일간·주간 브리핑 (사용자 시간대의 설정 시각부터 10분 안, 하루·한 주에 한 번) */
create or replace function private.enqueue_briefings(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
  v_local timestamp;
  v_at timestamp;
  b jsonb;
begin
  for r in
    select s.account_id, coalesce(nullif(s.timezone, ''), 'Asia/Seoul') as tz,
           private.notification_defaults() || coalesce(s.preferences -> 'notifications', '{}'::jsonb) as st
      from public.user_settings s
     where coalesce((s.preferences -> 'notifications' -> 'briefing_daily' ->> 'on')::boolean, false)
        or coalesce((s.preferences -> 'notifications' -> 'briefing_weekly' ->> 'on')::boolean, false)
  loop
    begin
      v_local := p_now at time zone r.tz;
    exception when others then
      v_local := p_now at time zone 'Asia/Seoul';
    end;
    b := r.st -> 'briefing_daily';
    if coalesce((b ->> 'on')::boolean, false) then
      v_at := v_local::date + (b ->> 'time')::time;
      if v_local >= v_at and v_local < v_at + interval '10 minutes'
         and private.notify(r.account_id, null, 'BRIEFING_DAILY', '오늘의 브리핑', '오늘 일정과 남은 할 일을 확인해 보세요',
               jsonb_build_object('type', 'briefing', 'period', 'daily'), 'BRIEFING_DAILY:' || r.account_id || ':' || v_local::date) then
        n := n + 1;
      end if;
    end if;
    b := r.st -> 'briefing_weekly';
    if coalesce((b ->> 'on')::boolean, false) and extract(dow from v_local)::int = (b ->> 'day')::int then
      v_at := v_local::date + (b ->> 'time')::time;
      if v_local >= v_at and v_local < v_at + interval '10 minutes'
         and private.notify(r.account_id, null, 'BRIEFING_WEEKLY', '이번 주 브리핑', '이번 주 일정과 할 일을 정리해 드려요',
               jsonb_build_object('type', 'briefing', 'period', 'weekly'), 'BRIEFING_WEEKLY:' || r.account_id || ':' || v_local::date) then
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $$;

-- 공간 소식: 새 멤버가 들어오면 다른 ACTIVE 멤버에게
create or replace function private.notify_member_joined()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_ws   text;
  v_to   uuid;
begin
  if new.status <> 'ACTIVE' or (tg_op = 'UPDATE' and old.status = 'ACTIVE') then return new; end if;
  select coalesce(nullif(btrim(p.display_name), ''), '새 멤버') into v_name from public.profiles p where p.account_id = new.account_id;
  select w.name into v_ws from public.workspaces w where w.id = new.workspace_id and w.deleted_at is null;
  if v_ws is null then return new; end if;
  for v_to in select m.account_id from public.workspace_members m
               where m.workspace_id = new.workspace_id and m.status = 'ACTIVE' and m.account_id <> new.account_id loop
    perform private.notify(v_to, new.workspace_id, 'WORKSPACE_JOINED', v_ws, coalesce(v_name, '새 멤버') || '님이 공간에 들어왔어요',
      jsonb_build_object('type', 'workspace', 'workspace_id', new.workspace_id, 'account_id', new.account_id),
      'WORKSPACE_JOINED:' || new.workspace_id || ':' || new.account_id || ':' || v_to || ':' || extract(epoch from new.joined_at)::bigint);
  end loop;
  return new;
end $$;
drop trigger if exists workspace_members_notify_joined on public.workspace_members;
create trigger workspace_members_notify_joined after insert or update of status on public.workspace_members
  for each row execute function private.notify_member_joined();

-- 긴 녹음: 처리할 구간이 다 끝나면 녹음한 사람에게 (다시 시도해서 또 끝나면 또 알림)
create or replace function private.notify_recording_done()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_rec   private.stt_recordings%rowtype;
  v_done  integer;
  v_bad   integer;
  v_open  integer;
begin
  if new.status is not distinct from old.status or new.status not in ('DONE', 'FAILED', 'GAVE_UP') then return new; end if;
  select * into v_rec from private.stt_recordings where id = new.recording_id;
  if v_rec.id is null or v_rec.canceled_at is not null then return new; end if;
  select count(*) filter (where status = 'DONE'), count(*) filter (where status in ('FAILED', 'GAVE_UP')),
         count(*) filter (where status in ('PENDING_UPLOAD', 'QUEUED', 'PROCESSING'))
    into v_done, v_bad, v_open
    from private.stt_segments where recording_id = new.recording_id;
  if v_open > 0 then return new; end if;
  perform private.notify(v_rec.account_id, v_rec.workspace_id, 'RECORDING_DONE',
    case when v_bad = 0 then '녹음을 글로 바꿨어요' else '녹음 일부를 바꾸지 못했어요' end,
    case when v_bad = 0 then '전사문을 확인하고 정리해 보세요'
         else v_bad || '개 구간이 실패했어요. 다시 시도할 수 있어요' end,
    jsonb_build_object('type', 'recording', 'recording_id', v_rec.id, 'workspace_id', v_rec.workspace_id),
    'RECORDING_DONE:' || v_rec.id || ':' || v_done || ':' || v_bad);
  return new;
end $$;
drop trigger if exists stt_segments_notify_done on private.stt_segments;
create trigger stt_segments_notify_done after update of status on private.stt_segments
  for each row execute function private.notify_recording_done();

-- ---------------------------------------------------------------------
-- 5. 보내기 (Edge Function push-send, service_role)
-- ---------------------------------------------------------------------
/**
 * 보낼 알림 가져오기 (잠금). 받을 기기가 없으면 SKIPPED로 정리
 * 반환: [{ id, tokens: [..], title, body, data, kind }]
 */
create or replace function public.push_claim(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_out jsonb;
begin
  -- 한 문장에서 같은 행을 두 번 고치지 않도록 토큰을 먼저 붙이고 한 번에 상태를 정함
  with c as (
    select n.id,
           coalesce((select jsonb_agg(d.push_token order by d.push_token) from public.devices d
                      where d.account_id = n.account_id and d.revoked_at is null
                        and d.push_provider = 'EXPO' and d.push_token is not null), '[]'::jsonb) as tokens
      from public.notifications n
     where n.status = 'PENDING' and n.scheduled_for <= now()
       and (n.locked_at is null or n.locked_at < now() - interval '5 minutes')
     order by n.scheduled_for
     limit least(greatest(coalesce(p_limit, 100), 1), 500)
     for update of n skip locked),
  u as (
    update public.notifications n
       set attempts   = n.attempts + 1,
           locked_at  = case when jsonb_array_length(c.tokens) = 0 then null else now() end,
           status     = case when jsonb_array_length(c.tokens) = 0 then 'SKIPPED' else n.status end,
           last_error = case when jsonb_array_length(c.tokens) = 0 then 'NO_DEVICE' else n.last_error end
      from c where n.id = c.id
    returning n.id, n.kind, n.title, n.body, n.data, c.tokens)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'kind', u.kind, 'tokens', u.tokens,
           'title', u.title, 'body', u.body, 'data', u.data || jsonb_build_object('notification_id', u.id))), '[]'::jsonb)
    into v_out
    from u where jsonb_array_length(u.tokens) > 0;
  return v_out;
end $$;

/**
 * 보낸 결과: [{ id, ok: bool, error?, bad_tokens?: [..] }]
 *   ok → SENT / 실패 → 3번까지 1분 뒤 다시, 그다음 FAILED. bad_tokens(DeviceNotRegistered)는 기기에서 토큰을 뺌
 */
create or replace function public.push_report(p_results jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  v_sent integer := 0;
  v_failed integer := 0;
  v_tokens integer := 0;
  v_n integer;
begin
  if jsonb_typeof(p_results) is distinct from 'array' then
    raise exception 'INVALID_REQUEST: 결과는 배열' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_results) loop
    if coalesce((r ->> 'ok')::boolean, false) then
      update public.notifications set status = 'SENT', sent_at = now(), locked_at = null, last_error = null
       where id = (r ->> 'id')::uuid and status = 'PENDING';
      get diagnostics v_n = row_count; v_sent := v_sent + v_n;
    else
      update public.notifications
         set status = case when attempts >= 3 then 'FAILED' else 'PENDING' end,
             scheduled_for = case when attempts >= 3 then scheduled_for else now() + interval '1 minute' end,
             locked_at = null, last_error = left(coalesce(r ->> 'error', 'UNKNOWN'), 200)
       where id = (r ->> 'id')::uuid and status = 'PENDING';
      get diagnostics v_n = row_count; v_failed := v_failed + v_n;
    end if;
    if jsonb_typeof(r -> 'bad_tokens') = 'array' then
      update public.devices set push_token = null, push_provider = null
       where push_token in (select jsonb_array_elements_text(r -> 'bad_tokens'));
      get diagnostics v_n = row_count; v_tokens := v_tokens + v_n;
    end if;
  end loop;
  return jsonb_build_object('sent', v_sent, 'failed', v_failed, 'tokens_removed', v_tokens);
end $$;

/** 받은 알림함 (최근 것부터) */
create or replace function public.list_notifications(p_limit integer default 50, p_before timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'workspace_id', n.workspace_id, 'title', n.title, 'body', n.body,
             'data', n.data, 'created_at', n.created_at, 'read_at', n.read_at) order by n.created_at desc)
      from (select * from public.notifications n
             where n.account_id = v_uid and n.status in ('SENT', 'SKIPPED', 'FAILED')
               and (p_before is null or n.created_at < p_before)
               and (n.workspace_id is null or private.is_active_member(n.workspace_id))
             order by n.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) n), '[]'::jsonb);
end $$;

/** 읽음 표시 (id 목록, 비우면 전부) */
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_n integer;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  update public.notifications set read_at = now()
   where account_id = v_uid and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 매분: 알림 만들기 + 보낼 것이 있으면 push-send 깨우기
create or replace function private.push_tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r integer := private.enqueue_reminders();
  v_b integer := private.enqueue_briefings();
  v_kick boolean := exists (select 1 from public.notifications where status = 'PENDING' and scheduled_for <= now());
begin
  if v_kick then perform private.stt_call_function('push-send'); end if;
  return jsonb_build_object('reminders', v_r, 'briefings', v_b, 'kicked', v_kick);
end $$;

revoke all on function private.notification_defaults(), private.notification_settings(uuid), private.notification_category(text),
  private.notify(uuid, uuid, text, text, text, jsonb, text, text, uuid), private.item_recipients(uuid, uuid), private.lead_text(integer),
  private.enqueue_reminders(timestamptz), private.enqueue_briefings(timestamptz), private.notify_member_joined(),
  private.notify_recording_done(), private.push_tick()
  from public, anon, authenticated;
revoke all on function public.push_claim(integer), public.push_report(jsonb) from public, anon, authenticated;
grant execute on function public.push_claim(integer), public.push_report(jsonb) to service_role;
revoke all on function public.set_push_token(uuid, text, text), public.get_notification_settings(), public.set_notification_settings(jsonb),
  public.list_notifications(integer, timestamptz), public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.set_push_token(uuid, text, text), public.get_notification_settings(), public.set_notification_settings(jsonb),
  public.list_notifications(integer, timestamptz), public.mark_notifications_read(uuid[]) to authenticated;

select cron.schedule('push-tick', '* * * * *', $cmd$ select private.push_tick() $cmd$);
