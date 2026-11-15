-- =====================================================================
-- 12. AI Gateway용 DB 함수 (Edge Function이 service_role로만 호출)
--   ai_begin_request  : 공간 권한 → 외부 AI 동의 → 멱등성 → 월 사용량 예약 → 요청 원장(RESERVED)
--   ai_finish_request : 상태 확정(SUCCEEDED/FAILED/UNKNOWN) + 예약 정산 + 토큰 기록
--   본문(프롬프트·응답)은 어디에도 저장하지 않음
--   한도: 엔드포인트별·월별 요청 수 (FREE 100, PRO 1000) — 바꾸려면 private.ai_monthly_limit 수정
-- =====================================================================

alter table public.ai_requests add column input_tokens  integer check (input_tokens  >= 0);
alter table public.ai_requests add column output_tokens integer check (output_tokens >= 0);
comment on column public.ai_requests.charged_units is '사용량 한도에 반영된 요청 수 (성공 1, 실패 0)';

-- 요금제별 월 한도
create or replace function private.ai_monthly_limit(p_plan text, p_endpoint text)
returns integer language sql immutable set search_path = '' as $$
  select case p_plan when 'PRO' then 1000 else 100 end;
$$;

create or replace function public.ai_begin_request(
  p_account_id         uuid,
  p_client_request_id  uuid,
  p_endpoint           text,
  p_workspace_id       uuid,
  p_input_hash         text,
  p_provider           text,
  p_model              text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_metric   text := 'AI_' || upper(p_endpoint);
  v_period   date := date_trunc('month', now() at time zone 'Asia/Seoul')::date;
  v_consent  uuid;
  v_plan     text;
  v_limit    integer;
  v_prev     public.ai_requests%rowtype;
  v_used     bigint;
  v_reserved bigint;
  v_id       uuid;
begin
  if p_account_id is null or p_client_request_id is null or p_endpoint is null or p_input_hash is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  -- 공유 공간 기록을 보낼 때는 지금도 ACTIVE 멤버여야 함 (개인 기록은 workspace_id 없음)
  if p_workspace_id is not null and not exists (
       select 1 from public.workspace_members m
         join public.workspaces w on w.id = m.workspace_id
        where m.workspace_id = p_workspace_id and m.account_id = p_account_id
          and m.status = 'ACTIVE' and w.deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;

  -- 외부 AI 전송 동의 (로그인 ≠ 외부 전송 동의)
  select c.id into v_consent
    from public.consents c
   where c.account_id = p_account_id and c.consent_type = 'EXTERNAL_AI' and c.revoked_at is null
   order by c.granted_at desc
   limit 1;
  if v_consent is null then
    return jsonb_build_object('ok', false, 'code', 'CONSENT_REQUIRED');
  end if;

  -- 같은 client_request_id 재요청 처리 (본문을 저장하지 않으므로 성공 결과는 다시 줄 수 없음)
  select * into v_prev
    from public.ai_requests
   where account_id = p_account_id and client_request_id = p_client_request_id
     for update;
  if found then
    if v_prev.status in ('RESERVED', 'UNKNOWN') then
      return jsonb_build_object('ok', false, 'code', 'IN_PROGRESS', 'request_id', v_prev.id);
    elsif v_prev.status = 'SUCCEEDED' then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_DONE', 'request_id', v_prev.id);
    elsif v_prev.input_hash <> p_input_hash then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_REUSED');
    end if;
    -- FAILED → 같은 ID로 재시도 허용 (아래에서 다시 예약)
  end if;

  -- 월 사용량 예약 (한도 초과면 원자적으로 거절)
  select coalesce((select s.plan from public.subscriptions s
                    where s.account_id = p_account_id and s.status = 'ACTIVE'), 'FREE')
    into v_plan;
  v_limit := private.ai_monthly_limit(v_plan, p_endpoint);

  insert into public.usage_counters as u (account_id, metric, period_start, used, reserved)
  values (p_account_id, v_metric, v_period, 0, 1)
  on conflict (account_id, metric, period_start) do update
     set reserved = u.reserved + 1
   where u.used + u.reserved < v_limit
  returning u.used, u.reserved into v_used, v_reserved;

  if v_used is null then
    return jsonb_build_object('ok', false, 'code', 'QUOTA_EXCEEDED', 'limit', v_limit, 'plan', v_plan);
  end if;

  -- 요청 원장 (본문 없이 해시·상태만)
  if v_prev.id is not null then
    update public.ai_requests
       set status = 'RESERVED', reserved_units = 1, charged_units = null, error_code = null,
           provider = p_provider, model = p_model, consent_id = v_consent,
           provider_request_id = null, input_tokens = null, output_tokens = null,
           created_at = now(), completed_at = null
     where id = v_prev.id
    returning id into v_id;
  else
    insert into public.ai_requests
      (account_id, workspace_id, consent_id, client_request_id, endpoint, input_hash,
       provider, model, status, reserved_units)
    values
      (p_account_id, p_workspace_id, v_consent, p_client_request_id, p_endpoint, p_input_hash,
       p_provider, p_model, 'RESERVED', 1)
    returning id into v_id;
  end if;

  return jsonb_build_object(
    'ok', true, 'request_id', v_id, 'consent_id', v_consent,
    'plan', v_plan, 'limit', v_limit, 'remaining', v_limit - v_used - v_reserved);
end $$;

create or replace function public.ai_finish_request(
  p_request_id           uuid,
  p_status               text,
  p_provider_request_id  text default null,
  p_input_tokens         integer default null,
  p_output_tokens        integer default null,
  p_error_code           text default null
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_req     public.ai_requests%rowtype;
  v_period  date;
begin
  if p_status not in ('SUCCEEDED', 'FAILED', 'UNKNOWN') then
    raise exception 'INVALID_STATUS: %', p_status using errcode = '22023';
  end if;

  update public.ai_requests
     set status              = p_status,
         provider_request_id = p_provider_request_id,
         input_tokens        = p_input_tokens,
         output_tokens       = p_output_tokens,
         error_code          = p_error_code,
         charged_units       = case when p_status = 'SUCCEEDED' then 1 else 0 end,
         completed_at        = now()
   where id = p_request_id and status = 'RESERVED'
  returning * into v_req;

  if v_req.id is null then
    return;  -- 이미 정산됨 (중복 호출 무시)
  end if;

  -- 예약 해제 + 성공이면 사용량 1 증가 (예약한 달 기준)
  v_period := date_trunc('month', v_req.created_at at time zone 'Asia/Seoul')::date;
  update public.usage_counters
     set reserved = greatest(reserved - 1, 0),
         used     = used + case when p_status = 'SUCCEEDED' then 1 else 0 end
   where account_id = v_req.account_id
     and metric = 'AI_' || upper(v_req.endpoint)
     and period_start = v_period;
end $$;

-- service_role(Edge Function)만 실행
revoke all on function public.ai_begin_request(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_finish_request(uuid, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ai_begin_request(uuid, uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.ai_finish_request(uuid, text, text, integer, integer, text) to service_role;
revoke all on function private.ai_monthly_limit(text, text) from public, anon, authenticated;
grant execute on function private.ai_monthly_limit(text, text) to service_role;
