// Supabase 클라이언트 (앱 전체에서 이것 하나만 사용)
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, processLock } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import { SUPABASE_KEY, SUPABASE_URL } from './config';
import type { Database } from './database.types';

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: AsyncStorage,      // 로그인 상태를 기기에 저장 (앱을 껐다 켜도 유지)
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,  // 웹이 아니므로 URL 자동 감지 끔 (딥링크는 auth.ts에서 직접 처리)
    flowType: 'pkce',           // Google·Kakao·이메일 링크 로그인을 code 교환 방식으로
    lock: processLock,
  },
});

// 앱이 앞에 있을 때만 토큰 자동 갱신 (Supabase 권장 설정)
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

/** 로그인한 사용자 id. 로그인 안 했으면 오류 */
export async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user.id;
  if (!id) throw new Error('AUTH_REQUIRED: 로그인이 필요합니다');
  return id;
}
