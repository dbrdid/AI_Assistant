-- =====================================================================
-- 24. 가짜 결제 (FREE ↔ PRO) — 시연용. 실제 결제사 연동 없음
--   화면(구독 관리): 현재 요금제 · 다음 결제일 · 요금제 변경 · 구독 해지 · 결제 실패 안내
--   - 구독:  subscription_checkout('PRO', client_request_id) → 가짜 결제 기록(PAID) + 1개월 PRO
--            p_simulate = 'DECLINE'이면 결제 실패(FAILED) 기록만 남기고 요금제는 그대로 (결제 실패 화면 시연)
--            같은 client_request_id로 다시 부르면 처음 결과를 그대로 (두 번 눌러도 한 번만 결제)
--   - 해지:  subscription_cancel() → 다음 결제일까지 PRO 유지, 그 뒤 FREE ("해지하면 다음 결제일부터 무료")
--            해지 예약 중에 다시 PRO를 고르면 결제 없이 해지 취소(RESUMED)
--   - 갱신:  기간이 끝나면 매분 cron이 처리. 해지 예약이면 FREE로, 아니면 가짜 자동 결제(RENEWAL)로 1개월 연장
--   - 조회:  get_my_subscription() (기간이 지났으면 그 자리에서 먼저 정리하고 돌려줌), 결제 내역은 payments 테이블(본인만)
--   한도 계산(ai_begin_request 등)은 지금처럼 subscriptions.plan + status='ACTIVE'를 읽으므로 고치지 않음
--   Team 요금제는 서버에 없음 (팀 결정 전) → PLAN_NOT_AVAILABLE
-- =====================================================================

alter table public.subscriptions
  add column current_period_start timestamptz,
  add column cancel_at_period_end  boolean not null default false,
  add column canceled_at           timestamptz;
comment on column public.subscriptions.cancel_at_period_end is '해지 예약: current_period_end까지 PRO, 그 뒤 FREE';
comment on column public.subscriptions.payment_ref is '마지막 가짜 결제 참조값 (payments.payment_ref)';

-- 상태가 맞지 않는 조합 막기: PRO는 기간이 있어야 하고, FREE는 기간·해지 예약이 없음
alter table public.subscriptions add constraint subscriptions_period_shape check (
  (plan = 'PRO'  and current_period_start is not null and current_period_end > current_period_start)
  or
  (plan = 'FREE' and current_period_end is null and cancel_at_period_end = false)
);

create index subscriptions_due_idx on public.subscriptions (current_period_end) where plan = 'PRO';

-- 가짜 결제 기록
create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.accounts (id) on delete cascade,
  client_request_id  uuid,                      -- 앱이 만든 요청 id (CHECKOUT만). 재시도 중복 방지
  kind               text not null check (kind in ('CHECKOUT', 'RENEWAL')),
  plan               text not null check (plan in ('PRO')),
  amount_krw         integer not null check (amount_krw >= 0),
  status             text not null check (status in ('PAID', 'FAILED')),
  failure_code       text,
  period_start       timestamptz,
  period_end         timestamptz,
  provider           text not null default 'FAKE' check (provider = 'FAKE'),
  payment_ref        text not null unique,
  result             jsonb,                     -- CHECKOUT 응답 (같은 요청 재시도 때 그대로 돌려줌)
  created_at         timestamptz not null default now(),
  check ((status = 'PAID') = (failure_code is null)),
  check ((status = 'PAID') = (period_start is not null and period_end > period_start))
);
create unique index payments_request_uidx on public.payments (account_id, client_request_id) where client_request_id is not null;
create index payments_account_idx on public.payments (account_id, created_at desc);
comment on table public.payments is '가짜 결제 기록 (시연용, provider=FAKE). 앱은 본인 것만 조회';

