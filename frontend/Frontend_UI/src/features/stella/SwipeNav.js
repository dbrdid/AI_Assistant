// 탭 화면을 감싸는 좌우 제스처.
// 좌우로 밀기: 같은 탭 안의 쪽 이동. 길게 누른 채 좌우로 밀기: 민 쪽 가장자리에서 세로 탭 막대가 나오고,
// 손가락을 위아래로 옮겨 탭을 고른 뒤 떼면 이동한다. 위쪽 탭 버튼은 그대로 있다(같은 기능의 버튼).
import React, { useRef, useState } from 'react';
import { Animated, PanResponder, Text, View, useWindowDimensions } from 'react-native';
import Icon from '../../shared/components/Icon';
import { HOLD_MS, pageStep, relativePick, swipeIntent } from './swipeIntent.mjs';
import { palette as c } from './theme';

const ROW = 56;

export default function SwipeNav({ tabs, current, onTab, onPage, children }) {
  const touch = useRef(null);       // { t, x, y, movedEarly }
  const mode = useRef(null);        // 'page' | 'tabs'
  const view = useRef(null);
  const latest = useRef({}); latest.current = { tabs, current, onTab, onPage };
  const [bar, setBar] = useState(null); // { side, pick }
  const slide = useRef(new Animated.Value(0)).current;
  const barRef = useRef(null); barRef.current = bar; // 놓을 때 최신 막대 상태
  // 길게 눌러 메뉴를 열 준비가 되면 손가락 반대쪽 가장자리에 메뉴를 살짝 보여 준다
  const { width } = useWindowDimensions();
  const [peek, setPeek] = useState(null); // 'left' | 'right'
  const peekTimer = useRef(null);
  const stopPeek = () => { clearTimeout(peekTimer.current); setPeek(null); };

  const anchor = useRef({ y: 0, start: 0 }); // 처음 좌우로 민 높이와 그때의 탭
  const pickAt = (pageY) => {
    const r = relativePick({ anchor: anchor.current.y, y: pageY, start: anchor.current.start, count: latest.current.tabs.length, row: ROW });
    anchor.current.y = r.anchor;
    return r.pick;
  };
  const decide = (g) => {
    const s = touch.current;
    if (!s || mode.current) return !!mode.current;
    const intent = swipeIntent({ heldMs: Date.now() - s.t, movedEarly: s.movedEarly, dx: g.dx, dy: g.dy });
    if (!intent) return false;
    mode.current = intent;
    if (intent === 'tabs') {
      const { tabs: all, current: here } = latest.current;
      anchor.current = { y: g.moveY, start: Math.max(0, all.findIndex(tab => tab.route === here)) };
      stopPeek();
      setBar({ side: touch.current.x < width / 2 ? 'right' : 'left', dir: Math.sign(g.dx), pick: pickAt(g.moveY) }); // 살짝 보이던 쪽(손가락 반대쪽)에 연다
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    }
    return true;
  };
  const end = (g) => {
    if (mode.current === 'page') latest.current.onPage(pageStep(g.dx));
    if (mode.current === 'tabs' && !barRef.current?.hidden) { const i = pickAt(g.moveY); if (i >= 0) latest.current.onTab(latest.current.tabs[i].route); }
    mode.current = null; touch.current = null; setBar(null); stopPeek();
  };
  const pan = useRef(PanResponder.create({
    // 길게 누른 뒤의 밀기는 안쪽(목록, 버튼)보다 먼저 가져온다. 그냥 밀기는 안쪽 가로 스크롤에 양보한다.
    onMoveShouldSetPanResponderCapture: (_, g) => { const s = touch.current; return !!s && Date.now() - s.t >= HOLD_MS && !s.movedEarly && decide(g); },
    onMoveShouldSetPanResponder: (_, g) => decide(g),
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_, g) => {
      if (mode.current !== 'tabs') return;
      // 연 방향의 반대로 시작점을 넘겨 밀면 막대를 다시 넣고, 다시 연 방향으로 밀면 꺼낸다 (넣은 채 떼면 취소)
      setBar(b => {
        if (!b) return b;
        const out = g.dx * b.dir; // 처음 민 방향 기준
        const hidden = b.hidden ? out < 12 : out < 0;
        if (hidden !== !!b.hidden) Animated.timing(slide, { toValue: hidden ? 0 : 1, duration: 140, useNativeDriver: true }).start();
        return { ...b, hidden, pick: hidden ? -1 : pickAt(g.moveY) };
      });
    },
    onPanResponderRelease: (_, g) => end(g),
    onPanResponderTerminate: () => { mode.current = null; touch.current = null; setBar(null); },
  })).current;

  return <View ref={view} style={{ flex: 1 }} {...pan.panHandlers}
    onTouchStart={e => {
      const x = e.nativeEvent.pageX;
      touch.current = { t: Date.now(), x, y: e.nativeEvent.pageY, movedEarly: false }; mode.current = null;
      stopPeek();
      peekTimer.current = setTimeout(() => { if (touch.current && !touch.current.movedEarly && !mode.current) setPeek(x < width / 2 ? 'right' : 'left'); }, HOLD_MS);
    }}
    onTouchEnd={stopPeek}
    onTouchCancel={stopPeek}
    onTouchMove={e => {
      const s = touch.current;
      if (s && !s.movedEarly && Date.now() - s.t < HOLD_MS && Math.hypot(e.nativeEvent.pageX - s.x, e.nativeEvent.pageY - s.y) > 10) { s.movedEarly = true; stopPeek(); }
    }}>
    {children}
    {/* 열 준비가 됐을 때, 그리고 반대로 밀어 메뉴를 넣었을 때도 손을 떼기 전까지 가장자리에 살짝 남긴다 */}
    {(() => { const side = bar ? (bar.hidden ? bar.side : null) : peek; return side && <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, [side]: 0, justifyContent: 'center' }}>
      <View style={{ width: 8, height: tabs.length * ROW, backgroundColor: c.raised, [side === 'right' ? 'borderTopLeftRadius' : 'borderTopRightRadius']: 8, [side === 'right' ? 'borderBottomLeftRadius' : 'borderBottomRightRadius']: 8 }} />
    </View>; })()}
    {bar && <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, [bar.side]: 0, justifyContent: 'center', opacity: slide,
      transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [bar.side === 'right' ? 40 : -40, 0] }) }] }}>
      <View style={{ backgroundColor: c.surface, borderRadius: 14, paddingVertical: 4, marginHorizontal: 8 }}>
        {tabs.map((tab, i) => {
          const on = i === bar.pick, here = tab.route === current;
          return <View key={tab.route} style={{ height: ROW, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, borderRadius: 10, backgroundColor: on ? c.raised : 'transparent' }}>
            <Icon name={tab.icon} size={20} color={on || here ? c.text : c.muted} />
            <Text style={{ color: on || here ? c.text : c.muted, fontSize: 15, fontWeight: here ? '600' : '400' }}>{tab.label}</Text>
          </View>;
        })}
      </View>
    </Animated.View>}
  </View>;
}
