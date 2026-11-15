-- =====================================================================
-- #37 일간 브리핑 기본 시각 08:00 → 09:00 (11/15 팀 결정)
--   프로젝트 마감 알림 기준 시각(그날 09:00)과 같게 맞춤. 주간 브리핑(월 09:00)과 켜짐 여부(둘 다 꺼짐)는 그대로
--   set_notification_settings는 설정 전체를 저장하므로, 다른 항목만 바꾼 사람에게도 08:00이 저장돼 있음
--   → 일간 브리핑이 꺼져 있고 08:00인 값만 09:00으로 옮김 (켜 둔 사람의 시각은 본인이 고른 값이라 그대로)
-- =====================================================================
create or replace function private.notification_defaults()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('push', true, 'workspace', true, 'recording', true, 'reminders', true,
    'briefing_daily', jsonb_build_object('on', false, 'time', '09:00'),
    'briefing_weekly', jsonb_build_object('on', false, 'day', 1, 'time', '09:00'))
$$;

update public.user_settings
   set preferences = jsonb_set(preferences, '{notifications,briefing_daily,time}', '"09:00"'::jsonb)
 where preferences -> 'notifications' -> 'briefing_daily' ->> 'time' = '08:00'
   and not coalesce((preferences -> 'notifications' -> 'briefing_daily' ->> 'on')::boolean, false);