alter table public.payments enable row level security;
revoke all on public.payments from anon;
revoke insert, update, delete on public.payments from authenticated;
create policy payments_select_own on public.payments for select to authenticated using (account_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 가격 (가짜). 바꾸려면 여기만
-- ---------------------------------------------------------------------
create or replace function private.plan_price_krw(p_plan text)
returns integer language sql immutable set search_path = '' as $$
  select case p_plan when 'PRO' then 4900 else 0 end
$$;

-- 화면에 줄 구독 상태
create or replace function private.subscription_view(s public.subscriptions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'plan', s.plan,
    'state', case when s.plan = 'FREE' then 'FREE' when s.cancel_at_period_end then 'CANCELING' else 'ACTIVE' end,
    'current_period_start', s.current_period_start,
    'current_period_end', s.current_period_end,
    -- 다음 결제일: 해지 예약이면 없음 (그날부터 FREE)
    'next_payment_at', case when s.plan = 'PRO' and not s.cancel_at_period_end then s.current_period_end end,
    'next_payment_krw', case when s.plan = 'PRO' and not s.cancel_at_period_end then private.plan_price_krw('PRO') end,
    'cancel_at_period_end', s.cancel_at_period_end,
    'canceled_at', s.canceled_at,
    'price_krw', jsonb_build_object('FREE', 0, 'PRO', private.plan_price_krw('PRO'))
  )
$$;

-- 기간이 끝난 구독 정리 (잠금은 부르는 쪽이 잡음). 반환: 정리 후 행
--   해지 예약 → FREE / 아니면 가짜 자동 결제(RENEWAL)로 한 달씩 연장 (밀린 기간은 최대 36번까지 따라잡음)
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
  if not found or s.plan <> 'PRO' or s.current_period_end > now() then
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
    values (p_account, 'RENEWAL', 'PRO', private.plan_price_krw('PRO'), 'PAID', v_start, v_end, v_ref);
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

-- 매분 cron: 기간이 끝난 PRO 구독 정리
create or replace function private.subscription_tick()
returns integer language plpgsql set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in
    select account_id from public.subscriptions
     where plan = 'PRO' and current_period_end <= now()
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

/** 내 구독 (기간이 지났으면 정리한 뒤) */
create or replace function public.get_my_subscription()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); s public.subscriptions;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  perform 1 from public.subscriptions where account_id = v_uid for update;
  if not found then
    insert into public.subscriptions (account_id) values (v_uid) on conflict do nothing;
  end if;
  s := private.subscription_settle(v_uid);
  return private.subscription_view(s);
end $$;

