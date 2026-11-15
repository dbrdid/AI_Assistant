-- =====================================================================
-- 14. pg_cron: 10분마다 오래 RESERVED로 남은 AI 요청을 UNKNOWN으로 정산
--     (Supabase 원격 전용. 로컬 supabase start 환경에도 pg_cron이 있으면 동일하게 동작)
-- =====================================================================
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'ai-reconcile-stale',
  '*/10 * * * *',
  $$select public.ai_reconcile_stale()$$
);
