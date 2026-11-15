-- =====================================================================
-- #36 보안 점검 경고 정리 (11/15): #34·#35에서 만든 값만 돌려주는 함수 4개에 search_path 고정
--   (Function Search Path Mutable). 동작은 같음
-- =====================================================================
alter function private.notification_defaults() set search_path = '';
alter function private.notification_category(text) set search_path = '';
alter function private.lead_text(integer) set search_path = '';
alter function private.invite_mail_limits() set search_path = '';
