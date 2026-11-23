import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import ErrorBoundary from './src/features/error/components/ErrorBoundary';
import AuthFlow from './src/features/auth/AuthFlow';
import { useAuth } from './src/data/auth/AuthStore';
import { useSettings } from './src/data/settings/SettingsStore';
import { colors } from './src/shared/theme/theme';
import SetupFlow from './src/features/setup/SetupFlow';
import { isSetupDone } from './src/data/setup/SetupStore';
import { startNotifier, stopNotifier } from './src/services/notify/NotifyEngine';

function AppLockScreen({ busy, error, onUnlock }) {
  return (
    <SafeAreaView style={lockStyles.root}>
      <Text style={lockStyles.title}>앱이 잠겨 있어요</Text>
      <Text style={lockStyles.sub}>Face ID 또는 지문으로 잠금을 해제해 주세요.</Text>
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

// 로그인 상태에 따라 화면 고르기: 확인 중(로딩) / 로그인 전(로그인·가입) / 로그인 후(앱 본 화면)
function Root() {
  const { status, user } = useAuth();
  const settings = useSettings();
  const lockEnabled = Platform.OS !== 'web' && Boolean(settings.security?.lock);
  const [setup, setSetup] = useState('checking'); // 상태: 확인 중 | 설정 필요 | 완료 (로그인한 계정의 최초 설정 완료 여부)
  const [locked, setLocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const wasAuthenticated = useRef(false);
  const unlockInProgress = useRef(false);
  const email = user ? user.email : '';

  useEffect(() => {
    if (status !== 'in') {
      wasAuthenticated.current = false;
      setLocked(false);
      setUnlockError('');
      return;
    }
    if (lockEnabled && !wasAuthenticated.current) setLocked(true);
    if (!lockEnabled) {
      setLocked(false);
      setUnlockError('');
    }
    wasAuthenticated.current = true;
  }, [status, lockEnabled]);

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
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: '앱 잠금 해제',
        cancelLabel: '취소',
        disableDeviceFallback: false,
      });
      if (result.success) setLocked(false);
      else if (result.error !== 'user_cancel' && result.error !== 'app_cancel') {
        setUnlockError('생체 인증에 실패했어요. 다시 시도해 주세요.');
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
    setSetup('checking');
    isSetupDone(email).then((done) => alive && setSetup(done ? 'done' : 'needed'));
    return () => {
      alive = false;
    };
  }, [status, email]);

  // 로그인 + 최초 설정을 마친 상태에서만 알림 예약/알림함 동작
  const live = status === 'in' && setup === 'done';
  useEffect(() => {
    if (live) startNotifier();
    else stopNotifier();
  }, [live]);

  if (status === 'loading' || (status === 'in' && setup === 'checking')) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.mintDark} />
      </View>
    );
  }
  if (status !== 'in') return <AuthFlow />;
  if (locked) return <AppLockScreen busy={unlocking} error={unlockError} onUnlock={unlock} />;
  if (setup === 'needed') return <SetupFlow user={user} onDone={() => setSetup('done')} />;
  return <AppNavigator />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      {/* 상태 표시줄(시계/배터리) 글자색을 어둡게 */}
      <StatusBar style="dark" />
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const lockStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  sub: { fontSize: 14, color: colors.muted, textAlign: 'center' },
  error: { fontSize: 14, fontWeight: '700', color: colors.coral, textAlign: 'center' },
  button: { minHeight: 52, alignSelf: 'stretch', borderRadius: 14, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  buttonText: { fontSize: 16, fontWeight: '800', color: colors.white },
});