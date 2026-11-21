-- 기존 URL과 할당량 RPC 시그니처는 유지합니다. 자체 호스팅 클라우드 경로는 별도 동의가 필요하며,
-- EXTERNAL_AI는 계속 제3자 AI를 의미합니다.
alter table public.consents drop constraint consents_consent_type_check;
alter table public.consents add constraint consents_consent_type_check
  check (consent_type in ('TERMS','PRIVACY','EXTERNAL_AI','SERVER_AI','PERSONAL_SYNC','MARKETING'));

do $migration$
declare d text; old text := $fragment$c.consent_type = 'EXTERNAL_AI'$fragment$;
begin
  d := pg_get_functiondef('public.ai_begin_request(uuid,uuid,text,uuid,text,text,text)'::regprocedure);
  if (length(d) - length(replace(d, old, ''))) / length(old) <> 1 then
    raise exception 'Self-hosted consent migration: unexpected ai_begin_request definition';
  end if;
  execute replace(d, old,
    $fragment$c.consent_type = case when p_provider = 'self_hosted' then 'SERVER_AI' else 'EXTERNAL_AI' end$fragment$);
end
$migration$;
