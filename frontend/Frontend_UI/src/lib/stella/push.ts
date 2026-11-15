// ============================================================
// push.ts — 푸시 알림 · 브리핑 (#34, 11/15)
//   서버가 보내는 것: 공유 공간 할 일 마감·일정 시작·프로젝트 마감 전(reminder_minutes),
//                    새 멤버 들어옴, 긴 녹음 변환 끝, 일간·주간 브리핑 시각
//   개인 할 일·일정 알림은 지금처럼 기기 로컬 알림 (서버에 기록이 없음)
//   브리핑 푸시는 안내만 → 누르면 Briefing 화면이 기기의 개인+공유 기록으로 내용을 만듦
//
//   앱 연결
//     1. 로그인 후: const { data } = await Notifications.getExpoPushTokenAsync({ projectId })
//                  await registerPushToken(supabase, deviceId, data)   (deviceId = registerDevice 결과)
//     2. 설정 > AI 및 브리핑 저장 때: await setNotificationSettings(supabase, briefingFromAiSettings(ai))
//        설정 > 알림: setNotificationSettings(supabase, { push, workspace, recording, reminders })
//     3. 알림을 눌렀을 때: notificationTarget(response.notification.request.content.data) → navigation.navigate(...)
//     4. 홈의 🔔(Notices): listNotifications · markNotificationsRead
// RN 의존 없음
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { toSyncError } from './errors';

export interface BriefingSetting { on: boolean; time: string }            // time 'HH:MM' (24시간)
export interface WeeklyBriefingSetting extends BriefingSetting { day: number }   // 0(일) ~ 6(토)
export interface NotificationSettings {
  push: boolean;        // 전체
  workspace: boolean;   // 공간 소식 (새 멤버)
  recording: boolean;   // 녹음 변환 끝
  reminders: boolean;   // 공유 기록 마감·시작 전
  briefing_daily: BriefingSetting;
  briefing_weekly: WeeklyBriefingSetting;
}
export type NotificationSettingsPatch = Partial<Omit<NotificationSettings, 'briefing_daily' | 'briefing_weekly'>> & {
  briefing_daily?: Partial<BriefingSetting>;
  briefing_weekly?: Partial<WeeklyBriefingSetting>;
};

export type NotificationKind =
  | 'BRIEFING_DAILY' | 'BRIEFING_WEEKLY' | 'EVENT_REMINDER' | 'TASK_REMINDER' | 'PROJECT_REMINDER'
  | 'WORKSPACE_JOINED' | 'RECORDING_DONE' | 'INVITE' | 'SYSTEM';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  workspace_id: string | null;
  title: string | null;
  body: string | null;
  data: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
}

const EXPO_TOKEN_RE = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{10,200}\]$/;

/** 이 기기의 Expo 알림 토큰 저장 (같은 휴대폰에서 다른 계정이 쓰던 토큰이면 서버가 그쪽에서 뺌) */
export async function registerPushToken(client: SupabaseClient, deviceId: string, expoToken: string): Promise<void> {
  if (!EXPO_TOKEN_RE.test(expoToken)) throw toSyncError({ message: 'INVALID_REQUEST: Expo 알림 토큰이 아닙니다' });
  const { error } = await client.rpc('set_push_token', { p_device_id: deviceId, p_token: expoToken, p_provider: 'EXPO' });
  if (error) throw toSyncError(error);
}

/** 이 기기 알림 끄기 (로그아웃 전에도 부르세요) */
export async function disablePushToken(client: SupabaseClient, deviceId: string): Promise<void> {
  const { error } = await client.rpc('set_push_token', { p_device_id: deviceId, p_token: null });
  if (error) throw toSyncError(error);
}

export async function getNotificationSettings(client: SupabaseClient): Promise<NotificationSettings> {
  const { data, error } = await client.rpc('get_notification_settings');
  if (error) throw toSyncError(error);
  return data as NotificationSettings;
}

/** 바꿀 항목만. 반환: 저장된 전체 설정 */
export async function setNotificationSettings(client: SupabaseClient, patch: NotificationSettingsPatch): Promise<NotificationSettings> {
  const { data, error } = await client.rpc('set_notification_settings', { p_patch: patch });
  if (error) throw toSyncError(error);
  return data as NotificationSettings;
}

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