/** PRO 구독 (가짜 결제). 해지 예약 중이면 결제 없이 해지 취소 */
create or replace function public.subscription_checkout(
  p_plan text,
  p_client_request_id uuid,
  p_simulate text default null       -- null | 'DECLINE' (결제 실패 시연)
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  s      public.subscriptions;
  v_prev public.payments;
  v_ref  text;
  v_res  jsonb;
  v_pay  jsonb;
  v_start timestamptz := now();
  v_end   timestamptz := now() + interval '1 month';
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_client_request_id is null then
    raise exception 'INVALID_REQUEST: client_request_id가 필요합니다' using errcode = '22023';
  end if;
  if p_plan is null or upper(p_plan) not in ('PRO', 'TEAM', 'FREE') then
    raise exception 'INVALID_REQUEST: 요금제는 PRO만 결제할 수 있습니다' using errcode = '22023';
  end if;
  if upper(p_plan) = 'TEAM' then
    raise exception 'PLAN_NOT_AVAILABLE: Team 요금제는 아직 준비 중입니다' using errcode = '22023';
  end if;
  if upper(p_plan) = 'FREE' then
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

  if s.plan = 'PRO' and not s.cancel_at_period_end then
    return jsonb_build_object('ok', true, 'action', 'ALREADY_ACTIVE', 'subscription', private.subscription_view(s));
  end if;
  if s.plan = 'PRO' and s.cancel_at_period_end then
    update public.subscriptions set cancel_at_period_end = false, canceled_at = null
     where account_id = v_uid returning * into s;
    return jsonb_build_object('ok', true, 'action', 'RESUMED', 'subscription', private.subscription_view(s));
  end if;

  -- FREE → PRO: 가짜 결제
  v_ref := 'fake_' || replace(gen_random_uuid()::text, '-', '');
  if p_simulate = 'DECLINE' then
    v_pay := jsonb_build_object('payment_ref', v_ref, 'amount_krw', private.plan_price_krw('PRO'), 'status', 'FAILED');
    v_res := jsonb_build_object('ok', false, 'code', 'PAYMENT_DECLINED', 'message', '결제가 승인되지 않았어요 (시연용 실패)',
                                'payment', v_pay, 'subscription', private.subscription_view(s));
    insert into public.payments (account_id, client_request_id, kind, plan, amount_krw, status, failure_code, payment_ref, result)
    values (v_uid, p_client_request_id, 'CHECKOUT', 'PRO', private.plan_price_krw('PRO'), 'FAILED', 'PAYMENT_DECLINED', v_ref, v_res);
    return v_res;
  end if;

  update public.subscriptions
     set plan = 'PRO', status = 'ACTIVE', current_period_start = v_start, current_period_end = v_end,
         cancel_at_period_end = false, canceled_at = null, payment_ref = v_ref
   where account_id = v_uid
  returning * into s;
  v_pay := jsonb_build_object('payment_ref', v_ref, 'amount_krw', private.plan_price_krw('PRO'), 'status', 'PAID',
                             'period_start', v_start, 'period_end', v_end);
  v_res := jsonb_build_object('ok', true, 'action', 'SUBSCRIBED', 'payment', v_pay, 'subscription', private.subscription_view(s));
  insert into public.payments (account_id, client_request_id, kind, plan, amount_krw, status, period_start, period_end, payment_ref, result)
  values (v_uid, p_client_request_id, 'CHECKOUT', 'PRO', private.plan_price_krw('PRO'), 'PAID', v_start, v_end, v_ref, v_res);
  return v_res;
end $$;

/** 구독 해지: 다음 결제일까지 PRO, 그 뒤 FREE. 여러 번 불러도 같은 결과 */
create or replace function public.subscription_cancel()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); s public.subscriptions;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  perform 1 from public.subscriptions where account_id = v_uid for update;
  s := private.subscription_settle(v_uid);
  if s.plan is distinct from 'PRO' then
    raise exception 'NOT_SUBSCRIBED: 이용 중인 유료 요금제가 없습니다' using errcode = '22023';
  end if;
  if s.cancel_at_period_end then
    return jsonb_build_object('ok', true, 'unchanged', true, 'subscription', private.subscription_view(s));
  end if;
  update public.subscriptions set cancel_at_period_end = true, canceled_at = now()
   where account_id = v_uid returning * into s;
  return jsonb_build_object('ok', true, 'subscription', private.subscription_view(s));
end $$;

revoke all on function private.plan_price_krw(text), private.subscription_view(public.subscriptions),
  private.subscription_settle(uuid), private.subscription_tick() from public, anon, authenticated;
revoke all on function public.get_my_subscription(), public.subscription_checkout(text, uuid, text),
  public.subscription_cancel() from public, anon;
grant execute on function public.get_my_subscription(), public.subscription_checkout(text, uuid, text),
  public.subscription_cancel() to authenticated;

comment on function public.subscription_checkout(text, uuid, text) is
  '가짜 결제로 PRO 구독. 해지 예약 중이면 해지 취소. p_simulate=DECLINE이면 결제 실패 시연. 같은 client_request_id는 처음 결과';
comment on function public.subscription_cancel() is '구독 해지: 다음 결제일(current_period_end)까지 PRO, 그 뒤 FREE';
comment on function public.get_my_subscription() is '내 구독 상태 (plan, state FREE/ACTIVE/CANCELING, next_payment_at 등)';

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('subscription-tick', '* * * * *', $cmd$ select private.subscription_tick() $cmd$);
