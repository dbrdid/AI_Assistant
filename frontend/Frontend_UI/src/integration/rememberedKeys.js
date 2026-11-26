// AI 키를 이 휴대폰의 보안 저장소(Android Keystore로 암호화)에 기억한다. 서버로는 보내지 않는다.
// 내 서버(브리지) 연결 키, OpenAI·Anthropic 키를 한 번만 넣으면 앱을 다시 켜도 그대로 쓴다. 로그아웃하면 지운다.
import * as SecureStore from 'expo-secure-store';
import { KEY_PROVIDERS, attachKeyStore, setSessionKey } from './aiGateway.mjs';

const slot = provider => 'atria.ai-key.' + provider;

/** 앱이 이 파일을 불러오면 기억한 키를 불러온다. 화면은 이 약속이 끝난 뒤 다시 그리면 된다 */
export const keysReady = attachKeyStore({
  load: provider => SecureStore.getItemAsync(slot(provider)),
  save: (provider, value) => (value ? SecureStore.setItemAsync(slot(provider), value) : SecureStore.deleteItemAsync(slot(provider))).catch(() => {}),
}).catch(() => {});

/** 기억한 키를 모두 지움 (로그아웃, "기억한 키 지우기") */
export async function forgetRememberedKeys() {
  for (const provider of KEY_PROVIDERS) {
    setSessionKey(provider, '');
    await SecureStore.deleteItemAsync(slot(provider)).catch(() => {});
  }
}
