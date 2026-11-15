// 기기 등록: 로그인 후 한 번 호출. 받은 deviceId를 pushChanges에 넘기면 어느 기기에서 바꿨는지 기록됩니다.
//   installation_id = 앱 설치마다 한 번 만든 고유값 (앱을 지우면 새로 생김)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { newId } from './ids';
import { toSyncError } from './errors';
import { requireUserId, supabase } from './supabase';

const INSTALLATION_KEY = 'stella.installation_id';

export async function getInstallationId(): Promise<string> {
  let id = await AsyncStorage.getItem(INSTALLATION_KEY);
  if (!id) {
    id = newId();
    await AsyncStorage.setItem(INSTALLATION_KEY, id);
  }
  return id;
}

export async function registerDevice(info: {
  appVersion: string;                 // 예: Constants.expoConfig?.version ?? '0.0.0'
  deviceName?: string;                // 100자까지
  push?: { provider: 'FCM' | 'APNS' | 'EXPO'; token: string } | null;  // 알림 토큰 (Expo 토큰은 push.ts registerPushToken을 쓰세요: 같은 휴대폰의 다른 계정 정리)
}): Promise<string> {
  const uid = await requireUserId();
  const installationId = await getInstallationId();
  // 알림 토큰과 제공자는 항상 같이 있거나 같이 없어야 함 (서버 제약). 생략하면 기존 값 유지
  const fields = {
    app_version: info.appVersion,
    ...(info.deviceName !== undefined ? { device_name: info.deviceName.slice(0, 100) } : {}),
    ...(info.push !== undefined
      ? { push_provider: info.push?.provider ?? null, push_token: info.push?.token ?? null }
      : {}),
  };

  // 이미 등록된 설치면 정보만 갱신 (account_id·installation_id는 앱이 수정할 수 없어서 upsert 대신 조회 후 분기)
  const { data: found, error: findErr } = await supabase
    .from('devices').select('id, revoked_at')
    .eq('account_id', uid).eq('installation_id', installationId).maybeSingle();
  if (findErr) throw toSyncError(findErr);

  if (found) {
    if (found.revoked_at) throw new Error('DEVICE_REVOKED: 이 기기는 로그아웃 처리됐습니다. 다시 로그인하세요');
    const { error } = await supabase
      .from('devices').update({ ...fields, last_seen_at: new Date().toISOString() }).eq('id', found.id);
    if (error) throw toSyncError(error);
    return found.id;
  }

  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
  const { data, error } = await supabase
    .from('devices')
    .insert({ account_id: uid, installation_id: installationId, platform, ...fields })
    .select('id').single();
  if (error) throw toSyncError(error);
  return data.id;
}
