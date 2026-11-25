import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import ErrorBoundary from './src/features/error/components/ErrorBoundary';
import AuthFlow from './src/features/auth/AuthFlow';
import { useAuth, retrySession } from './src/data/auth/AuthStore';
import { colors } from './src/shared/theme/theme';
import SetupFlow from './src/features/setup/SetupFlow';
import { isSetupDone } from './src/data/setup/SetupStore';
import { startNotifier, stopNotifier } from './src/services/notify/NotifyEngine';
import { LOCAL_PREVIEW } from './src/integration/mode';

// 로그인 상태에 따라 화면 고르기: 확인 중(로딩) / 로그인 전(로그인 / 가입) / 로그인 후(앱 본 화면)
function Root() {
  const { status, user } = useAuth();
  const [setup, setSetup] = useState('checking'); // 'checking' | 'needed' | 'done'  (로그인한 계정이 최초 설정을 마쳤는지)
  const email = user ? user.email : '';
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
  if (status === 'loading' || (status === 'in' && setup === 'checking')) {
    return <View style={{ flex: 1, backgroundColor: colors.cream }} />;
  }
  if (status === 'storage-error') return <View style={{flex:1,justifyContent:'center',padding:28,backgroundColor:colors.cream,gap:18}}><Text accessibilityRole="header" style={{fontSize:22,fontWeight:'600',color:colors.ink}}>작업 공간을 열지 못했습니다</Text><Text style={{fontSize:15,lineHeight:24,color:colors.muted}}>기기 저장소를 여는 중 문제가 생겼습니다. 다시 시도해 주세요.</Text><Pressable accessibilityRole="button" accessibilityLabel="다시 시도" onPress={()=>{void retrySession();}} style={{minHeight:44,paddingHorizontal:20,alignSelf:'flex-start',backgroundColor:colors.action,borderRadius:6,justifyContent:'center'}}><Text style={{fontSize:14,color:colors.onPrimary}}>다시 시도</Text></Pressable></View>;
  if (status !== 'in') return <AuthFlow />;
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
