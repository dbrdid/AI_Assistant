import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import ErrorBoundary from './src/features/error/components/ErrorBoundary';
import AuthFlow from './src/features/auth/AuthFlow';
import { useAuth, retrySession } from './src/data/auth/AuthStore';
import { updateSettings, useSettings } from './src/data/settings/SettingsStore';
import { authenticateFingerprint, supportsFingerprintOnly } from './src/services/device/FingerprintAuth';
import { colors } from './src/shared/theme/theme';
import SetupFlow from './src/features/setup/SetupFlow';
import { isSetupDone } from './src/data/setup/SetupStore';
import { startNotifier, stopNotifier } from './src/services/notify/NotifyEngine';
import { LOCAL_PREVIEW } from './src/integration/mode';

// 로그인 상태에 따라 화면 고르기: 확인 중(로딩) / 로그인 전(로그인 / 가입) / 로그인 후(앱 본 화면)
// 지문 잠금 (설정 > 보안). 지문 센서가 있는 휴대폰에서만, 앱을 다시 열 때마다
function AppLockScreen({ busy, error, onUnlock }) {
  return (
    <SafeAreaView style={lockStyles.root}>
      <Text style={lockStyles.title}>앱이 잠겨 있어요</Text>
      <Text style={lockStyles.sub}>지문으로 잠금을 해제해 주세요.</Text>
      {!!error && <Text style={lockStyles.error}>{error}</Text>}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onUnlock}
        style={[lockStyles.button, busy && { opacity: 0.6 }]}
      >
        <Text style={lockStyles.buttonText}>{busy ? '인증 중…' : '잠금 해제'}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function Root() {
  const { status, user } = useAuth();
  const settings = useSettings();
  const [fingerprintOnlyAvailable, setFingerprintOnlyAvailable] = useState(null);
  const lockEnabled = Platform.OS !== 'web' && fingerprintOnlyAvailable === true && Boolean(settings.security?.lock);
  const [setup, setSetup] = useState('checking'); // 'checking' | 'needed' | 'done'  (로그인한 계정이 최초 설정을 마쳤는지)
  const [locked, setLocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const wasAuthenticated = useRef(false);
  const unlockInProgress = useRef(false);
  const email = user ? user.email : '';
  useEffect(() => {
    if (status !== 'in' || Platform.OS === 'web') {
      if (status !== 'in') setFingerprintOnlyAvailable(null);
      return undefined;
    }
    let active = true;
    setFingerprintOnlyAvailable(null);
    supportsFingerprintOnly().then(available => {
      if (!active) return;
      setFingerprintOnlyAvailable(available);
      if (!available && settings.security?.lock) updateSettings('security', { lock: false, biometric: false });
    }).catch(error => {
      console.warn('[app-lock] 지문 지원 여부를 확인하지 못했습니다', error);
      if (!active) return;
      setFingerprintOnlyAvailable(false);
      if (settings.security?.lock) updateSettings('security', { lock: false, biometric: false });
    });
    return () => { active = false; };
  }, [status, settings.security?.lock]);

  useEffect(() => {
    if (status !== 'in') {
      wasAuthenticated.current = false;
      setLocked(false);
      setUnlockError('');
      return;
    }
    if (Platform.OS !== 'web' && fingerprintOnlyAvailable === null) return;
    if (lockEnabled && !wasAuthenticated.current) setLocked(true);
    if (!lockEnabled) {
      setLocked(false);
      setUnlockError('');
    }
    wasAuthenticated.current = true;
  }, [status, lockEnabled, fingerprintOnlyAvailable]);

  useEffect(() => {
    if (status !== 'in' || !lockEnabled) return undefined;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (previous === 'active' && next !== 'active') {
        setLocked(true);
        setUnlockError('');
      }
      previous = next;
    });
    return () => subscription.remove();
  }, [status, lockEnabled]);

  const unlock = async () => {
    if (unlockInProgress.current) return;
    unlockInProgress.current = true;
    setUnlocking(true);
    setUnlockError('');
    try {
      const result = await authenticateFingerprint('지문으로 앱 잠금 해제');
      if (result.success) setLocked(false);
      else if (result.error !== 'user_cancel' && result.error !== 'app_cancel') {
        setUnlockError(result.error === 'fingerprint_only_unavailable'
          ? '지문 센서가 있는 기기에서 잠금을 사용할 수 있어요.'
          : '지문 인증에 실패했어요. 다시 시도해 주세요.');
      }
    } catch (e) {
      setUnlockError(e?.message || '인증을 완료하지 못했어요. 다시 시도해 주세요.');
    } finally {
      unlockInProgress.current = false;
      setUnlocking(false);
    }
  };

  useEffect(() => {
    let alive = true;
    if (status !== 'in') return undefined;
    if (LOCAL_PREVIEW) { setSetup('done'); return undefined; }
    setSetup('checking');
    isSetupDone(email).then((done) => alive && setSetup(done ? 'done' : 'needed'));
    return () => {
      alive = false;
    };
  }, [status, email]);

  // 로그인 + 최초 설정을 마친 상태에서만 알림 예약/알림함 동작
  const live = !LOCAL_PREVIEW && status === 'in' && setup === 'done';
  useEffect(() => {
    if (live) startNotifier();
    else stopNotifier();
  }, [live]);

  // 짧은 확인 단계: 스피너 없이 스플래시와 같은 배경만 (깜빡임 없음)
  if (status === 'loading' || (status === 'in' && (setup === 'checking' || (Platform.OS !== 'web' && fingerprintOnlyAvailable === null)))) {
    return <View style={{ flex: 1, backgroundColor: colors.cream }} />;
  }
  if (status === 'storage-error') return <View style={{flex:1,justifyContent:'center',padding:28,backgroundColor:colors.cream,gap:18}}><Text accessibilityRole="header" style={{fontSize:22,fontWeight:'600',color:colors.ink}}>작업 공간을 열지 못했습니다</Text><Text style={{fontSize:15,lineHeight:24,color:colors.muted}}>기기 저장소를 여는 중 문제가 생겼습니다. 다시 시도해 주세요.</Text><Pressable accessibilityRole="button" accessibilityLabel="다시 시도" onPress={()=>{void retrySession();}} style={{minHeight:44,paddingHorizontal:20,alignSelf:'flex-start',backgroundColor:colors.action,borderRadius:6,justifyContent:'center'}}><Text style={{fontSize:14,color:colors.onPrimary}}>다시 시도</Text></Pressable></View>;
  if (status !== 'in') return <AuthFlow />;
  if (locked) return <AppLockScreen busy={unlocking} error={unlockError} onUnlock={unlock} />;
  if (setup === 'needed') return <SetupFlow user={user} onDone={() => setSetup('done')} />;
  return <View style={{ flex: 1, backgroundColor: colors.cream }}><View style={{ flex: 1, width: '100%', maxWidth: 412, alignSelf: 'center' }}><AppNavigator /></View></View>;
}

