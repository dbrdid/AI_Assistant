// ============================================================
// routes.js — "어떤 화면들이 있는지" 목록을 모아 둔 파일
// ============================================================

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
  More: 'More',           // '나' (홈 왼쪽 위 프로필): AI · 도구 · 설정 모음
  Spaces: 'Spaces',       // 하단 탭 '공간': 공간(팀) 목록
  SpaceHome: 'SpaceHome', // 공간 하나의 홈 (멤버 · 초대 · 프로젝트 · 일정 · 메모)
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

// 하단 탭. 배열 순서 = 화면 왼쪽부터. icon 은 shared/components/Icon.js 이름
//   오늘·캘린더·할 일·메모 = 모든 공간을 합친 "나" 보기 · 공간 = 공간(팀)별 홈
export const TABS = [
  { route: ROUTES.Home, label: '오늘', icon: 'home' },
  { route: ROUTES.Calendar, label: '캘린더', icon: 'calendar' },
  { route: ROUTES.Tasks, label: '할 일', icon: 'checkSquare' },
  { route: ROUTES.Memos, label: '메모', icon: 'file' },
  { route: ROUTES.Spaces, label: '공간', icon: 'users' },
];

// '나' 화면(홈 왼쪽 위 프로필)의 목록. 묶음(section)마다 한 카드로 보입니다
export const MORE_SECTIONS = [
  {
    title: 'AI',
    items: [
      { route: ROUTES.Proposals, label: 'AI 제안 확인', icon: 'sparkles' },
      { route: ROUTES.Ai, label: 'AI 채팅', icon: 'message' },
    ],
  },
  {
    title: '도구',
    items: [
      { route: ROUTES.Search, label: '검색', icon: 'search' },
      { route: ROUTES.AgendaCompare, label: '안건 비교', icon: 'compare' },
      { route: ROUTES.QuickInput, label: '사진 · 문서 올리기', icon: 'arrowUp', params: { tab: 'file' } },
      { route: ROUTES.Favorites, label: '즐겨찾기', icon: 'star' },
      { route: ROUTES.Files, label: '파일 보관함', icon: 'paperclip' },
      { route: ROUTES.Trash, label: '휴지통', icon: 'trash' },
    ],
  },
  {
    title: '계정',
    items: [
      { route: ROUTES.Backup, label: '백업 · 복원', icon: 'cloud' },
      { route: ROUTES.Settings, label: '설정', icon: 'settings' },
    ],
  },
];

export const ROUTE_LABELS = { ...Object.fromEntries([...TABS, ...MORE_SECTIONS.flatMap((s) => s.items)].map((i) => [i.route, i.label])), [ROUTES.More]: '나' };
