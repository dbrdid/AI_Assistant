-- =====================================================================
-- Edge Function 주소를 프로젝트마다 (11/25)
--   cron·트리거가 부르는 Edge Function 주소가 첫 프로젝트(zcbl…)로 고정돼 있어서, 새 프로젝트에서는 남의 프로젝트를 부르게 됨
--   → Vault 비밀값 'project_url'(예: https://<ref>.supabase.co)을 쓰고, 없으면 예전 주소 그대로 (기존 프로젝트 동작 유지)
--   새 프로젝트: select vault.create_secret('https://<ref>.supabase.co', 'project_url');
-- =====================================================================

create or replace function private.function_url(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select rtrim(coalesce(
           (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1),
           'https://zcblwwcukkbcwmgugknl.supabase.co'), '/') || '/functions/v1/' || p_name
$$;
revoke all on function private.function_url(text) from public, anon, authenticated;

-- Edge Function 호출 (Vault 비밀값을 붙여서). pg_net은 트랜잭션이 끝난 뒤 보냄
create or replace function private.stt_call_function(p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := private.function_url(p_name),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
end $$;

-- 매시간 정리: 같은 이름으로 다시 등록하면 명령만 바뀜
select cron.schedule('stt-uploads-cleanup', '23 * * * *', 'select private.stt_call_function(''stt-cleanup'')');
