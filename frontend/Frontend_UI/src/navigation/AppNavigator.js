// ============================================================
// AppNavigator.js — "어떤 화면을 보여줄지" 를 정하는 직접 만든 간단한 화면 이동기
// ============================================================
// 왜 직접 만들었나?
//   React Navigation 은 react-native-screens 라는 네이티브 패키지가 필요한데,
//   Snack 에서 이 패키지가 빌드 오류가 나서 쓸 수 없었습니다.
//   우리 앱은 "메뉴에서 선택 / 뒤로가기" 정도만 필요하므로 useState 로 충분히 만들 수 있습니다.
//
// 동작 원리: "방문 기록(history)" 배열 하나만 관리합니다. 각 칸은 { name, params, key } 입니다.
//   처음:                [홈]
//   메뉴에서 메모 선택:    [홈, 메모]          → 맨 끝(메모) 화면을 보여줌
//   뒤로가기:             [홈]               → 맨 끝을 빼서 이전 화면(홈)이 나옴
//   메뉴에서 홈 선택:      [홈]               → 기록을 비우고 홈으로
//
// ★ params(전달값): 화면을 옮길 때 "무엇을 보여줄지" 같은 정보를 함께 보낼 수 있습니다.
//   예) navigation.navigate('Memos', { focusId: 'memo-1' })  → 메모 화면이 열리면서 memo-1 로 자동 이동/강조
//   받는 쪽 화면에서는 route.params.focusId 로 꺼내 씁니다.
//
// ★ key: 이동할 때마다 새 번호를 붙여서, 같은 화면이라도 params 가 바뀌면 화면을 새로 만들어 줍니다.
//
// 또 하나: 캘린더 상태(보고 있는 달, 선택한 날짜)를 여기서 들고 있다가 홈과 캘린더 화면에 똑같이 넘겨줍니다.
//   → 홈에서 시트로 보던 달이 캘린더 화면에서도 그대로 이어집니다.
//
// 각 화면에는 React Navigation 과 똑같은 모양의 navigation 도구를 넘겨줍니다.
//   navigation.navigate(화면이름, 전달값)  → 그 화면으로 이동
//   navigation.goBack()                   → 이전 화면으로

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import SideMenu from './SideMenu';
import HomeScreen from '../features/home/screens/HomeScreen';
import PlaceholderScreen from '../shared/components/PlaceholderScreen';
import CalendarScreen from '../features/calendar/screens/CalendarScreen';
import AiChatScreen from '../features/ai/screens/AiChatScreen';
import SearchScreen from '../features/search/screens/SearchScreen';
import MemosScreen from '../features/memo/screens/MemoListScreen';
import TrashScreen from '../features/memo/screens/MemoTrashScreen';
import MemoEditScreen from '../features/memo/screens/MemoEditScreen';
import FilesScreen from '../features/files/screens/FilesScreen';
import TasksScreen from '../features/tasks/screens/TaskListScreen';
import TaskEditScreen from '../features/tasks/screens/TaskEditScreen';
import BriefingScreen from '../features/tasks/screens/BriefingScreen';
import ProjectsScreen from '../features/project/screens/ProjectListScreen';
import ProjectDetailScreen from '../features/project/screens/ProjectDetailScreen';
import ProjectEditScreen from '../features/project/screens/ProjectEditScreen';
import TeamScreen from '../features/project/screens/TeamScreen';
import InviteScreen from '../features/project/screens/ProjectInviteScreen';
import WorkspaceScreen from '../features/workspace/screens/WorkspaceScreen';
import BackupScreen from '../features/backup/screens/BackupScreen';
import AgendaCompareScreen from '../features/agenda/screens/AgendaCompareScreen';
import CameraScreen from '../features/camera/screens/CameraScreen';
import NoticeScreen from '../features/notice/screens/NoticeScreen';
import { onNotificationTap } from '../services/notify/Notify';
import { getTask } from '../data/tasks/TaskStore';
import { getProject } from '../data/projects/ProjectStore';
import ProposalListScreen from '../features/proposal/screens/ProposalListScreen';
import ProposalConfirmScreen from '../features/proposal/screens/ProposalConfirmScreen';
import { AnalysisFailedScreen, NetworkErrorScreen, ServerErrorScreen } from '../features/error/screens/ErrorScreens';
import QuickInputScreen from '../features/quick/screens/QuickInputScreen';
import SettingsScreen from '../features/settings/screens/SettingsScreen';
import AccountScreen from '../features/settings/screens/AccountScreen';
import SecurityScreen from '../features/settings/screens/SecurityScreen';
import AiSettingsScreen from '../features/settings/screens/AiSettingsScreen';
import AiUsageScreen from '../features/settings/screens/AiUsageScreen';
import NotificationSettingsScreen from '../features/settings/screens/NotificationSettingsScreen';
import SubscriptionScreen from '../features/settings/screens/SubscriptionScreen';
import WithdrawScreen from '../features/settings/screens/WithdrawScreen';
import WorkspaceCreateScreen from '../features/workspace/screens/WorkspaceCreateScreen';
import WorkspaceInviteScreen from '../features/workspace/screens/WorkspaceInviteScreen';
import { colors, FILL } from '../shared/theme/theme';
import { ROUTES } from './routes';