export default function App() {
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const style = document.createElement('style');
    style.textContent = `@font-face{font-family:Stella Sans;src:url('/fonts/PretendardVariable.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}*{font-family:'Stella Sans','Malgun Gothic',sans-serif!important;font-synthesis:none}html,body,#root{height:100%;margin:0;background:#191a1b}*{scrollbar-width:none}*::-webkit-scrollbar{display:none;width:0;height:0}input,textarea{caret-color:#f0f0ee}div[dir=auto],span[dir=auto]{word-break:keep-all;overflow-wrap:anywhere}button{transition:background-color 120ms ease,color 120ms ease,opacity 120ms ease}button:active{opacity:.72}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #aebcab;outline-offset:2px}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
  return (
    <SafeAreaProvider>
      {/* 상태바(시계/배터리) 글자색을 어둡게 */}
      <StatusBar style="light" />
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

// 저장소 오류 화면과 같은 모양 (왼쪽 정렬 · 44 높이 버튼)
const lockStyles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 28, backgroundColor: colors.cream, gap: 18 },
  title: { fontSize: 22, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 15, lineHeight: 24, color: colors.muted },
  error: { fontSize: 14, lineHeight: 22, color: colors.coral },
  button: { minHeight: 44, paddingHorizontal: 20, alignSelf: 'flex-start', backgroundColor: colors.action, borderRadius: 6, justifyContent: 'center' },
  buttonText: { fontSize: 14, color: colors.onPrimary },
});
