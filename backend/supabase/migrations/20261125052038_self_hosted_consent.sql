-- Existing URLs and quota RPC signatures stay unchanged. A self-hosted cloud
-- route requires its own consent; EXTERNAL_AI continues to mean third-party AI.
alter table public.consents drop constraint consents_consent_type_check;
alter table public.consents add constraint consents_consent_type_check
  check (consent_type in ('TERMS','PRIVACY','EXTERNAL_AI','SERVER_AI','PERSONAL_SYNC','MARKETING'));

do $migration$
declare d text; old text := $fragment$c.consent_type = 'EXTERNAL_AI'$fragment$;
begin
  -- 20261114115314_stt_minute_quota가 p_units integer를 더해 8개 인자로 바꿈 (7개짜리는 없음)
  d := pg_get_functiondef('public.ai_begin_request(uuid,uuid,text,uuid,text,text,text,integer)'::regprocedure);
  if (length(d) - length(replace(d, old, ''))) / length(old) <> 1 then
    raise exception 'Self-hosted consent migration: unexpected ai_begin_request definition';
  end if;
  execute replace(d, old,
    $fragment$c.consent_type = case when p_provider = 'self_hosted' then 'SERVER_AI' else 'EXTERNAL_AI' end$fragment$);
end
$migration$;
