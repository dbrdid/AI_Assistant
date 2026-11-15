-- =====================================================================
-- 19. 녹음 → 글자(STT) 월 한도를 "분" 단위로
--   - ai_begin_request : p_units(이번 요청에 예약할 단위 수) 추가. 기존 호출(organize·analyze)은 기본 1
--   - ai_finish_request: p_charged_units(실제로 차감할 단위 수) 추가. 안 주면 예약한 만큼
--                        → STT는 OpenAI가 알려 준 실제 길이(분)로 차감 (앱이 길이를 적게 보내도 실제만큼)
--   - 한도: stt FREE 60분 / PRO 600분 (usage_counters.metric = 'AI_STT', 단위 = 분)
--   본문(녹음·전사 글)은 여전히 어디에도 저장하지 않음
-- =====================================================================

create or replace function private.ai_monthly_limit(p_plan text, p_endpoint text)
returns integer language sql immutable set search_path = '' as $$
  select case p_endpoint
           when 'organize' then case p_plan when 'PRO' then 1000 else 100 end
           when 'analyze'  then case p_plan when 'PRO' then 300  else 30  end
           when 'query'    then case p_plan when 'PRO' then 500  else 50  end
           when 'stt'      then case p_plan when 'PRO' then 600  else 60  end   -- 단위: 분
           else                 case p_plan when 'PRO' then 300  else 30  end
         end;
$$;

comment on column public.usage_counters.used is
  '이번 달 사용량. AI_STT는 분, 그 외 AI_* 는 요청 횟수';

-- ---------------------------------------------------------------------
-- 시작(예약): p_units 추가
-- ---------------------------------------------------------------------
drop function public.ai_begin_request(uuid, uuid, text, uuid, text, text, text);

