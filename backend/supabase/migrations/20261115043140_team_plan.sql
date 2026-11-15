-- =====================================================================
-- #28 Team 요금제 (가짜 결제, 11/15) — 화면 구독 관리의 free · pro · team
--   가격: FREE 0 · PRO 4,900원 · TEAM 9,900원 (월, private.plan_price_krw)
--   혜택 (구독한 사람 + 그 사람이 관리자(OWNER)인 공간)
--     - AI 월 한도: TEAM = PRO (private.ai_monthly_limit)
--     - 이번 달 프로젝트 초대: FREE 10 · PRO 50 · TEAM 200회 (private.project_invite_monthly_limit)
--     - 공간 첨부 용량: 공간 관리자 중 가장 높은 요금제 기준 FREE 500MB · PRO 2GB · TEAM 10GB
--     - 내 백업 용량: FREE 200MB · PRO·TEAM 1GB (private.storage_quota_bytes)
--     - 팀원(공간 인원) 한도는 두지 않음 (11/15 결정)
--   결제 흐름 (subscription_checkout(p_plan 'PRO'|'TEAM', ...))
--     FREE → PRO/TEAM : 가짜 결제 + 1개월 (SUBSCRIBED)
--     같은 요금제      : 이용 중이면 ALREADY_ACTIVE, 해지 예약 중이면 결제 없이 해지 취소 (RESUMED)
--     PRO ↔ TEAM      : 바로 바뀌고 새 요금제로 가짜 결제 + 오늘부터 1개월 (CHANGED). 일할 계산 없음 (시연용)
--     해지            : 다음 결제일까지 지금 요금제, 그 뒤 FREE (그대로)
--   기간 끝 처리(매분 cron)·자동 결제(RENEWAL)는 그 요금제 가격으로
--   용량을 낮춘 뒤(요금제 내림) 이미 올린 파일은 그대로 두고 새 업로드만 막음
-- =====================================================================

-- ---------------------------------------------------------------------
-- 표
-- ---------------------------------------------------------------------
alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('FREE', 'PRO', 'TEAM'));
alter table public.subscriptions drop constraint subscriptions_period_shape;
alter table public.subscriptions add constraint subscriptions_period_shape check (
  (plan in ('PRO', 'TEAM') and current_period_start is not null and current_period_end > current_period_start)
  or
  (plan = 'FREE' and current_period_end is null and cancel_at_period_end = false)
);
comment on column public.subscriptions.cancel_at_period_end is '해지 예약: current_period_end까지 지금 요금제(PRO·TEAM), 그 뒤 FREE';

drop index public.subscriptions_due_idx;
create index subscriptions_due_idx on public.subscriptions (current_period_end) where plan <> 'FREE';

alter table public.payments drop constraint payments_plan_check;
alter table public.payments add constraint payments_plan_check check (plan in ('PRO', 'TEAM'));

-- ---------------------------------------------------------------------
-- 요금제 표 (바꾸려면 여기만)
-- ---------------------------------------------------------------------
create or replace function private.plan_price_krw(p_plan text)
returns integer language sql immutable set search_path = '' as $$
  select case p_plan when 'PRO' then 4900 when 'TEAM' then 9900 else 0 end
$$;

-- 높은 순서 (공간 요금제 = 관리자들 중 가장 높은 것)
create or replace function private.plan_rank(p_plan text)
returns integer language sql immutable set search_path = '' as $$
  select case p_plan when 'TEAM' then 2 when 'PRO' then 1 else 0 end
$$;

-- 지금 이 계정의 요금제 (구독 행이 없거나 ACTIVE가 아니면 FREE)
create or replace function private.account_plan(p_account uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select s.plan from public.subscriptions s where s.account_id = p_account and s.status = 'ACTIVE'), 'FREE')
$$;

-- 공간 요금제: ACTIVE 관리자(OWNER) 중 가장 높은 요금제
create or replace function private.workspace_plan(p_workspace uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.account_plan(m.account_id)
      from public.workspace_members m
     where m.workspace_id = p_workspace and m.role = 'OWNER' and m.status = 'ACTIVE'
     order by private.plan_rank(private.account_plan(m.account_id)) desc
     limit 1), 'FREE')
$$;

-- 저장 용량 (바이트). ATTACHMENT = 공간 하나의 첨부 합계, BACKUP = 계정 하나의 백업 합계
create or replace function private.storage_quota_bytes(p_purpose text, p_plan text)
returns bigint language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'ATTACHMENT' then case p_plan when 'TEAM' then 10737418240 when 'PRO' then 2147483648 else 524288000 end
    when 'BACKUP'     then case p_plan when 'TEAM' then 1073741824  when 'PRO' then 1073741824 else 209715200 end
  end::bigint
