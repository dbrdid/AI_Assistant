// CalendarSheet.js — 아래에서 위로 끌어올리는 캘린더 시트 (홈 화면 + 캘린더 화면 공용)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { colors, font, spacing, FILL } from '../../../shared/theme/theme';
import MonthCalendar from './MonthCalendar';
import DayAgenda from './DayAgenda';
import CalendarSearch from './CalendarSearch';
import { formatLunar, toKey, fromKey } from '../utils/DateUtils';
import { getHolidays } from '../utils/Holidays';
import { classify, searchTasks, useTasks } from '../../../data/tasks/TaskStore';

const GRAB_HEIGHT = 45;  // 닫혀 있을 때 화면 맨 아래에 보이는 "손잡이 영역"의 높이
const HALF_VISIBLE = 560; // "중간" 단계에서 화면에 보이는 시트 높이 (달력 한 달이 들어갈 정도)
const FLING_MS = 150;    // 손을 뗄 때의 속도로 "150ms 뒤 위치"를 미리 계산 → 휙 던지면 더 멀리 가게 함

export default function CalendarSheet({ calendar, startFull = false, onReachTop, onClose, onAddTask, onEditTask }) {
  // ---------- 1) 크기 계산 ----------
  const windowH = useWindowDimensions().height; // 기기가 알려 주는 화면 높이 (폰에 따라 실제 그려지는 영역과 다를 수 있음)
  const [parentH, setParentH] = useState(0);      // 시트가 놓인 곳의 "실제로 그려지는 높이" (아래 probe View 로 잼)
  const height = parentH || windowH;             // 잰 값이 있으면 그것을 우선 사용 → 폰에서 위쪽이 잘려 올라가던 문제 방지
  const insets = useSafeAreaInsets();         // 노치/하단 홈 바 같은 "가려지는 영역" 크기

  // 시트 전체 높이: 화면 높이에서 위쪽 안전영역을 뺀 만큼 (상단바 아래까지 올라오게)
  const sheetHeight = height - insets.top - spacing.sm;
  // 닫혔을 때 아래로 내려가 있는 거리: 손잡이(+하단 안전영역)만 남기고 전부 내림
  const closedY = sheetHeight - GRAB_HEIGHT - insets.bottom;
  // 중간 단계에서 내려가 있는 거리: 화면에 HALF_VISIBLE 만큼 보이도록 (작은 화면이면 조금 줄임)
  const halfVisible = Math.min(sheetHeight - 50, HALF_VISIBLE + insets.bottom);
  const halfY = sheetHeight - halfVisible;

  // ---------- 2) 위치 값 만들기 ----------
  const startY = startFull ? 0 : closedY; // 처음 위치: 캘린더 화면이면 끝까지, 홈이면 닫힘
  // Animated.Value: 값이 바뀌면 화면이 부드럽게 따라 움직이는 특별한 숫자
  const y = useRef(new Animated.Value(startY)).current;
  // yRef: y 의 "현재 값"을 일반 변수처럼 읽기 위해 따로 보관 (Animated.Value 는 값을 바로 못 읽어서)
  const yRef = useRef(startY);
  // level: 지금 어느 단계인가 ('closed' | 'half' | 'full'). 안내 글자와 터치 처리에 사용
  const [level, setLevel] = useState(startFull ? 'full' : 'closed');

  // 실제 높이를 잰 뒤(또는 화면이 회전/크기 변경된 뒤) 현재 단계 위치로 다시 맞춤 (끌고 있는 중이면 건드리지 않음)
  const dragging = useRef(false);
  useEffect(() => {
    if (dragging.current) return;
    y.stopAnimation();
    y.setValue(level === 'full' ? 0 : level === 'half' ? halfY : closedY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetHeight]);

  // y 가 바뀔 때마다 yRef 에도 복사해 둡니다.
  useEffect(() => {
    const id = y.addListener(({ value }) => {
      yRef.current = value;
    });
    return () => y.removeListener(id); // 컴포넌트가 사라질 때 정리
  }, [y]);

  // latest: 제스처 처리 함수(PanResponder)는 한 번만 만들어지기 때문에,
  // 그 안에서 "최신 값들" 을 읽을 수 있게 ref 에 넣어 둡니다. (매 렌더링마다 갱신)
  const latest = useRef({});

  // snapTo('full' | 'half' | 'closed') : 해당 단계로 부드럽게 이동
  const snapTo = useCallback(
    (name) => {
      const L = latest.current;
      const target = name === 'full' ? 0 : name === 'half' ? L.halfY : L.closedY;
      setLevel(name);
      Animated.timing(y, {
        toValue: target,
        duration: 240,          // 0.24초 동안
        useNativeDriver: false, // JS 로 계산 (이 값은 레이아웃 위치라서 false)
      }).start(({ finished }) => {
        if (!finished) return; // 도중에 다시 잡아서 끊긴 경우는 무시

        // (A) 홈 모드에서 "끝까지" 올렸다 → 캘린더 화면으로 이동.
        if (name === 'full' && !L.startFull && L.onReachTop) {
          L.onReachTop();
          y.setValue(L.closedY);
          setLevel('closed');
        }
        // (B) 캘린더 화면 모드에서 "닫힘" 까지 내렸다 → 이전 화면으로 돌아감
        else if (name === 'closed' && L.startFull && L.onClose) {
          L.onClose();
        }
      });
    },
    [y],
  );
  latest.current = { closedY, halfY, startFull, onReachTop, onClose, level, snapTo };

  // ---------- 3) 손가락 끌기(제스처) 처리 ----------
  // PanResponder: "손가락이 눌리고, 움직이고, 떼어지는" 과정을 감지하는 도구
  const pan = useMemo(() => {
    let downY = 0; // 손가락을 댄 순간의 시트 위치
    return PanResponder.create({
      // 손잡이를 터치하면 이 제스처를 내가 처리하겠다고 선언
      onStartShouldSetPanResponder: () => true,

      // 손가락을 댄 순간: 진행 중이던 애니메이션을 멈추고 현재 위치를 기억
      onPanResponderGrant: () => {
        dragging.current = true;
        y.stopAnimation();
        downY = yRef.current;
      },

      // 손가락을 움직이는 동안: 움직인 만큼(g.dy) 시트를 따라 움직임.
      // g.dy 는 위로 움직이면 음수, 아래로 움직이면 양수.
      // 0(끝까지) ~ closedY(닫힘) 범위를 벗어나지 않게 제한합니다.
      onPanResponderMove: (_, g) => {
        const next = Math.min(Math.max(downY + g.dy, 0), latest.current.closedY);
        y.setValue(next);
      },

      // 제스처가 도중에 끊긴 경우(다른 곳이 가져감)에도 끌기 상태를 풀어 줌
      onPanResponderTerminate: () => {
        dragging.current = false;
      },

      // 손가락을 뗀 순간: 어느 단계로 갈지 결정
      onPanResponderRelease: (_, g) => {
        dragging.current = false;
        const L = latest.current;

        // (a) 거의 안 움직였다 = 그냥 "탭" → 닫혀 있으면 열고(홈: 중간 / 캘린더 화면: 끝까지), 열려 있으면 닫기
        if (Math.abs(g.dy) < 6 && Math.abs(g.vy) < 0.2) {
          if (L.level === 'closed') L.snapTo(L.startFull ? 'full' : 'half');
          else L.snapTo('closed');
          return;
        }

        // (b) 끌었다 → "손을 뗀 위치 + 속도로 조금 더 나아간 위치" 에서 가장 가까운 단계로 이동
        //     (g.vy 는 위로 빠르게 움직이면 큰 음수 → 더 위쪽 단계가 선택됨)
        const projected = yRef.current + g.vy * FLING_MS;
        const yOf = { full: 0, half: L.halfY, closed: L.closedY };
        const names = L.startFull ? ['full', 'closed'] : ['full', 'half', 'closed']; // 캘린더 화면에는 "중간" 단계 없음
        let best = names[0];
        names.forEach((n) => {
          if (Math.abs(yOf[n] - projected) < Math.abs(yOf[best] - projected)) best = n;
        });
        L.snapTo(best);
      },
    });
  }, [y]);

  // ---------- 4) 안드로이드 뒤로가기 버튼 ----------
  // 시트가 열려 있을 때만: 뒤로가기를 누르면 시트를 닫음 (캘린더 화면 모드에서는 닫으면서 이전 화면으로 이동)
  useEffect(() => {
    if (level === 'closed') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      snapTo('closed');
      return true; // true = "내가 처리했으니 기본 동작은 하지 마"
    });
    return () => sub.remove();
  }, [level, snapTo]);

  // ---------- 5) 달력 상태 ----------
  // 어느 달을 보고 있나 / 어느 날짜를 선택했나는 부모(AppNavigator)가 들고 있습니다.
  // 그래서 홈 시트와 캘린더 화면이 같은 상태를 공유합니다.
  const { today, cursor, selected, setSelected, shiftMonth, goToday, goToDate } = calendar;

  // 일정 데이터, 공휴일, 달력 점 표시, 검색
  const tasks = useTasks();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const todayKey = toKey(today);
  const holidays = useMemo(() => getHolidays(cursor.year), [cursor.year]);
  const selectedKey = toKey(selected);
  const marks = useMemo(() => {
    const m = {};
    tasks.forEach((t) => {
      const c = classify(t, todayKey);
      const e = m[t.date] || (m[t.date] = { n: 0, overdue: false, allDone: true });
      e.n += 1;
      if (c === 'overdue') e.overdue = true;
      if (c !== 'done') e.allDone = false;
    });
    return m;
  }, [tasks, todayKey]);
  const matches = useMemo(() => (searching ? searchTasks(tasks, query) : []), [searching, tasks, query]);
  const highlight = useMemo(() => new Set(matches.map((t) => t.date)), [matches]);
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };

  // ---------- 6) 화면 그리기 ----------
  // 시트가 올라올수록 뒤 배경이 어두워지게: y 가 closedY → 0 으로 갈 때 투명도 0 → 0.35
  const backdropOpacity = y.interpolate({
    inputRange: [0, closedY],
    outputRange: [0.35, 0],
    extrapolate: 'clamp', // 범위 밖 값은 끝값으로 고정
  });

  // 단계별 손잡이 안내 글자
  const hint =
    level === 'closed'
      ? '↑ 위로 밀어 캘린더 보기'
      : level === 'half'
        ? '↑ 끝까지 밀면 전체 화면 · ↓ 밀어서 닫기'
        : '캘린더 · 아래로 밀어 닫기';

  return (
    <>
      {/* 크기 재기용 투명 View: 시트가 놓인 영역과 같은 크기라서, 여기서 잰 높이가 실제 그려지는 높이 */}
      <View pointerEvents="none" style={FILL} onLayout={(e) => setParentH(Math.round(e.nativeEvent.layout.height))} />
      {/* (a) 어두운 배경. 열려 있을 때만 터치를 받고, 누르면 시트를 닫음.
             닫혀 있을 땐 pointerEvents="none" 이라 아래 화면 터치를 막지 않음 */}
      <Animated.View
        pointerEvents={level !== 'closed' ? 'auto' : 'none'}
        style={[FILL, { backgroundColor: colors.ink, opacity: backdropOpacity }]}
      >
        <Pressable style={FILL} onPress={() => snapTo('closed')} accessibilityLabel="캘린더 닫기" />
      </Animated.View>

      {/* (b) 시트 본체. translateY: y 만큼 아래로 내려서 그려라 (y=0 이면 완전히 올라온 상태) */}
      <Animated.View style={[styles.sheet, { height: sheetHeight, transform: [{ translateY: y }] }]}>
        {/* 손잡이: 여기에 손가락 제스처(pan.panHandlers)를 연결 */}
        <View
          {...pan.panHandlers}
          accessible
          accessibilityRole="button"
          accessibilityLabel={level === 'closed' ? '캘린더 열기' : '캘린더 닫기'}
          accessibilityActions={[{ name: 'activate' }]}
          onAccessibilityAction={() => (level === 'closed' ? snapTo(startFull ? 'full' : 'half') : snapTo('closed'))}
          style={styles.grab}
        >
          <View style={styles.bar} />
          <Text style={styles.grabText}>{hint}</Text>
        </View>

        {/* 달력 본문 (아래 안전영역만큼 띄움) */}
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>
          <MonthCalendar
            year={cursor.year}
            month={cursor.month}
            selected={selected}
            today={today}
            onSelect={setSelected}
            onPrev={() => shiftMonth(-1)}
            onNext={() => shiftMonth(1)}
            onToday={goToday}
            marks={marks}
            holidays={holidays}
            highlight={searching ? highlight : undefined}
            searching={searching}
            onSearch={() => (searching ? closeSearch() : setSearching(true))}
            onPickMonth={(yy, mm) => goToDate(new Date(yy, mm, 1))}
          >
            {searching ? (
              <CalendarSearch
                query={query}
                onChange={setQuery}
                matches={matches}
                onPick={(t) => goToDate(fromKey(t.date))}
                onClose={closeSearch}
              />
            ) : (
              <DayAgenda
                selected={selected}
                tasks={tasks}
                holidayName={holidays[selectedKey]}
                lunarText={formatLunar(selected)}
                onAdd={(k) => onAddTask && onAddTask(k)}
                onEdit={(id) => onEditTask && onEditTask(id)}
              />
            )}
          </MonthCalendar>
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  // 시트 본체: 화면 맨 아래에 붙여 두고(position absolute + bottom 0) 위쪽 모서리를 둥글게
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.cream,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    // 그림자 (iOS 는 shadow*, 안드로이드는 elevation)
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -3 },
    elevation: 12,
  },
  grab: { height: GRAB_HEIGHT, alignItems: 'center', justifyContent: 'center', gap: 6 },
  bar: { width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line },
  grabText: { fontSize: font.caption, color: colors.muted, fontWeight: '600' },
});