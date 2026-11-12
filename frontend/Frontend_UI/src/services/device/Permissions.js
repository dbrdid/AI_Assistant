// ============================================================
// Permissions.js — 기기 권한 요청 (마이크 · 카메라 · 알림)
// ============================================================

import { Platform } from 'react-native';
import { Camera } from 'expo-camera';
import { ensurePermission } from '../notify/Notify';

export async function requestPermission(kind) {
  try {
    if (kind === 'camera') {
      const r = await Camera.requestCameraPermissionsAsync();
      return r.granted ? 'granted' : 'denied';
    }
    if (kind === 'mic') {
      const r = await Camera.requestMicrophonePermissionsAsync();
      return r.granted ? 'granted' : 'denied';
    }
    // 웹 브라우저는 앱 알림 권한을 지원하지 않아서(테스트용 화면) 막지 않고 통과시킴
    if (Platform.OS === 'web') return 'granted';
    return (await ensurePermission()) ? 'granted' : 'denied';
  } catch (e) {
    return 'denied';
  }
}