/** 화면의 요일 표시('월', '월요일', 'Mon', 숫자) → 0(일)~6(토). 모르면 null */
export function weekdayIndex(day: unknown): number | null {
  if (typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6) return day;
  const s = String(day ?? '').trim();
  if (!s) return null;
  const ko = DAY_NAMES.indexOf(s[0]);
  if (ko >= 0) return ko;
  const en = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(s.slice(0, 3).toLowerCase());
  return en >= 0 ? en : null;
}

/** 화면의 시각('09:00', '9:5', '오전 9:00', '오후 9:30', '21:00') → 'HH:MM'. 모르면 null */
export function toHHMM(time: unknown): string | null {
  const s = String(time ?? '').trim();
  const m = /^(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{1,2})\s*(AM|PM)?$/i.exec(s);
  if (!m) return null;
  let h = Number(m[2]);
  const min = Number(m[3]);
  const ap = (m[1] ?? m[4] ?? '').toUpperCase();
  if (min > 59 || h > 23) return null;
  if (ap === '오후' || ap === 'PM') { if (h > 12) return null; if (h < 12) h += 12; }
  if (ap === '오전' || ap === 'AM') { if (h > 12) return null; if (h === 12) h = 0; }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * AiSettingsScreen의 ai.daily / ai.weekly → 서버 설정 patch
 *   ai.daily = { on, time }, ai.weekly = { on, day, time } (화면 값 그대로 넘기면 됨)
 */
export function briefingFromAiSettings(ai: {
  daily?: { on?: boolean; time?: unknown };
  weekly?: { on?: boolean; day?: unknown; time?: unknown };
}): NotificationSettingsPatch {
  const patch: NotificationSettingsPatch = {};
  if (ai.daily) {
    const t = toHHMM(ai.daily.time);
    patch.briefing_daily = { on: !!ai.daily.on, ...(t ? { time: t } : {}) };
  }
  if (ai.weekly) {
    const t = toHHMM(ai.weekly.time);
    const d = weekdayIndex(ai.weekly.day);
    patch.briefing_weekly = { on: !!ai.weekly.on, ...(t ? { time: t } : {}), ...(d != null ? { day: d } : {}) };
  }
  return patch;
}

/** 알림을 눌렀을 때 갈 화면 (frontend ROUTES 이름) */
export function notificationTarget(data: Record<string, unknown> | null | undefined): { route: string; params?: Record<string, unknown> } {
  const d = data ?? {};
  switch (d.type) {
    case 'briefing': return { route: 'Briefing', params: { period: d.period ?? 'daily' } };
    case 'tasks':
    case 'events': return { route: 'TaskEdit', params: { workspaceId: d.workspace_id, id: d.id, kind: d.type === 'tasks' ? 'task' : 'event' } };
    case 'projects': return { route: 'ProjectDetail', params: { workspaceId: d.workspace_id, id: d.id } };
    case 'workspace': return { route: 'Workspace', params: { workspaceId: d.workspace_id } };
    case 'recording': return { route: 'Notices', params: { recordingId: d.recording_id } };
    default: return { route: 'Notices' };
  }
}

/** 받은 알림함 (최근 것부터, p_before로 더 보기) */
export async function listNotifications(client: SupabaseClient, opts: { limit?: number; before?: string } = {}): Promise<NotificationItem[]> {
  const { data, error } = await client.rpc('list_notifications', { p_limit: opts.limit ?? 50, p_before: opts.before ?? null });
  if (error) throw toSyncError(error);
  return (data ?? []) as NotificationItem[];
}

/** 읽음 표시 (ids 없으면 전부). 반환: 바뀐 개수 */
export async function markNotificationsRead(client: SupabaseClient, ids?: string[]): Promise<number> {
  const { data, error } = await client.rpc('mark_notifications_read', { p_ids: ids && ids.length ? ids : null });
  if (error) throw toSyncError(error);
  return Number(data ?? 0);
}

export const unreadCount = (items: Pick<NotificationItem, 'read_at'>[]): number => items.filter((n) => !n.read_at).length;
