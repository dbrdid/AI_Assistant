// ============================================================
// routes.js — "어떤 화면들이 있는지" 목록을 모아 둔 파일
// ============================================================

export const ROUTES = {
  Home: 'Home',
  AdvancedMemoEdit: 'AdvancedMemoEdit',
  AdvancedMemos: 'AdvancedMemos',
  LocalModel: 'LocalModel',
  AppCommand: 'AppCommand',
  Today: 'Today',
  Relations: 'Relations',           // 홈
  Search: 'Search',       // 검색
  Calendar: 'Calendar',   // 캘린더
  AiChat: 'AiChat',       // AI 채팅 (기기 기록과 첨부 파일로 묻고 답하기)
  Ai: 'Ai',               // 예전 'AI 채팅' 이름. 앱 명령 호환을 위해 AI 연결 화면으로 엽니다
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
  SpaceMembers: 'SpaceMembers', // 공유 공간 멤버 · 역할 · 만료 · 결제 주체 · 관리 기록
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

// 상단 영역과 그 안에서 이동할 화면을 표시 순서대로 정의합니다.
export const TABS = [
  { route: ROUTES.Home, label: '홈', icon: 'home', pages: [
    // 홈을 열면 첫 번째 쪽이 보임: 오늘(일정, 할 일, 메모와 녹음 입력줄)을 먼저, 문서 개요는 그다음
    { route: ROUTES.Today, label: '오늘' }, { route: ROUTES.Home, label: '개요' },
    { route: ROUTES.QuickInput, label: '빠른 입력' },
  ] },
  // 업무를 문서보다 앞에 둔다. 업무 탭을 누르면 캘린더가 먼저 보임 (할 일 목록은 두 번째 쪽)
  { route: ROUTES.Tasks, label: '업무', icon: 'checkSquare', pages: [
    { route: ROUTES.Calendar, label: '캘린더' }, { route: ROUTES.Tasks, label: '할 일' },
  ] },
  { route: ROUTES.Memos, label: '문서', icon: 'file', pages: [
    // 즐겨찾기는 문서 목록 안의 '즐겨찾기' 필터로 본다 (따로 쪽을 두지 않음)
    { route: ROUTES.Memos, label: '문서 목록' },
    { route: ROUTES.Files, label: '파일 보관함' },
  ] },
  // 문서와 할 일을 묶는 프로젝트는 매일 쓰는 단위라 상단에 둔다. 작업 검토·AI 연결·공유 공간·휴지통은 공간 메뉴로 옮겼다.
  { route: ROUTES.Projects, label: '프로젝트', icon: 'folder', pages: [
    { route: ROUTES.Projects, label: '프로젝트' },
  ] },
];
// 좌상단 작업 공간 메뉴: 공간 전환 아래에 두는 공간·AI·관리 항목
export const SPACE_TOOLS = [
  [ROUTES.Spaces, '공유 공간 관리', 'users', '공간'],
  [ROUTES.Proposals, '작업 검토', 'checkSquare', 'AI'],
  [ROUTES.LocalModel, 'AI 연결', 'sparkles', 'AI'],
  [ROUTES.Trash, '휴지통', 'trash', '관리'],
  [ROUTES.Backup, '백업 및 복원', 'cloud', '관리'],
  [ROUTES.Settings, '설정', 'settings', '관리'],
  [ROUTES.More, '모든 도구', 'grid', '관리'],
];
// '모든 도구' 화면: 모든 AI·도구·계정 항목에 직접 접근할 수 있게 유지한다.
export const MORE_SECTIONS = [
  {
    title: 'AI',
    items: [
      { route: ROUTES.AiChat, label: 'AI 채팅', icon: 'message' },
      { route: ROUTES.Proposals, label: '작업 검토', icon: 'sparkles' },
      { route: ROUTES.LocalModel, label: 'AI 연결', icon: 'sparkles' },
    ],
  },
  {
    title: '도구',
    items: [
      { route: ROUTES.Search, label: '검색', icon: 'search' },
      { route: ROUTES.Relations, label: '문서 관계', icon: 'link' },
      { route: ROUTES.AdvancedMemos, label: '가져오기와 내보내기', icon: 'arrowUp' },
      { route: ROUTES.AgendaCompare, label: '안건 비교', icon: 'compare' },
      { route: ROUTES.QuickInput, label: '사진, 문서 올리기', icon: 'arrowUp', params: { tab: 'file' } },
      { route: ROUTES.Favorites, label: '즐겨찾기', icon: 'star' },
      { route: ROUTES.Files, label: '파일 보관함', icon: 'paperclip' },
      { route: ROUTES.Trash, label: '휴지통', icon: 'trash' },
    ],
  },
  {
    title: '계정',
    items: [
      { route: ROUTES.Backup, label: '백업 및 복원', icon: 'cloud' },
      { route: ROUTES.Settings, label: '설정', icon: 'settings' },
    ],
  },
];

export const ROUTE_LABELS = {
  ...Object.fromEntries(SPACE_TOOLS.map(([route, label]) => [route, label])),
  ...Object.fromEntries([...TABS, ...MORE_SECTIONS.flatMap((s) => s.items)].map((i) => [i.route, i.label])),
  [ROUTES.More]: '모든 도구',
};