// ------------------------------------------------------------
// 진짜로 만들어진 화면 목록: { 화면 이름: 화면 컴포넌트 }
// ------------------------------------------------------------
// 여기에 등록된 화면은 그 화면을, 등록되지 않은 화면은 임시 화면(PlaceholderScreen)을 보여줍니다.
// 나중에 다른 화면(예: 할 일)을 만들면 이 목록에 한 줄만 추가하면 됩니다.
//   예)  [ROUTES.Tasks]: TasksScreen,
// 즐겨찾기 = 메모 화면을 "즐겨찾기만" 보이게 해서 재사용
const FavoritesScreen = (props) => <MemosScreen {...props} favoritesOnly />;

const REAL_SCREENS = {
  [ROUTES.QuickInput]: QuickInputScreen,                   // 홈 구슬 > 빠른 입력
  [ROUTES.NetworkError]: NetworkErrorScreen,               // 오류 안내 화면들
  [ROUTES.ServerError]: ServerErrorScreen,
  [ROUTES.AnalysisFailed]: AnalysisFailedScreen,
  [ROUTES.Notices]: NoticeScreen,                          // 홈 🔔 > 알림
  [ROUTES.Proposals]: ProposalListScreen,                  // AI 제안 확인 목록
  [ROUTES.ProposalConfirm]: ProposalConfirmScreen,         // AI 제안 하나 확인
  [ROUTES.Camera]: CameraScreen,                           // 홈 구슬 > 카메라
  [ROUTES.AgendaCompare]: AgendaCompareScreen,             // 홈 구슬 > 안건 비교
  [ROUTES.Settings]: SettingsScreen,                       // 사이드 메뉴 "설정"
  [ROUTES.Account]: AccountScreen,                         // 설정 > 계정
  [ROUTES.Security]: SecurityScreen,                       // 설정 > 보안 및 권한
  [ROUTES.AiSettings]: AiSettingsScreen,                   // 설정 > AI 및 브리핑
  [ROUTES.AiUsage]: AiUsageScreen,                         // 설정 > AI 이용량
  [ROUTES.NotificationSettings]: NotificationSettingsScreen, // 설정 > 알림
  [ROUTES.Subscription]: SubscriptionScreen,               // 설정 > 구독 관리
  [ROUTES.Withdraw]: WithdrawScreen,                       // 설정 > 회원탈퇴
  [ROUTES.Backup]: BackupScreen,                   // 사이드 메뉴 "백업 · 복원"
  [ROUTES.Workspace]: WorkspaceScreen,             // 사이드 메뉴 "워크스페이스 전환"
  [ROUTES.WorkspaceCreate]: WorkspaceCreateScreen, // 새 워크스페이스 만들기
  [ROUTES.WorkspaceInvite]: WorkspaceInviteScreen, // 초대 수락 / 만료
  [ROUTES.Calendar]: CalendarScreen, // 사이드 메뉴 "캘린더" + 홈 시트를 끝까지 올렸을 때
  [ROUTES.Ai]: AiChatScreen,         // 사이드 메뉴 "AI 채팅" + 홈의 ✦ 버튼
  [ROUTES.Search]: SearchScreen,     // 사이드 메뉴 "검색"
  [ROUTES.Memos]: MemosScreen,       // 사이드 메뉴 "메모" + 검색/AI 결과에서 이동
  [ROUTES.MemoEdit]: MemoEditScreen, // 메모 작성/편집 (메모 화면의 ＋ 버튼, 메모 카드)
  [ROUTES.Files]: FilesScreen,       // 사이드 메뉴 "파일 보관함" + 검색/AI 결과에서 이동
  [ROUTES.Trash]: TrashScreen,       // 사이드 메뉴 "휴지통" + 메모 화면의 ⋮ 메뉴
  [ROUTES.Favorites]: FavoritesScreen, // 사이드 메뉴 "즐겨찾기" + 메모 화면의 ⋮ 메뉴
  [ROUTES.Tasks]: TasksScreen,         // 사이드 메뉴 "할 일 목록"
  [ROUTES.TaskEdit]: TaskEditScreen,   // 일정/할 일 추가·편집
  [ROUTES.Briefing]: BriefingScreen,   // 오늘의 브리핑
  [ROUTES.Projects]: ProjectsScreen,           // 사이드 메뉴 "프로젝트" + 메모 화면의 ⋮ 메뉴
  [ROUTES.ProjectDetail]: ProjectDetailScreen, // 프로젝트 화면
  [ROUTES.ProjectEdit]: ProjectEditScreen,     // 프로젝트 추가/편집
  [ROUTES.ProjectTeam]: TeamScreen,            // 팀원 관리
  [ROUTES.ProjectInvite]: InviteScreen,        // 팀원 초대
};

