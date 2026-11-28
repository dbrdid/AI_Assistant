// ============================================================
// SwipeRow.js — 왼쪽으로 밀면 뒤에 숨은 버튼이 보이고, 끝까지 밀면 바로 실행되는 줄
// ============================================================
//   <SwipeRow actionLabel="내일로" onAction={...}>{줄 내용}</SwipeRow>
// 화면 읽기 사용자는 같은 동작을 accessibilityActions(이름: actionLabel)로 실행할 수 있습니다.

import React, { useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { colors, font } from '../../../shared/theme/theme';
import { useClaimSwipeGesture } from '../../../shared/hooks/useClaimSwipeGesture';

const REVEAL = 88;   // 뒤 버튼 너비
const TRIGGER = 72;  // 이만큼 넘게 밀고 놓으면 실행

export default function SwipeRow({ actionLabel, onAction, children, style }) {
  const x = useRef(new Animated.Value(0)).current;
  const latest = useRef(onAction);
  latest.current = onAction;
  const claimSwipe = useClaimSwipeGesture();

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 가로로 확실히 밀 때만 가져감 (세로 스크롤 · 탭과 충돌하지 않게)
        onMoveShouldSetPanResponder: (_, g) => g.dx < -10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderGrant: () => claimSwipe(),
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => {
          claimSwipe();
          x.setValue(Math.max(-REVEAL - 24, Math.min(0, g.dx)));
        },
        onPanResponderRelease: (_, g) => {
          const fire = g.dx < -TRIGGER;
          Animated.spring(x, { toValue: 0, friction: 8, useNativeDriver: false }).start();
          if (fire) latest.current();
        },
        onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
      }),
    [x, claimSwipe],
  );

  // 미루기는 지우기가 아니라서 붉은색 대신 회색. TRIGGER를 넘으면 밝아져 놓으면 실행됨을 알림
  // clamp: 실행 지점을 넘어 더 밀어도 색이 계속 밝아지지 않게 (없으면 하얗게 날아감)
  const bg = x.interpolate({ inputRange: [-TRIGGER - 8, -TRIGGER, 0], outputRange: [colors.actionBorder, colors.raised, colors.raised], extrapolate: 'clamp' });
  const fg = x.interpolate({ inputRange: [-TRIGGER - 8, -TRIGGER, 0], outputRange: [colors.ink, colors.muted, colors.muted], extrapolate: 'clamp' });
  // 가만히 있을 때는 뒤 버튼을 숨기고(줄 가장자리로 비치지 않게), 글자는 다 보일 만큼 밀었을 때만
  const underOpacity = x.interpolate({ inputRange: [-12, 0], outputRange: [1, 0], extrapolate: 'clamp' });
  const textOpacity = x.interpolate({ inputRange: [-REVEAL + 8, -48, 0], outputRange: [1, 0, 0], extrapolate: 'clamp' });

  return (
    <View
      style={[styles.wrap, style]}
      accessible={false}
      accessibilityActions={[{ name: 'swipeAction', label: actionLabel }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === 'swipeAction' && onAction()}
    >
      <Animated.View style={[styles.under, { backgroundColor: bg, opacity: underOpacity }]}>
        <Animated.Text style={[styles.underText, { color: fg, opacity: textOpacity }]}>{actionLabel}</Animated.Text>
      </Animated.View>
      <Animated.View {...pan.panHandlers} style={{ backgroundColor: colors.cream, transform: [{ translateX: x }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 0, overflow: 'hidden' },
  under: { position: 'absolute', top: 0, bottom: 0, right: 0, width: REVEAL + 40, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 16 },
  underText: { fontSize: font.body, fontWeight: '600', width: REVEAL - 16, textAlign: 'center' },
});
