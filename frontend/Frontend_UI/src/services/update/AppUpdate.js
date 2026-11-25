// AppUpdate.js — 새 버전 알림 (Android). AI_Assistant 릴리스에서 지금보다 높은 Atria APK를 찾는다.
// 받은 APK를 설치하면 Android가 같은 앱의 업데이트로 덮어쓰므로 기기 데이터는 그대로 남는다(같은 서명, 더 큰 versionCode).
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { pickUpdate } from './pickUpdate.mjs';

const RELEASES = 'https://api.github.com/repos/dbrdid/AI_Assistant/releases?per_page=20';
export const appVersion = () => Constants.expoConfig?.version ?? '0.0.0';

let checked = null; // once per app launch
export function useAppUpdate() {
  const [update, setUpdate] = useState(null);
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    let alive = true;
    checked ??= fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' } })
      .then(r => (r.ok ? r.json() : []))
      .then(list => pickUpdate(list, appVersion()))
      .catch(() => null);
    checked.then(found => { if (alive) setUpdate(found); });
    return () => { alive = false; };
  }, []);
  return update;
}
