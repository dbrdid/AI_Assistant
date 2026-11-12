// ============================================================
// Notify.js — 기기 알림(푸시 팝업) 보내기 — expo-notifications 를 감싼 부분
// ============================================================
// 이 앱의 알림은 "서버 없이 기기 안에서 예약하는 알림(로컬 알림)" 이에요.
//   ensurePermission()     : 알림 권한 요청 → true/false
//   scheduleAll(list)      : 예약된 알림을 모두 지우고 list 대로 다시 예약  (list: [{ key, title, body, at(ms), data }])
//   cancelAll()            : 예약된 알림 모두 취소 (로그아웃할 때)

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const CHANNEL = 'planner';
const MAX_SCHEDULED = 60; // iOS 는 한 번에 64개까지만 예약할 수 있어서 여유를 둠
let ready = false;

async function setup() {
  if (ready) return;
  ready = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true, // 구버전 이름
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: '일정·할 일·브리핑',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
  } catch (e) {
    // 지원하지 않는 환경이면 무시
  }
}

export async function ensurePermission() {
  try {
    await setup();
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    if (cur.canAskAgain === false) return false;
    const req = await Notifications.requestPermissionsAsync();
    return !!req.granted;
  } catch (e) {
    return false;
  }
}

export async function cancelAll() {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (e) {
    // 무시
  }
}

export async function scheduleAll(list) {
  try {
    await setup();
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return 0;
    await Notifications.cancelAllScheduledNotificationsAsync();
    const type = (Notifications.SchedulableTriggerInputTypes && Notifications.SchedulableTriggerInputTypes.DATE) || 'date';
    let n = 0;
    for (const it of list.slice(0, MAX_SCHEDULED)) {
      if (it.at <= Date.now() + 1000) continue;
      await Notifications.scheduleNotificationAsync({
        content: { title: it.title, body: it.body, data: it.data || {} },
        trigger: { type, date: new Date(it.at), channelId: CHANNEL },
      });
      n += 1;
    }
    return n;
  } catch (e) {
    return 0;
  }
}

// ------------------------------------------------------------
// 폰 알림을 눌렀을 때: handler({ route, params }) 를 불러 줌. (앱이 꺼져 있다가 알림으로 켜진 경우도 처리)
// 돌려주는 함수를 부르면 감시를 끝냄.
// ------------------------------------------------------------
export function onNotificationTap(handler) {
  let off = () => {};
  try {
    const handle = (resp) => {
      const d = resp && resp.notification && resp.notification.request && resp.notification.request.content && resp.notification.request.content.data;
      if (d && d.route) handler({ route: d.route, params: d.params });
    };
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    off = () => sub.remove();
    // 알림을 눌러서 앱이 처음 켜진 경우
    Notifications.getLastNotificationResponseAsync()
      .then((r) => { if (r) handle(r); })
      .catch(() => {});
  } catch (e) {
    // 지원하지 않는 환경(웹 등)이면 무시
  }
  return off;
}
