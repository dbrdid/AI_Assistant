// ============================================================
// HomeScreen.js — 홈 화면
// ============================================================
// 이 화면에서 보이고 할 수 있는 것
//   0) 위쪽 요약 문구: 오늘 날짜 / "오늘의 주요 내용" / 안내 문구 / 일정·할 일 개수
//   1) ☰ 버튼 또는 "왼쪽 → 오른쪽으로 밀기" → 사이드 메뉴 열기
//   2) 가운데 ✦ 누르기 → AI 채팅 화면으로 이동
//   3) 아래 둥근 구슬
//        - 짧게 탭        → 녹음 시작 / 다시 탭하면 종료. 녹음 중에는 구슬 안에 깜빡이는 ● REC 아이콘이 보임
//        - 길게 누르기     → 구슬 주변에 3개 항목이 나타남. 손가락을 떼지 않고 밀면 구슬이 손가락을 따라 움직이고,
//                           원하는 항목 위에서 놓으면 이동 (왼쪽 안건 비교 · 위쪽 카메라 · 오른쪽 빠른 입력)
//        - 3개 항목 영역에 들어가지 않으면 슬라이드가 자동으로 끝남:
//            · 항목 밖에서 손을 떼면 → 취소 (메뉴가 닫히고 구슬이 제자리로 돌아옴)
//            · 손가락이 너무 멀리(SLIDE_LIMIT 밖) 벗어나면 → 그 즉시 자동으로 취소
//   4) 화면 맨 아래 손잡이를 "아래 → 위로 밀기" → 캘린더 시트가 중간까지 올라옴 (CalendarSheet.js)
//        더 끝까지 밀어 올리면 → 캘린더 화면으로 이동
//
// props
//   navigation : 화면 이동 도구 { navigate, goBack }. AppNavigator 가 넣어줍니다.
//   calendar   : 캘린더 상태 묶음. 시트에 그대로 전달합니다 (캘린더 화면과 같은 달/날짜를 공유)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import Bell from '../../notice/components/Bell';
import RecordSheet from '../../record/components/RecordSheet';
import { useRecorder } from '../../../services/device/Recorder';
import { addRecording } from '../../../data/files/FileStore';
import { addUsage } from '../../../data/settings/SettingsStore';
import CalendarSheet from '../../calendar/components/CalendarSheet';
import WorkspacePicker from '../../workspace/components/WorkspacePicker';
import { useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu'; // 밀어서 메뉴 열기
import { WEEKDAYS_LONG } from '../../calendar/utils/DateUtils';
import { QUICK_ACTIONS, ROUTES } from '../../../navigation/routes';
import { colors, font, spacing, FILL } from '../../../shared/theme/theme';
import { classify, useTasks } from '../../../data/tasks/TaskStore';
import { memoTitle, useMemos } from '../../../data/memos/MemoStore';
import { toKey } from '../../calendar/utils/DateUtils';
import { pendingOf, useProposals } from '../../../data/proposals/ProposalStore';

// ------------------------------------------------------------
// 오늘의 개수 (지금은 데이터 저장 기능이 없어서 0 으로 고정)
// ------------------------------------------------------------
// 나중에 일정/할 일 기능이 생기면 이 두 값만 실제 개수로 바꿔 주면 문구가 자동으로 바뀝니다.

// ------------------------------------------------------------
// 구슬 / 빠른 실행 메뉴의 크기와 위치 설정값
// ------------------------------------------------------------
const ORB = 100;               // 구슬 지름
const CALENDAR_GRAB = 45;      // 화면 맨 아래 캘린더 손잡이 높이 (CalendarSheet.js 의 GRAB_HEIGHT 와 같아야 함)
const CAPTION_AREA = 44;       // 구슬 아래 안내 글자 영역 높이
const LONG_PRESS_MS = 350;     // 이 시간(0.35초) 이상 누르고 있으면 "길게 누르기"
const MOVE_SLOP = 12;          // 길게 누르기 전에 이만큼(px) 이상 움직이면 "그냥 드래그"로 보고 취소
const OPTION_SIZE = 84;        // 항목(안건 비교 등) 하나의 크기
const HIT_RADIUS = 62;         // 손가락이 항목 중심에서 이 거리 안에 들어오면 "그 항목 위"로 판단
const SLIDE_LIMIT = 200;       // 구슬 중심에서 이 거리(px)보다 멀리 벗어나면 슬라이드 자동 종료 (3개 항목이 이 안에 들어옴)
const SLIDING_SCALE = 0.72;    // 슬라이드 중에는 구슬이 이 비율로 작아져서 밑의 항목이 가려지지 않음

// 항목 3개가 구슬 중심에서 얼마나 떨어져 있는지 (x: 오른쪽 +, y: 아래 +  → 위쪽은 음수)
// 순서는 routes.js 의 QUICK_ACTIONS 와 같습니다: [왼쪽 = 안건 비교, 위 = 카메라, 오른쪽 = 빠른 입력]
const OPTION_OFFSETS = [
  { x: -115, y: -45 },
  { x: 0, y: -120 },
  { x: 115, y: -45 },
];

// 초 → "01:05" 형태 글자
const formatTime = (sec) => {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
};

// 손가락 위치(구슬 중심 기준 x, y)에서 가장 가까운 항목 번호를 찾습니다. 어느 항목에도 안 가까우면 -1.
// (컴포넌트 밖에 둔 이유: 화면이 다시 그려져도 매번 새로 만들어지지 않는 "고정된 함수"여야
//  아래 PanResponder 의 의존성 목록에 넣을 필요가 없어서입니다)
function hitIndex(x, y) {
  let best = -1;
  let bestDist = HIT_RADIUS;
  OPTION_OFFSETS.forEach((o, i) => {
    const d = Math.hypot(x - o.x, y - o.y); // 두 점 사이 거리
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

export default function HomeScreen({ navigation, calendar }) {
  const menuSwipe = useSwipeToOpenMenu(); // "오른쪽으로 밀면 메뉴" 제스처
  const insets = useSafeAreaInsets();     // 노치/하단 바 크기
  const window = useWindowDimensions();

  // 화면(홈)의 실제 크기. 항목 위치 계산에 사용. 처음엔 창 크기로, 그린 뒤 정확한 값으로 갱신(onLayout)
  const [size, setSize] = useState({ w: window.width, h: window.height });

  // ---------- 상태들 ----------
  const [recording, setRecording] = useState(false); // 녹음 중인가
  const [seconds, setSeconds] = useState(0);         // 녹음 경과 시간(초)
  const [menuOpen, setMenuOpen] = useState(false);   // 구슬 주변 3개 항목이 펼쳐져 있나
  const [hover, setHover] = useState(-1);            // 손가락이 올라가 있는 항목 번호 (-1 = 없음)
  const [sliding, setSliding] = useState(false);     // 지금 손가락으로 구슬을 밀고 있나 (구슬이 따라다니는 중)

  // ---------- 녹음 타이머 ----------
  // recording 이 true 인 동안만 1초마다 seconds 를 1씩 올립니다.
  useEffect(() => {
    if (!recording) return undefined;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id); // 녹음이 끝나거나 화면이 사라지면 타이머 정리
  }, [recording]);

  // 녹음 중일 때 구슬이 살짝 커졌다 작아지는(숨 쉬는) 애니메이션
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!recording) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [recording, pulse]);

  // "● REC" 의 점이 깜빡이는 애니메이션 (녹음 중에만)
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!recording) {
      blink.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.2, duration: 550, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [recording, blink]);

  // 구슬이 손가락을 따라다니게 하는 값. { x, y } = 원래 자리에서 얼마나 떨어져 있는지
  const drag = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  // 슬라이드 중에는 구슬을 작게(SLIDING_SCALE), 아니면 원래 크기(1)로 부드럽게 바꿈
  const grabScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(grabScale, { toValue: sliding ? SLIDING_SCALE : 1, friction: 7, useNativeDriver: true }).start();
  }, [sliding, grabScale]);

  // 구슬 탭: 녹음 시작 ↔ 종료. 끝나면 파일 보관함에 저장하고 안내 창을 띄웁니다 (expo-audio)
  const rec = useRecorder();
  const [recSheet, setRecSheet] = useState(null); // 녹음이 끝난 뒤 뜨는 창 { state, uri, seconds, fileId }
  const recBusy = useRef(false); // 시작/종료 처리 중에 또 눌러도 무시
  const toggleRecording = async () => {
    if (recBusy.current) return;
    recBusy.current = true;
    try {
      await toggleRecordingInner();
    } finally {
      recBusy.current = false;
    }
  };
  const toggleRecordingInner = async () => {
    if (recording) {
      setRecording(false);
      const uri = await rec.stop();
      if (!uri) {
        setRecSheet({ state: 'error' });
        return;
      }
      const fileId = addRecording({ uri, seconds });
      addUsage('voice', Math.max(1, Math.ceil(seconds / 60))); // 녹음 이용량은 분 단위
      setRecSheet({ state: 'saved', uri, seconds, fileId });
    } else {
      const r = await rec.start();
      if (!r.ok) {
        setRecSheet({ state: r.reason === 'denied' ? 'denied' : 'error' });
        return;
      }
      setSeconds(0);
      setRecording(true);
    }
  };

  // ---------- 구슬 제스처 ----------
  // PanResponder 는 한 번만 만들어지므로, 최신 값(menuOpen 등)은 live ref 에 넣어 두고 거기서 읽습니다.
  const live = useRef({});
  live.current = {
    toggleRecording,
    menuOpen,
    go: (route) => navigation.navigate(route),
  };

  const timer = useRef(null);            // 길게 누르기 감지용 타이머
  const heldOpen = useRef(false);        // 이번 터치에서 "길게 눌러서" 슬라이드가 시작됐나
  const wasOpenAtStart = useRef(false);  // 터치를 시작할 때 이미 메뉴가 열려 있었나 (접근성 동작으로 연 경우)
  const moved = useRef(false);           // 손가락이 많이 움직였나 (탭과 드래그 구분)
  const ended = useRef(false);           // 슬라이드가 "자동 종료"됐나 (영역 밖으로 벗어남)
  const hoverRef = useRef(-1);           // hover 의 최신 값 (제스처 안에서 읽는 용도)
  const startOffset = useRef({ x: 0, y: 0 }); // 구슬 중심에서 처음 누른 지점까지의 거리

  // useCallback: 화면이 다시 그려져도 "같은 함수"를 유지 (제스처 코드가 오래된 함수를 붙잡지 않게 함)
  const setHoverBoth = useCallback((i) => {
    hoverRef.current = i;
    setHover(i);
  }, []);

  // 구슬을 원래 자리로 부드럽게 돌려보냄
  const springBack = useCallback(() => {
    Animated.spring(drag, { toValue: { x: 0, y: 0 }, friction: 7, tension: 80, useNativeDriver: true }).start();
  }, [drag]);

  // 슬라이드를 끝내는 공통 처리: 메뉴 닫기 + 강조 해제 + 구슬 제자리로
  const finishSlide = useCallback(() => {
    setMenuOpen(false);
    setSliding(false);
    setHoverBoth(-1);
    springBack();
  }, [setHoverBoth, springBack]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 구슬을 터치하면 이 제스처를 구슬이 처리한다고 선언
        onStartShouldSetPanResponder: () => true,
        // 다른 곳(부모)이 제스처를 빼앗아 가지 못하게 함. 밀어서 선택하는 동안 끊기지 않게.
        onPanResponderTerminationRequest: () => false,

        // 손가락을 댄 순간
        onPanResponderGrant: (e) => {
          // 구슬 안에서 어느 지점을 눌렀는지 (구슬 중심 기준). 값이 없으면 중심으로 간주.
          const ne = e.nativeEvent;
          const lx = Number.isFinite(ne.locationX) ? ne.locationX : ORB / 2;
          const ly = Number.isFinite(ne.locationY) ? ne.locationY : ORB / 2;
          startOffset.current = { x: lx - ORB / 2, y: ly - ORB / 2 };

          heldOpen.current = false;
          moved.current = false;
          ended.current = false;
          wasOpenAtStart.current = live.current.menuOpen;
          clearTimeout(timer.current);

          if (wasOpenAtStart.current) {
            // 이미 메뉴가 열려 있으면 바로 슬라이드 상태로
            setSliding(true);
          } else {
            // 0.35초 뒤에 "길게 누르기"로 보고 항목 3개를 펼치고 슬라이드 시작
            timer.current = setTimeout(() => {
              heldOpen.current = true;
              setMenuOpen(true);
              setSliding(true);
            }, LONG_PRESS_MS);
          }
        },

        // 손가락을 움직이는 동안
        onPanResponderMove: (_, g) => {
          if (ended.current) return; // 이미 자동 종료됐다면 손을 뗄 때까지 무시

          const dist = Math.hypot(g.dx, g.dy); // 처음 누른 곳에서 얼마나 움직였나
          const active = heldOpen.current || wasOpenAtStart.current; // 슬라이드 중인가

          if (!active) {
            // 길게 누르기 전에 많이 움직였다면 → 길게 누르기 취소 (그냥 드래그)
            if (dist > MOVE_SLOP) {
              moved.current = true;
              clearTimeout(timer.current);
            }
            return;
          }

          if (dist > MOVE_SLOP) moved.current = true;

          // 1) 구슬이 손가락을 따라가게: 움직인 만큼 구슬 위치를 바꿈
          drag.setValue({ x: g.dx, y: g.dy });

          // 2) 손가락이 어느 항목 위에 있는지 계산 (구슬 중심 기준 좌표)
          const rx = g.dx + startOffset.current.x;
          const ry = g.dy + startOffset.current.y;
          const idx = hitIndex(rx, ry);
          setHoverBoth(idx);

          // 3) 어느 항목에도 안 들어가고 + 너무 멀리 벗어났다 → 슬라이드 자동 종료
          if (idx < 0 && Math.hypot(rx, ry) > SLIDE_LIMIT) {
            ended.current = true;
            finishSlide();
          }
        },

        // 손가락을 뗀 순간
        onPanResponderRelease: () => {
          clearTimeout(timer.current);

          // 이미 자동 종료된 경우: 정리만 하고 끝
          if (ended.current) {
            ended.current = false;
            return;
          }

          if (heldOpen.current || wasOpenAtStart.current) {
            const i = hoverRef.current; // 손을 뗀 곳에 있던 항목
            finishSlide(); // 항목 위든 아니든 슬라이드는 여기서 끝남
            if (i >= 0) live.current.go(QUICK_ACTIONS[i].route); // 항목 위였다면 그 화면으로 이동
            // 항목 밖이었다면 → 아무 일 없이 취소됨 (구슬은 제자리로 돌아옴)
          } else if (!moved.current) {
            // 길게 누르기도, 드래그도 아닌 "짧은 탭" → 녹음 시작/종료
            live.current.toggleRecording();
          }
        },

        // 제스처가 도중에 끊기면 정리
        onPanResponderTerminate: () => {
          clearTimeout(timer.current);
          if (heldOpen.current || wasOpenAtStart.current) finishSlide();
        },
      }),
    [drag, finishSlide, setHoverBoth], // 모두 "바뀌지 않는 값/함수"라서 제스처는 처음에 한 번만 만들어집니다
  );

  // ---------- 화면에 보여줄 값 계산 ----------
  const now = new Date();
  // 공간 빠른 전환: 날짜 줄 오른쪽의 공간 이름을 누르면 아래에서 선택 창이 올라옴
  const { current: workspace } = useWorkspaces();
  const [wsOpen, setWsOpen] = useState(false);
  const [wsNotice, setWsNotice] = useState('');
  const wsTimer = useRef(null);
  useEffect(() => () => clearTimeout(wsTimer.current), []);
  const onSwitched = (name) => {
    setWsNotice(`「${name}」로 전환했어요`);
    clearTimeout(wsTimer.current);
    wsTimer.current = setTimeout(() => setWsNotice(''), 2200);
  };

  // 실제 일정 데이터에서 오늘 일정 수 / 남은 할 일 수 계산
  const allTasks = useTasks();
  const proposalCount = pendingOf(useProposals()).filter((p) => p.status === 'pending').length;
  const nowKey = toKey(now);
  const todayCount = allTasks.filter((t) => t.date === nowKey).length;
  const remainingCount = allTasks.filter((t) => classify(t, nowKey) !== 'done').length;
  // 오늘의 주요 내용: 우선순위대로 하나만 보여줌
  //   1) 오늘 남은 일정 중 가장 빠른 것  2) 시간 없는 오늘 할 일  3) 기한 지난 할 일  4) 최근 메모  5) 기본 문구
  const memos = useMemos();
  const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const pending = allTasks.filter((t) => t.status !== '완료');
  const todayPending = pending.filter((t) => t.date === nowKey);
  const nextTimed = todayPending.filter((t) => t.start && (t.end || t.start) >= nowHM)[0];
  const untimed = todayPending.filter((t) => !t.start)[0];
  const overdueList = pending.filter((t) => classify(t, nowKey) === 'overdue');
  let highlight = { text: '잠깐 기록하고, 필요할 때 다시 찾아보세요.', go: null };
  if (nextTimed) {
    highlight = { text: `다음 일정 · ${nextTimed.start} ${nextTimed.title}`, go: [ROUTES.TaskEdit, { taskId: nextTimed.id }] };
  } else if (untimed) {
    highlight = { text: `오늘 할 일 · ${untimed.title}`, go: [ROUTES.TaskEdit, { taskId: untimed.id }] };
  } else if (overdueList.length > 0) {
    highlight = { text: `기한이 지난 할 일이 ${overdueList.length}개 있어요`, go: [ROUTES.Tasks] };
  } else if (memos.length > 0) {
    const recent = memos.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
    highlight = { text: `최근 메모 · ${memoTitle(recent)}`, go: [ROUTES.MemoEdit, { memoId: recent.id }] };
  }
  const dateText = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS_LONG[now.getDay()]}`;

  // 구슬의 아래 여백: 하단 안전영역 + 캘린더 손잡이 + 안내 글자 영역
  const orbBottom = insets.bottom + CALENDAR_GRAB + CAPTION_AREA;
  // 구슬 중심의 화면 좌표 (항목들을 이 점을 기준으로 배치)
  const cx = size.w / 2;
  const cy = size.h - orbBottom - ORB / 2;

  // 구슬 아래 안내 글자: 상태에 따라 바뀜
  let caption = '눌러서 녹음 · 길게 눌러 메뉴';
  if (menuOpen) {
    caption = hover >= 0 ? `${QUICK_ACTIONS[hover].label} · 놓으면 열기` : '항목으로 밀어 보세요 · 밖에서 놓으면 취소';
  } else if (recording) {
    caption = `녹음 중 ${formatTime(seconds)} · 눌러서 종료`;
  }

  return (
    // 바깥 View: 홈 화면 전체. onLayout 으로 실제 크기를 알아냄
    <View
      style={styles.root}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {/* 안쪽 View: 헤더 + 요약 + 본문. 여기에만 "오른쪽으로 밀기" 제스처를 연결합니다.
          (구슬과 캘린더 시트는 이 View 의 "바깥"에 두어서 서로 제스처가 방해하지 않게 함) */}
      <View style={styles.content} {...menuSwipe}>
        <ScreenHeader title="오늘의 플래너" right={<Bell onPress={() => navigation.navigate(ROUTES.Notices)} />} />

        {/* ---------- 요약 문구 블록 (왼쪽 정렬) ---------- */}
        <View style={styles.summary}>
          <View style={styles.dateRow}>
            <Text style={styles.date}>{dateText}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`현재 공간 ${workspace.name}, 눌러서 공간 전환`}
              onPress={() => setWsOpen(true)}
              hitSlop={8}
              style={styles.wsChip}
            >
              <Text style={styles.wsChipText} numberOfLines={1}>{workspace.name} ▾</Text>
            </Pressable>
          </View>
          <Text style={styles.heading} accessibilityRole="header">오늘의 주요 내용</Text>
          <Pressable
            accessibilityRole={highlight.go ? 'button' : 'text'}
            disabled={!highlight.go}
            onPress={() => highlight.go && navigation.navigate(...highlight.go)}
            hitSlop={8}
          >
            <Text style={styles.desc} numberOfLines={2}>{highlight.text}</Text>
          </Pressable>
          {/* ↗ 는 디자인 시안의 화살표 표시입니다(지금은 누르는 기능 없음) */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="오늘의 브리핑 보기"
            onPress={() => navigation.navigate(ROUTES.Briefing)}
            hitSlop={8}
          >
            <Text style={styles.counts}>
              일정 {todayCount}개 · 남은 할 일 {remainingCount}개 ↗
            </Text>
          </Pressable>
          {proposalCount > 0 && (
            <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.Proposals)} hitSlop={8} style={styles.aiChip}>
              <Text style={styles.aiChipText}>✦ 확인할 AI 제안 {proposalCount}건</Text>
            </Pressable>
          )}
        </View>

        {/* ---------- 본문: 남은 공간의 가운데에 작은 ✦ (누르면 AI 채팅) ---------- */}
        <View style={styles.body}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="AI 채팅으로 이동"
            onPress={() => navigation.navigate(ROUTES.Ai)}
            hitSlop={16}
            style={({ pressed }) => [styles.sparkle, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.sparkleIcon}>✦</Text>
          </Pressable>
        </View>
      </View>

      <RecordSheet sheet={recSheet} onClose={() => setRecSheet(null)} onOpenFiles={() => { setRecSheet(null); navigation.navigate(ROUTES.Files); }} />
      <WorkspacePicker visible={wsOpen} onClose={() => setWsOpen(false)} navigation={navigation} onSwitched={onSwitched} />
      {!!wsNotice && (
        <View pointerEvents="none" style={styles.wsNotice}>
          <Text style={styles.wsNoticeText}>{wsNotice}</Text>
        </View>
      )}

      {/* ---------- 구슬을 길게 눌렀을 때 펼쳐지는 3개 항목 ---------- */}
      {menuOpen && (
        <View style={FILL} pointerEvents="box-none">
          {/* 배경: 누르면 메뉴 닫기 */}
          <Pressable
            style={[FILL, styles.menuBackdrop]}
            onPress={() => {
              setMenuOpen(false);
              setHoverBoth(-1);
            }}
            accessibilityLabel="빠른 메뉴 닫기"
          />

          {/* 항목 사이를 나누는 두 개의 얇은 선 (시안의 / \ 모양) */}
          <View pointerEvents="none" style={[styles.divider, { left: cx - 60, top: cy - 86 - 45, transform: [{ rotate: '-35deg' }] }]} />
          <View pointerEvents="none" style={[styles.divider, { left: cx + 60, top: cy - 86 - 45, transform: [{ rotate: '35deg' }] }]} />

          {/* 항목 3개: routes.js 의 QUICK_ACTIONS 순서대로 왼쪽, 위, 오른쪽에 배치 */}
          {QUICK_ACTIONS.map((a, i) => (
            <Pressable
              key={a.route}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              onPress={() => {
                // 손가락 슬라이드 대신 "직접 탭"으로도 선택 가능
                setMenuOpen(false);
                setHoverBoth(-1);
                navigation.navigate(a.route);
              }}
              style={[
                styles.option,
                {
                  left: cx + OPTION_OFFSETS[i].x - OPTION_SIZE / 2,
                  top: cy + OPTION_OFFSETS[i].y - OPTION_SIZE / 2,
                },
                hover === i && styles.optionHover, // 손가락이 올라가 있으면 강조
              ]}
            >
              <Text style={styles.optionIcon}>{a.icon}</Text>
              <Text style={styles.optionLabel}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* ---------- 둥근 구슬 ---------- */}
      {/* 바깥 View 가 터치를 받습니다. 안쪽 요소들은 pointerEvents="none" 으로 터치를 통과시켜,
          "구슬 안에서 어디를 눌렀는지"를 정확히 알 수 있게 합니다. */}
      <View
        {...pan.panHandlers}
        accessible
        accessibilityRole="button"
        accessibilityLabel={recording ? '녹음 종료' : '녹음 시작'}
        accessibilityHint="길게 누르면 안건 비교, 카메라, 빠른 입력 메뉴가 열립니다"
        accessibilityActions={[{ name: 'activate' }, { name: 'longpress', label: '빠른 메뉴 열기' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'longpress') setMenuOpen(true);
          else toggleRecording();
        }}
        style={[styles.orbTouch, { left: cx - ORB / 2, bottom: orbBottom }]}
      >
        {/* 구슬 본체. transform 4개:
              translateX/Y = 슬라이드 중 손가락을 따라 이동,  scale(pulse) = 녹음 중 숨 쉬기,
              scale(grabScale) = 슬라이드 중 작아지기 */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.orb,
            recording && styles.orbRecording,
            {
              transform: [
                { translateX: drag.x },
                { translateY: drag.y },
                { scale: pulse },
                { scale: grabScale },
              ],
            },
          ]}
        >
          {/* 구슬의 입체감: 밝은 부분(왼쪽 위)과 어두운 부분(오른쪽)을 겹쳐 그라데이션처럼 보이게 함 */}
          <View style={styles.orbLight} />
          <View style={styles.orbShade} />

          {/* 녹음 중 아이콘: 깜빡이는 코랄색 점 + REC 글자 */}
          {recording && (
            <View style={styles.recBadge}>
              <Animated.View style={[styles.recDot, { opacity: blink }]} />
              <Text style={styles.recText}>REC</Text>
            </View>
          )}
        </Animated.View>
      </View>

      {/* 구슬 아래 안내 글자 (상태에 따라 바뀜) */}
      <Text pointerEvents="none" style={[styles.caption, { bottom: insets.bottom + CALENDAR_GRAB + 10 }]}>
        {caption}
      </Text>

      {/* 캘린더 시트: 화면 맨 아래에 손잡이가 보이고, 위로 끌면 올라옴 (구슬보다 위에 겹쳐 그려짐).
          onReachTop: 끝까지 올렸을 때 캘린더 화면으로 이동 */}
      <CalendarSheet
        calendar={calendar}
        onReachTop={() => navigation.navigate(ROUTES.Calendar)}
        onAddTask={(date) => navigation.navigate(ROUTES.TaskEdit, { date })}
        onEditTask={(taskId) => navigation.navigate(ROUTES.TaskEdit, { taskId })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  wsChip: { maxWidth: 160, minHeight: 30, paddingHorizontal: spacing.md, borderRadius: 15, borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.mintSoft, justifyContent: 'center' },
  wsChipText: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
  wsNotice: { position: 'absolute', top: 96, alignSelf: 'center', backgroundColor: colors.ink, borderRadius: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  wsNoticeText: { color: colors.white, fontSize: font.body },
  root: { flex: 1, backgroundColor: colors.cream },
  content: { flex: 1 },

  // 요약 블록
  summary: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.sm },
  date: { fontSize: font.body, color: colors.muted },
  heading: { fontSize: font.headline, fontWeight: '500', color: colors.ink, marginTop: spacing.xs },
  desc: { fontSize: font.bodyLg, color: colors.muted, lineHeight: 24 },
  counts: { fontSize: font.body, color: colors.ink, marginTop: spacing.xs },
  aiChip: { alignSelf: 'flex-start', marginTop: spacing.sm, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.mintDark },
  aiChipText: { color: colors.white, fontSize: font.body, fontWeight: '800' },

  // 본문: 요약 아래 남은 공간의 가운데
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // 작은 ✦ : 누르는 영역은 64x64, 글자는 34
  sparkle: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  sparkleIcon: { fontSize: 34, color: colors.ink },

  // ----- 구슬 -----
  // 터치를 받는 바깥 영역: 화면 아래쪽에 절대 위치(position absolute)로 띄움
  orbTouch: { position: 'absolute', width: ORB, height: ORB },
  orb: {
    width: ORB,
    height: ORB,
    borderRadius: ORB / 2,
    backgroundColor: '#D3D4E1', // 은은한 은빛 라벤더
    overflow: 'hidden',          // 안쪽 밝은/어두운 부분이 원 밖으로 안 나오게 자름
    borderWidth: 3,
    borderColor: 'transparent',
  },
  orbRecording: { borderColor: colors.coral }, // 녹음 중에는 코랄색 테두리
  // 녹음 중 아이콘: 구슬 가운데에 점 + 글자를 세로로 배치
  recBadge: { ...FILL, alignItems: 'center', justifyContent: 'center', gap: 4 },
  recDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.coral },
  recText: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: colors.coral },
  orbLight: {
    position: 'absolute',
    width: ORB * 0.9,
    height: ORB * 0.9,
    borderRadius: ORB,
    left: -ORB * 0.25,
    top: -ORB * 0.25,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  orbShade: {
    position: 'absolute',
    width: ORB * 0.8,
    height: ORB * 1.4,
    borderRadius: ORB,
    right: -ORB * 0.4,
    top: -ORB * 0.2,
    backgroundColor: 'rgba(120,120,155,0.35)',
  },
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: font.caption,
    color: colors.ink,
  },

  // ----- 펼쳐진 항목 -----
  menuBackdrop: { backgroundColor: 'rgba(255,253,248,0.88)' },
  divider: { position: 'absolute', width: 1, height: 90, backgroundColor: colors.line },
  option: {
    position: 'absolute',
    width: OPTION_SIZE,
    height: OPTION_SIZE,
    borderRadius: OPTION_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  optionHover: { backgroundColor: 'rgba(150,155,190,0.4)' }, // 손가락이 올라가 있을 때
  optionIcon: { fontSize: 22, color: colors.ink },
  optionLabel: { fontSize: font.caption, color: colors.ink },
});
