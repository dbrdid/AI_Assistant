// ============================================================
// App.js — 앱의 "입구" (가장 먼저 실행되는 파일)
// ============================================================
// 하는 일은 "감싸기"뿐입니다. 바깥에서 안쪽 순서로:
//   SafeAreaProvider : 노치/상태바/하단 홈 바에 가려지지 않는 영역 정보를 모든 화면에 제공
//   MenuProvider     : 사이드 메뉴 열림/닫힘 상태를 모든 화면에 공유 (MenuContext.js)
//   AppNavigator     : 화면들과 화면 이동 (AppNavigator.js)

import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MenuProvider } from './src/navigation/MenuContext';
import AppNavigator from './src/navigation/AppNavigator';
import ErrorBoundary from './src/features/error/components/ErrorBoundary';
import AuthFlow from './src/features/auth/AuthFlow';
import { useAuth } from './src/data/auth/AuthStore';
import { colors } from './src/shared/theme/theme';
import SetupFlow from './src/features/setup/SetupFlow';
import { isSetupDone } from './src/data/setup/SetupStore';
import { startNotifier, stopNotifier } from './src/services/notify/NotifyEngine';

// 로그인 상태에 따라 화면 고르기: 확인 중(로딩) / 로그인 전(로그인·가입) / 로그인 후(앱 본 화면)
function Root() {
  const { status, user } = useAuth();
  const [setup, setSetup] = useState('checking'); // 'checking' | 'needed' | 'done'  (로그인한 계정이 최초 설정을 마쳤는지)
  const email = user ? user.email : '';
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
  if (setup === 'needed') return <SetupFlow user={user} onDone={() => setSetup('done')} />;
  return <AppNavigator />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MenuProvider>
        {/* 상태바(시계/배터리) 글자색을 어둡게 */}
        <StatusBar style="dark" />
        <ErrorBoundary>
          <Root />
        </ErrorBoundary>
      </MenuProvider>
    </SafeAreaProvider>
  );
}