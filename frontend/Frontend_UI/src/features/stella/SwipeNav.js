// 탭 화면을 감싸는 좌우 제스처.
// 좌우로 밀기: 같은 탭 안의 쪽 이동. 길게 누른 채 좌우로 밀기: 위쪽 탭 막대에서 탭 고르기.
// 길게 누르고 있으면(밀기 전에도) 지금 탭에 테두리가 켜지고, 좌우로 옮기면 테두리가 따라 움직인다. 떼면 그 탭으로 이동한다.
// 안쪽 화면이 길게 누르기를 쓰면(예: 끌어서 여러 개 선택) claim()으로 이 제스처를 양보받는다.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { PanResponder, View } from 'react-native';
import { SwipeGestureContext } from '../../shared/hooks/useClaimSwipeGesture';
import { HOLD_MS, isVerticalDrag, pageStep, relativePick, swipeIntent } from './swipeIntent.mjs';

const STEP = 48;

export default function SwipeNav({ tabs, current, onTab, onPage, onPreview, children }) {
  const touch = useRef(null);
  const mode = useRef(null);
  const anchor = useRef(null);
  const holdTimer = useRef(null);   // 길게 누름이 확정되면 밀기 전에도 지금 탭에 테두리를 켬
  const holdShown = useRef(false);
  const hideHold = () => {
    clearTimeout(holdTimer.current);
    if (holdShown.current && mode.current !== 'tabs') latest.current.onPreview?.(null);
    holdShown.current = false;
  };
  const latest = useRef({});
  latest.current = { tabs, current, onTab, onPage, onPreview };

  const claim = useCallback(() => {
    if (touch.current && !mode.current) { touch.current.claimed = true; hideHold(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pan = useMemo(() => {
    const reset = () => {
      clearTimeout(holdTimer.current);
      holdShown.current = false;
      if (mode.current === 'tabs') latest.current.onPreview?.(null);
      mode.current = null;
      touch.current = null;
    };
    const pickAt = (x) => {
      const previous = anchor.current;
      const result = relativePick({ anchor: previous.x, y: x, start: previous.start, count: latest.current.tabs.length, row: STEP });
      anchor.current = { ...previous, x: result.anchor, pick: result.pick };
      if (result.pick !== previous.pick) latest.current.onPreview?.(latest.current.tabs[result.pick]?.route ?? null);
      return result.pick;
    };
    const intentAt = (event, gesture) => {
      const start = touch.current;
      if (!start || gesture.numberActiveTouches > 1) return null;
      const { pageX, pageY } = event.nativeEvent;
      const dx = pageX - start.x;
      const dy = pageY - start.y;
      if (isVerticalDrag({ dx, dy })) start.startedVertically = true;
      return swipeIntent({ ...start, heldMs: Date.now() - start.time, dx, dy });
    };
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (event, gesture) => intentAt(event, gesture) === 'tabs',
      onMoveShouldSetPanResponder: (event, gesture) => intentAt(event, gesture) === 'page',
      onPanResponderGrant: (event, gesture) => {
        const intent = intentAt(event, gesture);
        mode.current = intent;
        if (intent !== 'tabs') return;
        const { tabs: all, current: here } = latest.current;
        anchor.current = { x: event.nativeEvent.pageX, start: Math.max(0, all.findIndex(tab => tab.route === here)), pick: -1 };
        pickAt(event.nativeEvent.pageX);
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderReject: reset,
      onPanResponderTerminate: reset,
      onPanResponderMove: event => {
        if (event.nativeEvent.touches?.length > 1) { reset(); return; }
        if (mode.current === 'tabs') pickAt(event.nativeEvent.pageX);
      },
      onPanResponderRelease: event => {
        if (mode.current === 'page' && touch.current) latest.current.onPage(pageStep(event.nativeEvent.pageX - touch.current.x));
        if (mode.current === 'tabs') {
          const route = latest.current.tabs[pickAt(event.nativeEvent.pageX)]?.route;
          if (route && route !== latest.current.current) latest.current.onTab(route);
        }
        reset();
      },
    });
  }, []);
  useEffect(() => () => {
    clearTimeout(holdTimer.current);
    if (mode.current === 'tabs' || holdShown.current) latest.current.onPreview?.(null);
  }, []);

  return <SwipeGestureContext.Provider value={claim}><View style={{ flex: 1 }} {...pan.panHandlers}
    onTouchStart={event => {
      if (event.nativeEvent.touches?.length > 1) { claim(); return; }
      const { pageX: x, pageY: y } = event.nativeEvent;
      touch.current = { time: Date.now(), x, y, movedEarly: false };
      hideHold();
      holdTimer.current = setTimeout(() => {
        const start = touch.current;
        if (!start || start.movedEarly || start.claimed || start.startedVertically || mode.current) return;
        holdShown.current = true;
        latest.current.onPreview?.(latest.current.current);
      }, HOLD_MS);
    }}
    onTouchEnd={() => { hideHold(); if (!mode.current) touch.current = null; }}
    onTouchCancel={() => { hideHold(); if (!mode.current) touch.current = null; }}
    onTouchMove={event => {
      const start = touch.current;
      if (!start || mode.current) return;
      const dx = event.nativeEvent.pageX - start.x;
      const dy = event.nativeEvent.pageY - start.y;
      if (isVerticalDrag({ dx, dy })) start.startedVertically = true;
      if (Date.now() - start.time < HOLD_MS && Math.hypot(dx, dy) > 10) { start.movedEarly = true; hideHold(); }
      if (start.startedVertically) hideHold();
    }}>
    {children}
  </View></SwipeGestureContext.Provider>;
}