create function public.ai_begin_request(
  p_account_id         uuid,
  p_client_request_id  uuid,
  p_endpoint           text,
  p_workspace_id       uuid,
  p_input_hash         text,
  p_provider           text,
  p_model              text,
  p_units              integer default 1
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
  if p_account_id is null or p_client_request_id is null or p_endpoint is null or p_input_hash is null
     or p_units is null or p_units < 1 or p_units > 1000 then
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

  -- 같은 client_request_id 재요청 처리
  select * into v_prev
    from public.ai_requests
   where account_id = p_account_id and client_request_id = p_client_request_id
     for update;
  if found then
    if v_prev.status = 'RESERVED' and v_prev.created_at < now() - interval '10 minutes' then
      -- 정산되지 못하고 남은 예약 → 결과 불명으로 정리
      perform public.ai_finish_request(v_prev.id, 'UNKNOWN', null, null, null, 'STALE_RESERVATION');
      return jsonb_build_object('ok', false, 'code', 'RESULT_UNKNOWN', 'request_id', v_prev.id);
    elsif v_prev.status = 'RESERVED' then
      return jsonb_build_object('ok', false, 'code', 'IN_PROGRESS', 'request_id', v_prev.id);
    elsif v_prev.status = 'UNKNOWN' then
      return jsonb_build_object('ok', false, 'code', 'RESULT_UNKNOWN', 'request_id', v_prev.id);
    elsif v_prev.status = 'SUCCEEDED' then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_DONE', 'request_id', v_prev.id);
    elsif v_prev.input_hash <> p_input_hash or v_prev.endpoint <> p_endpoint then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_REUSED');
    end if;
    -- FAILED → 같은 ID로 재시도 허용 (아래에서 다시 예약)
  end if;

  -- 월 사용량 예약 (한도 초과면 원자적으로 거절)
  select coalesce((select s.plan from public.subscriptions s
                    where s.account_id = p_account_id and s.status = 'ACTIVE'), 'FREE')
    into v_plan;
  v_limit := private.ai_monthly_limit(v_plan, p_endpoint);

  if p_units <= v_limit then
    insert into public.usage_counters as u (account_id, metric, period_start, used, reserved)
    values (p_account_id, v_metric, v_period, 0, p_units)
    on conflict (account_id, metric, period_start) do update
       set reserved = u.reserved + p_units
     where u.used + u.reserved + p_units <= v_limit
    returning u.used, u.reserved into v_used, v_reserved;
  end if;

  if v_used is null then
    -- remaining = 지금 남은 양 (이번 요청은 예약 안 됨)
    select greatest(v_limit - coalesce(sum(u.used + u.reserved), 0), 0) into v_used
      from public.usage_counters u
     where u.account_id = p_account_id and u.metric = v_metric and u.period_start = v_period;
    return jsonb_build_object('ok', false, 'code', 'QUOTA_EXCEEDED', 'limit', v_limit, 'plan', v_plan,
                              'requested', p_units, 'remaining', v_used);
  end if;

  -- 요청 원장 (본문 없이 해시·상태만)
  if v_prev.id is not null then
    update public.ai_requests
       set status = 'RESERVED', reserved_units = p_units, charged_units = null, error_code = null,
           provider = p_provider, model = p_model, consent_id = v_consent,
           provider_request_id = null, input_tokens = null, output_tokens = null,
           attempts = 0, cost_usd_micros = null,
           created_at = now(), completed_at = null
     where id = v_prev.id
    returning id into v_id;
  else
    insert into public.ai_requests
      (account_id, workspace_id, consent_id, client_request_id, endpoint, input_hash,
       provider, model, status, reserved_units)
    values
      (p_account_id, p_workspace_id, v_consent, p_client_request_id, p_endpoint, p_input_hash,
       p_provider, p_model, 'RESERVED', p_units)
    returning id into v_id;
  end if;

  -- remaining = 이번 요청 예약까지 반영한 남은 양 (Gateway는 그대로 전달)
  return jsonb_build_object(
    'ok', true, 'request_id', v_id, 'consent_id', v_consent,
    'plan', v_plan, 'limit', v_limit, 'units', p_units, 'remaining', v_limit - v_used - v_reserved);
end $$;

revoke all on function public.ai_begin_request(uuid, uuid, text, uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.ai_begin_request(uuid, uuid, text, uuid, text, text, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- 정산: p_charged_units 추가 (예약한 만큼 풀고, 실제만큼 차감)
-- ---------------------------------------------------------------------
drop function public.ai_finish_request(uuid, text, text, integer, integer, text, text, integer, bigint);

create function public.ai_finish_request(
  p_request_id           uuid,
  p_status               text,
  p_provider_request_id  text    default null,
  p_input_tokens         integer default null,
  p_output_tokens        integer default null,
  p_error_code           text    default null,
  p_model                text    default null,
  p_attempts             integer default null,
  p_cost_usd_micros      bigint  default null,
  p_charged_units        integer default null
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_req     public.ai_requests%rowtype;
  v_period  date;
  v_counts  boolean := p_status in ('SUCCEEDED', 'UNKNOWN');  -- 결과 불명도 비용이 났을 수 있으므로 포함
begin
  if p_status not in ('SUCCEEDED', 'FAILED', 'UNKNOWN') then
    raise exception 'INVALID_STATUS: %', p_status using errcode = '22023';
  end if;
  if p_charged_units is not null and (p_charged_units < 0 or p_charged_units > 1000) then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  update public.ai_requests
     set status              = p_status,
         provider_request_id = p_provider_request_id,
         input_tokens        = p_input_tokens,
         output_tokens       = p_output_tokens,
         error_code          = p_error_code,
         model               = coalesce(p_model, model),
         attempts            = coalesce(least(greatest(p_attempts, 0), 5), attempts),
         cost_usd_micros     = p_cost_usd_micros,
         charged_units       = case when v_counts then coalesce(p_charged_units, reserved_units) else 0 end,
         completed_at        = now()
   where id = p_request_id and status = 'RESERVED'
  returning * into v_req;

  if v_req.id is null then
    return;  -- 이미 정산됨 (중복 호출 무시)
  end if;

  v_period := date_trunc('month', v_req.created_at at time zone 'Asia/Seoul')::date;
  update public.usage_counters
     set reserved = greatest(reserved - v_req.reserved_units, 0),
         used     = used + v_req.charged_units
   where account_id = v_req.account_id
     and metric = 'AI_' || upper(v_req.endpoint)
     and period_start = v_period;
end $$;

revoke all on function public.ai_finish_request(uuid, text, text, integer, integer, text, text, integer, bigint, integer) from public, anon, authenticated;
grant execute on function public.ai_finish_request(uuid, text, text, integer, integer, text, text, integer, bigint, integer) to service_role;
