// 탭 안의 좌우 밀기는 화면을, 길게 누른 뒤 좌우 밀기는 탭을 바꾼다.
import { useRef } from 'react';
import { PanResponder, View } from 'react-native';
import { HOLD_MS, pageStep, swipeIntent } from './swipeIntent.mjs';

export default function SwipeNav({ tabs, current, onTab, onPage, children }) {
  const touch = useRef(null);       // { t, x, y, movedEarly }
  const mode = useRef(null);        // 'page' | 'tabs'
  const latest = useRef({});
  latest.current = { tabs, current, onTab, onPage };

  const decide = (g) => {
    const s = touch.current;
    if (!s || mode.current) return !!mode.current;
    const intent = swipeIntent({ heldMs: Date.now() - s.t, movedEarly: s.movedEarly, dx: g.dx, dy: g.dy });
    if (!intent) return false;
    mode.current = intent;
    return true;
  };
  const end = (g) => {
    const active = latest.current;
    const step = pageStep(g.dx);
    if (mode.current === 'page' && step) active.onPage(step);
    if (mode.current === 'tabs' && step) {
      const index = active.tabs.findIndex(tab => tab.route === active.current);
      const next = index + step;
      if (index >= 0 && next >= 0 && next < active.tabs.length) active.onTab(active.tabs[next].route);
    }
    mode.current = null;
    touch.current = null;
  };
  const pan = useRef(PanResponder.create({
    // 길게 누른 뒤의 좌우 밀기는 안쪽(목록, 버튼)보다 먼저 가져온다.
    onMoveShouldSetPanResponderCapture: (_, g) => { const s = touch.current; return !!s && Date.now() - s.t >= HOLD_MS && !s.movedEarly && decide(g); },
    onMoveShouldSetPanResponder: (_, g) => decide(g),
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_, g) => end(g),
    onPanResponderTerminate: () => { mode.current = null; touch.current = null; },
  })).current;

  return <View style={{ flex: 1 }} {...pan.panHandlers}
    onTouchStart={e => {
      touch.current = { t: Date.now(), x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, movedEarly: false };
      mode.current = null;
    }}
    onTouchCancel={() => { mode.current = null; touch.current = null; }}
    onTouchMove={e => {
      const s = touch.current;
      if (s && !s.movedEarly && Date.now() - s.t < HOLD_MS
        && Math.hypot(e.nativeEvent.pageX - s.x, e.nativeEvent.pageY - s.y) > 10) s.movedEarly = true;
    }}>
    {children}
  </View>;
}
