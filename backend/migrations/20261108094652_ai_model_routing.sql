-- =====================================================================
-- 15. AI 모델 2단 구성 (gpt-5.6-luna / gpt-6.1-terra)
--   - 요청마다 실제로 쓴 모델, 시도 횟수(승급 포함), 추정 비용(마이크로 USD)을 기록
--   - 엔드포인트별 월 한도: 비싼 Terra를 쓰는 analyze·query는 낮게
--   - 월별 비용 집계 뷰 (private 스키마: 앱에서는 안 보이고 대시보드 SQL 편집기에서만 조회)
--   본문(프롬프트·응답)은 여전히 어디에도 저장하지 않음
-- =====================================================================

alter table public.ai_requests add column attempts        smallint not null default 0 check (attempts between 0 and 5);
alter table public.ai_requests add column cost_usd_micros bigint check (cost_usd_micros >= 0);
comment on column public.ai_requests.model           is '최종 결과를 만든 모델 (승급했으면 승급한 모델). 시작 시에는 1차 모델';
comment on column public.ai_requests.attempts        is 'OpenAI 호출 횟수. 2 이상이면 1차 모델 실패 후 상위 모델로 승급한 것';
comment on column public.ai_requests.cost_usd_micros is '모든 시도의 추정 비용 합 (1 = 0.000001 USD). Gateway의 단가표 기준';
comment on column public.ai_requests.input_tokens    is '모든 시도의 입력 토큰 합';
comment on column public.ai_requests.output_tokens   is '모든 시도의 출력 토큰 합 (추론 토큰 포함)';

-- 엔드포인트별·요금제별 월 한도 (요청 수)
--   organize : Luna  (저렴)      FREE 100 / PRO 1000
--   analyze  : Terra (약 5배 비쌈) FREE  30 / PRO  300
--   query    : Terra             FREE  50 / PRO  500
--   그 외    :                   FREE  30 / PRO  300
create or replace function private.ai_monthly_limit(p_plan text, p_endpoint text)
returns integer language sql immutable set search_path = '' as $$
  select case p_endpoint
           when 'organize' then case p_plan when 'PRO' then 1000 else 100 end
           when 'analyze'  then case p_plan when 'PRO' then 300  else 30  end
           when 'query'    then case p_plan when 'PRO' then 500  else 50  end
           else                 case p_plan when 'PRO' then 300  else 30  end
         end;
$$;

-- 정산: 실제 모델·시도 횟수·비용 인자 추가 (기존 6개 인자 호출도 그대로 동작)
drop function if exists public.ai_finish_request(uuid, text, text, integer, integer, text);

create function public.ai_finish_request(
  p_request_id           uuid,
  p_status               text,
  p_provider_request_id  text    default null,
  p_input_tokens         integer default null,
  p_output_tokens        integer default null,
  p_error_code           text    default null,
  p_model                text    default null,
  p_attempts             integer default null,
  p_cost_usd_micros      bigint  default null
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

  update public.ai_requests
     set status              = p_status,
         provider_request_id = p_provider_request_id,
         input_tokens        = p_input_tokens,
         output_tokens       = p_output_tokens,
         error_code          = p_error_code,
         model               = coalesce(p_model, model),
         attempts            = coalesce(least(greatest(p_attempts, 0), 5), attempts),
         cost_usd_micros     = p_cost_usd_micros,
         charged_units       = case when v_counts then 1 else 0 end,
         completed_at        = now()
   where id = p_request_id and status = 'RESERVED'
  returning * into v_req;

  if v_req.id is null then
    return;  -- 이미 정산됨 (중복 호출 무시)
  end if;

  v_period := date_trunc('month', v_req.created_at at time zone 'Asia/Seoul')::date;
  update public.usage_counters
     set reserved = greatest(reserved - 1, 0),
         used     = used + case when v_counts then 1 else 0 end
   where account_id = v_req.account_id
     and metric = 'AI_' || upper(v_req.endpoint)
     and period_start = v_period;
end $$;

revoke all on function public.ai_finish_request(uuid, text, text, integer, integer, text, text, integer, bigint) from public, anon, authenticated;
grant execute on function public.ai_finish_request(uuid, text, text, integer, integer, text, text, integer, bigint) to service_role;

-- 월별 비용 집계 (팀 확인용). 예: select * from private.ai_cost_monthly;
create or replace view private.ai_cost_monthly as
select date_trunc('month', created_at at time zone 'Asia/Seoul')::date as month,
       endpoint,
       model,
       count(*)                                         as requests,
       count(*) filter (where status = 'SUCCEEDED')     as succeeded,
       count(*) filter (where status = 'FAILED')        as failed,
       count(*) filter (where status = 'UNKNOWN')       as unknown,
       count(*) filter (where attempts >= 2)            as escalated,
       coalesce(sum(input_tokens), 0)                   as input_tokens,
       coalesce(sum(output_tokens), 0)                  as output_tokens,
       round(coalesce(sum(cost_usd_micros), 0) / 1e6, 4) as cost_usd
  from public.ai_requests
 group by 1, 2, 3;

revoke all on private.ai_cost_monthly from public, anon, authenticated;
grant select on private.ai_cost_monthly to service_role;
