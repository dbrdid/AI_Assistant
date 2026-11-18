// ============================================================
// PushRegister.js — 서버 푸시 알림 받기 (Expo 푸시 토큰을 서버에 등록)
// ============================================================
// 기기 안 예약 알림(NotifyEngine)이 하는 일: 개인·지금 공간의 일정·할 일·프로젝트 알림, 브리핑
// 서버 푸시가 더하는 일 (lib/stella/push.ts):
//   · 공유 공간의 할 일 마감·일정 시작·프로젝트 마감 전 알림 (앱을 열지 않은 공간까지, 다른 멤버가 바꾼 것까지)
//   · 새 멤버 들어옴 · 녹음 변환 끝
//   브리핑은 기기 알림이 이미 보내므로 서버 브리핑은 켜지 않아요 (같은 알림이 두 번 오지 않게).
//   서버 알림이 켜져 있으면 NotifyEngine 은 공유 공간의 할 일·프로젝트를 기기에 따로 예약하지 않아요.
// 필요한 것: 휴대폰(웹은 푸시를 받을 수 없음) · 알림 권한 · 앱 설정의 EAS projectId (extra.eas.projectId)
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { supabase } from '../../lib/stella/supabase';
import { registerDevice } from '../../lib/stella/devices';
import { disablePushToken, registerPushToken, setNotificationSettings } from '../../lib/stella/push';
import { getSettings } from '../../data/settings/SettingsStore';

export const SERVER_NOTIFY_DEFAULT = Object.freeze({ on: true, reminders: true, workspace: true, recording: true });
export const serverNotify = () => ({ ...SERVER_NOTIFY_DEFAULT, ...(getSettings().notify?.server ?? {}) });

let state = { ready: false, deviceId: null, reason: '' };
const listeners = new Set();
const set = (next) => { state = { ...state, ...next }; listeners.forEach((fn) => fn(state)); };
export const pushState = () => state;
export const onPushState = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const projectId = () => Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;

/** 서버 알림을 받을 수 없는 이유 (받을 수 있으면 '') */
export function pushUnavailableReason() {
  if (Platform.OS === 'web') return '웹에서는 서버 알림을 받을 수 없어요. 휴대폰 앱에서 켜 주세요.';
  if (!projectId()) return '앱 빌드에 푸시 설정(EAS projectId)이 없어 서버 알림을 받을 수 없어요.';
  return '';
}

/** 서버 알림이 실제로 오고 있는지 (공유 공간 마감 알림을 기기에 따로 예약할지 정할 때) */
export const serverRemindersActive = () => state.ready && serverNotify().on && serverNotify().reminders;

/**
 * 이 기기를 서버 알림에 등록하고 서버 알림 설정을 맞춤.
 *   ask: 권한을 아직 안 물어봤으면 물어볼지 (설정 화면에서 켤 때만 true)
 * 반환 { ok, reason }
 */
export async function registerPush({ ask = false } = {}) {
  const pref = serverNotify();
  const why = pushUnavailableReason();
  if (why) { set({ ready: false, reason: why }); return { ok: false, reason: why }; }
  if (!pref.on) { await unregisterPush(); return { ok: false, reason: '서버 알림이 꺼져 있어요.' }; }
  try {
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && ask && perm.canAskAgain !== false) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) { set({ ready: false, reason: '알림 권한이 꺼져 있어요. 휴대폰 설정에서 알림을 허용해 주세요.' }); return { ok: false, reason: state.reason }; }
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
    const deviceId = await registerDevice({ appVersion: Constants.expoConfig?.version ?? '0.0.0', deviceName: `${Platform.OS} 앱` });
    await registerPushToken(supabase, deviceId, token);
    await setNotificationSettings(supabase, {
      push: true, reminders: pref.reminders, workspace: pref.workspace, recording: pref.recording,
      briefing_daily: { on: false }, briefing_weekly: { on: false },
    });
    set({ ready: true, deviceId, reason: '' });
    return { ok: true, reason: '' };
  } catch (e) {
    console.warn('[push] 서버 알림 등록 실패', e);
    set({ ready: false, reason: '서버 알림을 등록하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    return { ok: false, reason: state.reason };
  }
}

/** 이 기기 서버 알림 끄기 (로그아웃 전, 설정에서 끌 때) */
//   다른 기기 알림·계정 설정은 그대로 두고 이 기기 토큰만 지워요. 앱을 다시 켠 뒤라 기기 번호를 모르면 등록 정보에서 찾음.
export async function unregisterPush() {
  let { deviceId } = state;
  set({ ready: false, deviceId: null });
  if (pushUnavailableReason()) return; // 웹 등: 이 기기로 등록한 적이 없음
  try {
    if (!deviceId) deviceId = await registerDevice({ appVersion: Constants.expoConfig?.version ?? '0.0.0' });
    await disablePushToken(supabase, deviceId);
  } catch (e) { console.warn('[push] 서버 알림 해제 실패', e); }
}
