// 탭 화면을 감싸는 좌우 제스처.
// 좌우로 밀기: 같은 탭 안의 쪽 이동. 길게 누른 채 좌우로 밀기: 위쪽 탭 막대에서 탭 고르기.
// 길게 누르고 있으면(밀기 전에도) 지금 탭에 테두리가 켜지고, 손가락을 좌우로 옮기면 테두리가 따라 움직인다. 떼면 그 탭으로 이동한다. 위쪽 탭 버튼은 그대로 눌러도 된다.
import React, { useEffect, useRef } from 'react';
import { PanResponder, View } from 'react-native';
import { HOLD_MS, pageStep, relativePick, swipeIntent } from './swipeIntent.mjs';

const STEP = 48;   // 손가락을 이만큼 좌우로 옮길 때마다 한 칸

export default function SwipeNav({ tabs, current, onTab, onPage, onPreview, children }) {
  const touch = useRef(null);       // { t, x, y, movedEarly }
  const mode = useRef(null);        // 'page' | 'tabs'
  const latest = useRef({}); latest.current = { tabs, current, onTab, onPage, onPreview };
  const holdTimer = useRef(null);  // 길게 누름이 확정되면 바로 테두리를 켬
  const anchor = useRef({ x: 0, start: 0, pick: -1 }); // 처음 좌우로 민 위치와 그때의 탭
  const pickAt = (pageX) => {
    const r = relativePick({ anchor: anchor.current.x, y: pageX, start: anchor.current.start, count: latest.current.tabs.length, row: STEP });
    anchor.current.x = r.anchor;
    if (r.pick !== anchor.current.pick) { anchor.current.pick = r.pick; latest.current.onPreview?.(latest.current.tabs[r.pick]?.route ?? null); }
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
      anchor.current = { x: g.moveX, start: Math.max(0, all.findIndex(tab => tab.route === here)), pick: -1 };
      pickAt(g.moveX);
    }
    return true;
  };
  const reset = () => { granted.current = false; clearTimeout(holdTimer.current); latest.current.onPreview?.(null); mode.current = null; touch.current = null; };
  // 손을 뗐는데 탭 고르기가 아니면(길게 누르기만 함) 켜 둔 테두리를 끈다
  const granted = useRef(false);     // 이 끌기를 실제로 잡았는지 (못 잡았으면 놓을 때 여기서 정리)
  const release = () => { clearTimeout(holdTimer.current); if (mode.current !== 'tabs' || !granted.current) reset(); };
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  const end = (g) => {
    if (mode.current === 'page') latest.current.onPage(pageStep(g.dx));
    if (mode.current === 'tabs') {
      const route = latest.current.tabs[pickAt(g.moveX)]?.route;
      if (route && route !== latest.current.current) latest.current.onTab(route);
    }
    reset();
  };
  const pan = useRef(PanResponder.create({
    // 길게 누른 뒤의 밀기는 안쪽(목록, 버튼)보다 먼저 가져온다. 그냥 밀기는 안쪽 가로 스크롤에 양보한다.
    onMoveShouldSetPanResponderCapture: (_, g) => { const s = touch.current; return !!s && Date.now() - s.t >= HOLD_MS && !s.movedEarly && decide(g); },
    onMoveShouldSetPanResponder: (_, g) => decide(g),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { granted.current = true; },
    onPanResponderReject: () => reset(),
    onPanResponderMove: (_, g) => { if (mode.current === 'tabs') pickAt(g.moveX); },
    onPanResponderRelease: (_, g) => end(g),
    onPanResponderTerminate: reset,
  })).current;

  return <View style={{ flex: 1 }} {...pan.panHandlers}
    onTouchStart={e => {
      touch.current = { t: Date.now(), x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, movedEarly: false }; mode.current = null;
      clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => {
        if (touch.current && !touch.current.movedEarly && !mode.current) latest.current.onPreview?.(latest.current.current);
      }, HOLD_MS);
    }}
    onTouchEnd={release}
    onTouchCancel={release}
    onTouchMove={e => {
      const s = touch.current;
      if (s && !s.movedEarly && Date.now() - s.t < HOLD_MS && Math.hypot(e.nativeEvent.pageX - s.x, e.nativeEvent.pageY - s.y) > 10) { s.movedEarly = true; clearTimeout(holdTimer.current); }
    }}>
    {children}
  </View>;
}
