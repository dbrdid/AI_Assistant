-- =====================================================================
-- 06. 보안·성능 진단 반영
--  - 자동 RLS 이벤트 트리거 함수(rls_auto_enable)의 API 실행 권한 회수 (트리거 동작은 유지)
--  - profiles SELECT 정책 2개 → 1개로 병합 (multiple permissive policies)
-- =====================================================================

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

drop policy profiles_select_own       on public.profiles;
drop policy profiles_select_coworkers on public.profiles;

create policy profiles_select on public.profiles
  for select to authenticated
  using (account_id = (select auth.uid()) or private.shares_workspace(account_id));
