// ============================================================
// routes.js — "어떤 화면들이 있는지" 목록을 모아 둔 파일
// ============================================================
// 화면마다 고유한 이름(문자열)이 필요합니다. 이동할 때
// navigation.navigate('Ai') 처럼 이 이름으로 목적지를 지정합니다.
// 오타를 막기 위해 이름을 ROUTES 에 한 번만 적어 두고 가져다 씁니다.
// (예: navigation.navigate(ROUTES.Ai))

export const ROUTES = {
  Home: 'Home',           // 홈
  Search: 'Search',       // 검색
  Calendar: 'Calendar',   // 캘린더
  Ai: 'Ai',               // AI 채팅
  Projects: 'Projects',   // 프로젝트 목록
  ProjectDetail: 'ProjectDetail', // 프로젝트 화면 (연결된 항목)
  ProjectEdit: 'ProjectEdit',     // 프로젝트 추가/편집
  ProjectTeam: 'ProjectTeam',     // 팀원 관리
  ProjectInvite: 'ProjectInvite', // 팀원 초대
  Memos: 'Memos',         // 메모
  MemoEdit: 'MemoEdit',   // 메모 작성/편집 (메모 화면에서 이동. 사이드 메뉴에는 없음)
  Tasks: 'Tasks',         // 할 일 목록
  TaskEdit: 'TaskEdit',   // 일정/할 일 추가·편집 (캘린더·할 일 목록에서 이동)
  Briefing: 'Briefing',   // 오늘의 브리핑 (홈의 일정 개수 줄에서 이동)
  Favorites: 'Favorites', // 즐겨찾기
  Workspace: 'Workspace', // 워크스페이스 전환
  WorkspaceCreate: 'WorkspaceCreate', // 새 워크스페이스 만들기
  WorkspaceInvite: 'WorkspaceInvite', // 워크스페이스 초대 수락/만료
  Files: 'Files',         // 파일 보관함
  Backup: 'Backup',       // 백업·복원
  Trash: 'Trash',         // 휴지통
  Notices: 'Notices',     // 알림 (홈의 🔔)
  Proposals: 'Proposals',             // AI 제안 확인 목록 (검증 필요)
  ProposalConfirm: 'ProposalConfirm', // AI 제안 하나 확인
  Settings: 'Settings',   // 설정
  Account: 'Account',                 // 설정 > 계정(프로필 수정)
  Security: 'Security',               // 설정 > 보안 및 권한
  AiSettings: 'AiSettings',           // 설정 > AI 및 브리핑
  AiUsage: 'AiUsage',                 // 설정 > AI 이용량
  NotificationSettings: 'NotificationSettings', // 설정 > 알림
  Subscription: 'Subscription',       // 설정 > 구독 관리
  Withdraw: 'Withdraw',               // 설정 > 회원탈퇴
  // ---- 오류 안내 화면 (스토리보드 106~108) ----
  NetworkError: 'NetworkError',       // 네트워크 오류
  ServerError: 'ServerError',         // 서버 오류
  AnalysisFailed: 'AnalysisFailed',   // AI 분석 실패
  // ---- 홈의 구슬을 길게 눌러 밀었을 때 가는 화면들 (사이드 메뉴에는 없음) ----
  AgendaCompare: 'AgendaCompare', // 안건 비교
  Camera: 'Camera',               // 카메라
  QuickInput: 'QuickInput',       // 빠른 입력
};

// 사이드 메뉴에 보여줄 항목들.
// - route : 눌렀을 때 이동할 화면 이름
// - label : 메뉴에 실제로 보이는 글자
// 배열 순서가 곧 메뉴에 보이는 순서입니다. 항목을 추가/삭제/순서 변경하려면 여기만 고치세요.
export const MENU_ITEMS = [
  { route: ROUTES.Home, label: '홈' },
  { route: ROUTES.Search, label: '검색' },
  { route: ROUTES.Calendar, label: '캘린더' },
  { route: ROUTES.Ai, label: 'AI 채팅' },
  { route: ROUTES.Projects, label: '프로젝트' },
  { route: ROUTES.Memos, label: '메모' },
  { route: ROUTES.Tasks, label: '할 일 목록' },
  { route: ROUTES.Favorites, label: '즐겨찾기' },
  { route: ROUTES.Workspace, label: '워크스페이스 전환' },
  { route: ROUTES.Files, label: '파일 보관함' },
  { route: ROUTES.Backup, label: '백업 · 복원' },
  { route: ROUTES.Trash, label: '휴지통' },
  { route: ROUTES.Settings, label: '설정' },
];

// 홈의 구슬을 "길게 눌러서 밀었을 때" 나타나는 3개 항목.
// 배열 순서 = 화면에서 "왼쪽 → 위쪽 → 오른쪽" 순서입니다. (왼쪽부터 안건 비교, 카메라, 빠른 입력)
//   icon : 항목 위에 보이는 작은 그림 글자
export const QUICK_ACTIONS = [
  { route: ROUTES.AgendaCompare, label: '안건 비교', icon: '⇄' },
  { route: ROUTES.Camera, label: '카메라', icon: '📷' },
  { route: ROUTES.QuickInput, label: '빠른 입력', icon: '✏️' },
];