$$;

-- "500MB" / "2GB"
create or replace function private.bytes_label(p_bytes bigint)
returns text language sql immutable set search_path = '' as $$
  select case when p_bytes % 1073741824 = 0 then (p_bytes / 1073741824)::text || 'GB'
              else (p_bytes / 1048576)::text || 'MB' end
$$;

-- AI 월 한도: TEAM은 PRO와 같음 (#27 값 그대로)
create or replace function private.ai_monthly_limit(p_plan text, p_endpoint text)
returns integer language sql immutable set search_path = '' as $$
  select case
           when p_endpoint = 'organize'   then case when p_plan in ('PRO', 'TEAM') then 1000 else 100 end
           when p_endpoint = 'analyze'    then case when p_plan in ('PRO', 'TEAM') then 300  else 30  end
           when p_endpoint = 'query'      then case when p_plan in ('PRO', 'TEAM') then 500  else 50  end
           when p_endpoint = 'query_plan' then case when p_plan in ('PRO', 'TEAM') then 1500 else 150 end
           when p_endpoint = 'agenda'     then case when p_plan in ('PRO', 'TEAM') then 500  else 50  end
           when p_endpoint = 'stt'        then case when p_plan in ('PRO', 'TEAM') then 600  else 60  end   -- 단위: 분
           else                                case when p_plan in ('PRO', 'TEAM') then 300  else 30  end
         end
$$;

-- 이번 달 프로젝트 초대
create or replace function private.project_invite_monthly_limit(p_plan text)
returns integer language sql immutable set search_path = '' as $$
  select case p_plan when 'TEAM' then 200 when 'PRO' then 50 else 10 end
$$;

-- 요금제별 혜택 (화면 요금제 선택·이용량 표시용)
create or replace function private.plan_catalog()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_object_agg(p, jsonb_build_object(
    'price_krw', private.plan_price_krw(p),
    'project_invites_per_month', private.project_invite_monthly_limit(p),
    'workspace_storage_bytes', private.storage_quota_bytes('ATTACHMENT', p),
    'backup_storage_bytes', private.storage_quota_bytes('BACKUP', p),
    'ai', jsonb_build_object(
      'organize', private.ai_monthly_limit(p, 'organize'), 'analyze', private.ai_monthly_limit(p, 'analyze'),
      'query', private.ai_monthly_limit(p, 'query'), 'agenda', private.ai_monthly_limit(p, 'agenda'),
      'ocr', private.ai_monthly_limit(p, 'ocr'), 'stt_minutes', private.ai_monthly_limit(p, 'stt'))))
  from unnest(array['FREE', 'PRO', 'TEAM']) as p
$$;

-- ---------------------------------------------------------------------
-- 구독 상태·정리 (PRO 전용이던 곳을 유료 요금제 전체로)
-- ---------------------------------------------------------------------
create or replace function private.subscription_view(s public.subscriptions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'plan', s.plan,
    'state', case when s.plan = 'FREE' then 'FREE' when s.cancel_at_period_end then 'CANCELING' else 'ACTIVE' end,
    'current_period_start', s.current_period_start,
    'current_period_end', s.current_period_end,
    -- 다음 결제일: 해지 예약이면 없음 (그날부터 FREE)
    'next_payment_at', case when s.plan <> 'FREE' and not s.cancel_at_period_end then s.current_period_end end,
    'next_payment_krw', case when s.plan <> 'FREE' and not s.cancel_at_period_end then private.plan_price_krw(s.plan) end,
    'cancel_at_period_end', s.cancel_at_period_end,
    'canceled_at', s.canceled_at,
    'price_krw', jsonb_build_object('FREE', 0, 'PRO', private.plan_price_krw('PRO'), 'TEAM', private.plan_price_krw('TEAM')),
    'plans', private.plan_catalog()
  )
$$;

create or replace function private.subscription_settle(p_account uuid)
returns public.subscriptions language plpgsql set search_path = '' as $$
declare
  s public.subscriptions;
  v_start timestamptz;
  v_end   timestamptz;
  v_ref   text;
  n       integer := 0;
begin
  select * into s from public.subscriptions where account_id = p_account;
  if not found or s.plan = 'FREE' or s.current_period_end > now() then
    return s;
  end if;

  if s.cancel_at_period_end then
    update public.subscriptions
       set plan = 'FREE', status = 'ACTIVE', current_period_start = null, current_period_end = null,
           cancel_at_period_end = false
     where account_id = p_account
    returning * into s;
    return s;
  end if;

  v_end := s.current_period_end;
  while v_end <= now() and n < 36 loop
    v_start := v_end;
    v_end   := v_start + interval '1 month';
    v_ref   := 'fake_' || replace(gen_random_uuid()::text, '-', '');
    insert into public.payments (account_id, kind, plan, amount_krw, status, period_start, period_end, payment_ref)
    values (p_account, 'RENEWAL', s.plan, private.plan_price_krw(s.plan), 'PAID', v_start, v_end, v_ref);
    n := n + 1;
  end loop;
  if v_end <= now() then          -- 아주 오래 멈춰 있던 경우: 오늘부터 새 기간
    v_start := now();
    v_end   := now() + interval '1 month';
  end if;

  update public.subscriptions
     set current_period_start = v_start, current_period_end = v_end, payment_ref = coalesce(v_ref, payment_ref)
   where account_id = p_account
  returning * into s;
  return s;
end $$;

create or replace function private.subscription_tick()
returns integer language plpgsql set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in
    select account_id from public.subscriptions
     where plan <> 'FREE' and current_period_end <= now()
     order by current_period_end
     limit 500
     for update skip locked
  loop
    perform private.subscription_settle(r.account_id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 앱 RPC
-- ---------------------------------------------------------------------
create or replace function public.subscription_checkout(
  p_plan text,
  p_client_request_id uuid,
  p_simulate text default null       -- null | 'DECLINE' (결제 실패 시연)
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_plan  text := upper(p_plan);
  s       public.subscriptions;
  v_prev  public.payments;
  v_from  text;
  v_act   text;
  v_ref   text;
  v_price integer;
  v_res   jsonb;
  v_pay   jsonb;
  v_start timestamptz := now();
  v_end   timestamptz := now() + interval '1 month';
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_client_request_id is null then
    raise exception 'INVALID_REQUEST: client_request_id가 필요합니다' using errcode = '22023';
  end if;
  if v_plan is null or v_plan not in ('PRO', 'TEAM', 'FREE') then
    raise exception 'INVALID_REQUEST: 요금제는 PRO 또는 TEAM만 결제할 수 있습니다' using errcode = '22023';
  end if;
  if v_plan = 'FREE' then
    raise exception 'INVALID_REQUEST: 무료 요금제로 바꾸려면 subscription_cancel을 쓰세요' using errcode = '22023';
  end if;
  if p_simulate is not null and p_simulate <> 'DECLINE' then
    raise exception 'INVALID_REQUEST: p_simulate는 DECLINE만 됩니다' using errcode = '22023';
  end if;

  -- 같은 사람의 결제 요청은 한 줄로 (구독 행 잠금)
  perform 1 from public.subscriptions where account_id = v_uid for update;
  if not found then
    insert into public.subscriptions (account_id) values (v_uid) on conflict do nothing;
    perform 1 from public.subscriptions where account_id = v_uid for update;
  end if;

  -- 같은 요청 재시도 → 처음 결과
  select * into v_prev from public.payments where account_id = v_uid and client_request_id = p_client_request_id;
  if found then
    return v_prev.result || jsonb_build_object('replayed', true);
  end if;

  s := private.subscription_settle(v_uid);
  v_from := s.plan;

  if s.plan = v_plan and not s.cancel_at_period_end then
    return jsonb_build_object('ok', true, 'action', 'ALREADY_ACTIVE', 'subscription', private.subscription_view(s));
  end if;
  if s.plan = v_plan and s.cancel_at_period_end then
    update public.subscriptions set cancel_at_period_end = false, canceled_at = null
     where account_id = v_uid returning * into s;
    return jsonb_build_object('ok', true, 'action', 'RESUMED', 'subscription', private.subscription_view(s));
  end if;

  -- FREE → 유료: SUBSCRIBED / PRO ↔ TEAM: CHANGED (오늘부터 새 요금제 1개월, 일할 계산 없음)
  v_act   := case when s.plan = 'FREE' then 'SUBSCRIBED' else 'CHANGED' end;
  v_price := private.plan_price_krw(v_plan);
  v_ref   := 'fake_' || replace(gen_random_uuid()::text, '-', '');
  if p_simulate = 'DECLINE' then
    v_pay := jsonb_build_object('payment_ref', v_ref, 'plan', v_plan, 'amount_krw', v_price, 'status', 'FAILED');
    v_res := jsonb_build_object('ok', false, 'code', 'PAYMENT_DECLINED', 'message', '결제가 승인되지 않았어요 (시연용 실패)',
                                'payment', v_pay, 'subscription', private.subscription_view(s));
    insert into public.payments (account_id, client_request_id, kind, plan, amount_krw, status, failure_code, payment_ref, result)
    values (v_uid, p_client_request_id, 'CHECKOUT', v_plan, v_price, 'FAILED', 'PAYMENT_DECLINED', v_ref, v_res);
    return v_res;
  end if;

  update public.subscriptions
     set plan = v_plan, status = 'ACTIVE', current_period_start = v_start, current_period_end = v_end,
         cancel_at_period_end = false, canceled_at = null, payment_ref = v_ref
   where account_id = v_uid
  returning * into s;
  v_pay := jsonb_build_object('payment_ref', v_ref, 'plan', v_plan, 'amount_krw', v_price, 'status', 'PAID',
                             'period_start', v_start, 'period_end', v_end);
  v_res := jsonb_build_object('ok', true, 'action', v_act, 'payment', v_pay, 'subscription', private.subscription_view(s))
           || case when v_act = 'CHANGED' then jsonb_build_object('previous_plan', v_from) else '{}'::jsonb end;
  insert into public.payments (account_id, client_request_id, kind, plan, amount_krw, status, period_start, period_end, payment_ref, result)
  values (v_uid, p_client_request_id, 'CHECKOUT', v_plan, v_price, 'PAID', v_start, v_end, v_ref, v_res);
  return v_res;
end $$;

create or replace function public.subscription_cancel()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); s public.subscriptions;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  perform 1 from public.subscriptions where account_id = v_uid for update;
  s := private.subscription_settle(v_uid);
  if s.plan is null or s.plan = 'FREE' then
    raise exception 'NOT_SUBSCRIBED: 이용 중인 유료 요금제가 없습니다' using errcode = '22023';
  end if;
  if s.cancel_at_period_end then
    return jsonb_build_object('ok', true, 'unchanged', true, 'subscription', private.subscription_view(s));
  end if;
  update public.subscriptions set cancel_at_period_end = true, canceled_at = now()
   where account_id = v_uid returning * into s;
  return jsonb_build_object('ok', true, 'subscription', private.subscription_view(s));
end $$;

comment on function public.subscription_checkout(text, uuid, text) is
  '가짜 결제로 PRO·TEAM 구독. 같은 요금제 해지 예약 중이면 해지 취소, PRO↔TEAM은 바로 변경(새 결제). p_simulate=DECLINE이면 결제 실패 시연. 같은 client_request_id는 처음 결과';
comment on function public.subscription_cancel() is '구독 해지: 다음 결제일(current_period_end)까지 지금 요금제, 그 뒤 FREE';

-- ---------------------------------------------------------------------
-- 첨부·백업 용량: 고정 500MB/200MB → 요금제별 (asset_prepare의 두 군데만 바꿈, 나머지 본문은 그대로)
-- ---------------------------------------------------------------------
do $patch$
declare
  v_def text := pg_get_functiondef('public.asset_prepare(uuid, uuid, text, uuid, text, text, bigint, text)'::regprocedure);
  v_from1 constant text := $s$if v_used + p_size_bytes > (L ->> 'workspace_quota_bytes')::bigint then
      raise exception 'QUOTA_EXCEEDED: 이 공간의 첨부 용량(500MB)을 넘습니다' using errcode = '22023';$s$;
  v_to1   constant text := $s$if v_used + p_size_bytes > private.storage_quota_bytes('ATTACHMENT', private.workspace_plan(p_workspace_id)) then
      raise exception 'QUOTA_EXCEEDED: 이 공간의 첨부 용량(%)을 넘습니다',
        private.bytes_label(private.storage_quota_bytes('ATTACHMENT', private.workspace_plan(p_workspace_id))) using errcode = '22023';$s$;
  v_from2 constant text := $s$if v_used + p_size_bytes > (L ->> 'backup_quota_bytes')::bigint then
      raise exception 'QUOTA_EXCEEDED: 백업 용량(200MB)을 넘습니다' using errcode = '22023';$s$;
  v_to2   constant text := $s$if v_used + p_size_bytes > private.storage_quota_bytes('BACKUP', private.account_plan(p_account_id)) then
      raise exception 'QUOTA_EXCEEDED: 백업 용량(%)을 넘습니다',
        private.bytes_label(private.storage_quota_bytes('BACKUP', private.account_plan(p_account_id))) using errcode = '22023';$s$;
begin
  if (length(v_def) - length(replace(v_def, v_from1, ''))) / length(v_from1) <> 1 then
    raise exception 'patch #28: workspace quota check not found exactly once';
  end if;
  if (length(v_def) - length(replace(v_def, v_from2, ''))) / length(v_from2) <> 1 then
    raise exception 'patch #28: backup quota check not found exactly once';
  end if;
  execute replace(replace(v_def, v_from1, v_to1), v_from2, v_to2);
end
$patch$;

revoke all on function private.plan_rank(text), private.account_plan(uuid), private.workspace_plan(uuid),
  private.storage_quota_bytes(text, text), private.bytes_label(bigint), private.plan_catalog()
  from public, anon, authenticated;
