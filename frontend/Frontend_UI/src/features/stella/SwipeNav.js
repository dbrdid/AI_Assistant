// 탭 화면을 감싸는 좌우 제스처.
// 좌우로 밀기: 같은 탭 안의 쪽 이동. 길게 누른 채 좌우로 밀기: 민 쪽 가장자리에서 세로 탭 막대가 나오고,
// 손가락을 위아래로 옮겨 탭을 고른 뒤 떼면 이동한다. 위쪽 탭 버튼은 그대로 있다(같은 기능의 버튼).
import React, { useRef, useState } from 'react';
import { Animated, PanResponder, Text, View } from 'react-native';
import Icon from '../../shared/components/Icon';
import { HOLD_MS, pageStep, swipeIntent } from './swipeIntent.mjs';
import { palette as c } from './theme';

const ROW = 56;

export default function SwipeNav({ tabs, current, onTab, onPage, children }) {
  const touch = useRef(null);       // { t, x, y, movedEarly }
  const mode = useRef(null);        // 'page' | 'tabs'
  const box = useRef(null);         // 감싼 영역의 화면 위치
  const view = useRef(null);
  const latest = useRef({}); latest.current = { tabs, onTab, onPage };
  const [bar, setBar] = useState(null); // { side, pick }
  const slide = useRef(new Animated.Value(0)).current;

  const pickAt = (pageY) => {
    const b = box.current; if (!b) return -1;
    const top = b.y + (b.height - latest.current.tabs.length * ROW) / 2;
    const i = Math.floor((pageY - top) / ROW);
    return i >= 0 && i < latest.current.tabs.length ? i : -1;
  };
  const decide = (g) => {
    const s = touch.current;
    if (!s || mode.current) return !!mode.current;
    const intent = swipeIntent({ heldMs: Date.now() - s.t, movedEarly: s.movedEarly, dx: g.dx, dy: g.dy });
    if (!intent) return false;
    mode.current = intent;
    if (intent === 'tabs') {
      view.current?.measureInWindow((x, y, width, height) => { box.current = { y, height }; });
      setBar({ side: g.dx > 0 ? 'right' : 'left', pick: -1 });
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    }
    return true;
  };
  const end = (g) => {
    if (mode.current === 'page') latest.current.onPage(pageStep(g.dx));
    if (mode.current === 'tabs') { const i = pickAt(g.moveY); if (i >= 0) latest.current.onTab(latest.current.tabs[i].route); }
    mode.current = null; touch.current = null; setBar(null);
  };
  const pan = useRef(PanResponder.create({
    // 길게 누른 뒤의 밀기는 안쪽(목록, 버튼)보다 먼저 가져온다. 그냥 밀기는 안쪽 가로 스크롤에 양보한다.
    onMoveShouldSetPanResponderCapture: (_, g) => { const s = touch.current; return !!s && Date.now() - s.t >= HOLD_MS && !s.movedEarly && decide(g); },
    onMoveShouldSetPanResponder: (_, g) => decide(g),
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_, g) => { if (mode.current === 'tabs') setBar(b => b && { ...b, pick: pickAt(g.moveY) }); },
    onPanResponderRelease: (_, g) => end(g),
    onPanResponderTerminate: () => { mode.current = null; touch.current = null; setBar(null); },
  })).current;

  return <View ref={view} style={{ flex: 1 }} {...pan.panHandlers}
    onTouchStart={e => { touch.current = { t: Date.now(), x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, movedEarly: false }; mode.current = null; }}
    onTouchMove={e => {
      const s = touch.current;
      if (s && !s.movedEarly && Date.now() - s.t < HOLD_MS && Math.hypot(e.nativeEvent.pageX - s.x, e.nativeEvent.pageY - s.y) > 10) s.movedEarly = true;
    }}>
    {children}
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