export default function AppNavigator() {
  // history: 방문 기록. 맨 끝 요소가 "지금 보고 있는 화면". 처음엔 홈 하나.
  const [history, setHistory] = useState([{ name: ROUTES.Home, key: 0 }]);
  const keyRef = useRef(0); // 화면마다 붙일 번호표
  const current = history[history.length - 1];
  const currentRoute = current.name;

  // ---------- 캘린더 상태 (홈의 시트 + 캘린더 화면이 공유) ----------
  const today = useMemo(() => new Date(), []); // 앱을 연 시점의 오늘 날짜
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() }); // 보고 있는 달
  const [selected, setSelected] = useState(today); // 선택한 날짜

  // 이전 달(-1) / 다음 달(+1) 로 이동. new Date 가 12월 다음은 다음 해 1월로 자동 계산해 줍니다.
  const shiftMonth = useCallback(
    (delta) => {
      const d = new Date(cursor.year, cursor.month + delta, 1);
      setCursor({ year: d.getFullYear(), month: d.getMonth() });
      setSelected(d); // 달을 옮기면 그 달 1일을 선택
    },
    [cursor],
  );
  // "오늘" 버튼: 오늘이 있는 달로 돌아가고 오늘을 선택
  const goToday = useCallback(() => {
    const t = new Date();
    setCursor({ year: t.getFullYear(), month: t.getMonth() });
    setSelected(t);
  }, []);
  // 특정 날짜로 이동 (연·월 고르기, 검색 결과 선택)
  const goToDate = useCallback((d) => {
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
    setSelected(d);
  }, []);
  // 화면들에 넘길 묶음 (값이 바뀔 때만 새로 만듦)
  const calendar = useMemo(
    () => ({ today, cursor, selected, setSelected, shiftMonth, goToday, goToDate }),
    [today, cursor, selected, shiftMonth, goToday, goToDate],
  );

  // ---------- 화면 이동 ----------
  const navigate = useCallback((route, params) => {
    setHistory((prev) => {
      const top = prev[prev.length - 1];

      // 홈으로: 기록을 비우고 처음으로
      if (route === ROUTES.Home) return top.name === ROUTES.Home ? prev : [{ name: ROUTES.Home, key: 0 }];

      // 지금 보고 있는 화면으로 다시 이동하는 경우
      if (top.name === route) {
        if (params === undefined) return prev; // 전달값도 없으면 아무것도 안 함 (메뉴에서 같은 항목 누름)
        // 전달값이 새로 왔다면 지금 화면을 새 전달값으로 "교체" (예: 메모 화면에서 다른 메모로 이동)
        keyRef.current += 1;
        return [...prev.slice(0, -1), { name: route, params, key: keyRef.current }];
      }

      // 그 외: 기록 끝에 추가(= 위에 쌓기)
      keyRef.current += 1;
      return [...prev, { name: route, params, key: keyRef.current }];
    });
  }, []);

  // 뒤로가기: 기록이 2개 이상일 때만 맨 끝을 제거
  const goBack = useCallback(() => {
    setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  // 안드로이드 하드웨어 뒤로가기 버튼: 홈이 아니면 앱을 끄지 않고 이전 화면으로
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (history.length > 1) {
        goBack();
        return true; // true = 내가 처리했음(앱 종료 안 함)
      }
      return false; // false = 홈에서는 기본 동작(앱 종료/백그라운드)
    });
    return () => sub.remove();
  }, [history, goBack]);

  // 폰 알림을 누르면 그 알림의 화면으로 이동 (없는 화면 이름이면 무시)
  useEffect(
    () =>
      onNotificationTap(({ route, params }) => {
        if (!Object.values(ROUTES).includes(route)) return;
        // 이미 지운 일정/프로젝트의 알림이면 빈 편집 화면 대신 목록으로 보냄
        if (route === ROUTES.TaskEdit && params && params.taskId && !getTask(params.taskId)) return navigate(ROUTES.Tasks);
        if (route === ROUTES.ProjectDetail && params && params.projectId && !getProject(params.projectId)) return navigate(ROUTES.Projects);
        navigate(route, params);
      }),
    [navigate],
  );

  // 각 화면에 넘겨줄 navigation 도구 (값이 바뀔 때만 새로 만듦)
  const navigation = useMemo(() => ({ navigate, goBack }), [navigate, goBack]);

  const onHome = currentRoute === ROUTES.Home;
  // 지금 화면에 맞는 컴포넌트 선택: 등록된 진짜 화면이 있으면 그것, 없으면 임시 화면
  const Screen = REAL_SCREENS[currentRoute] || PlaceholderScreen;

  return (
    <View style={styles.root}>
      {/* 홈 화면: 다른 화면으로 가도 "지우지 않고 숨기기만" 합니다(display: 'none').
          그래서 돌아왔을 때 캘린더에서 보던 달/선택한 날짜가 그대로 남아 있습니다. */}
      <View style={[styles.fill, !onHome && styles.hidden]}>
        <HomeScreen navigation={navigation} calendar={calendar} />
      </View>

      {/* 홈이 아닐 때만, 현재 화면을 홈 위에 보여줌.
          route 는 React Navigation 처럼 { name, params } 모양으로 넘깁니다.
          key 가 바뀌면(= 새로 이동하면) 화면이 새로 만들어집니다. */}
      {!onHome && (
        <View style={styles.fill}>
          <Screen
            key={current.key}
            navigation={navigation}
            calendar={calendar}
            route={{ name: current.name, params: current.params }}
          />
        </View>
      )}

      {/* 사이드 메뉴: 화면 위에 겹쳐 뜨는 부품. 항목을 누르면 navigate 로 이동 */}
      <SideMenu onNavigate={navigate} currentRoute={currentRoute} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  fill: { ...FILL }, // 부모 전체를 덮음 (화면들이 같은 자리에 겹쳐짐)
  hidden: { display: 'none' },                // 보이지 않게 숨김(메모리에는 유지)
});