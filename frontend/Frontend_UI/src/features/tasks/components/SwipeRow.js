// ============================================================
// SwipeRow.js — 왼쪽으로 밀면 뒤에 숨은 버튼이 보이고, 끝까지 밀면 바로 실행되는 줄
// ============================================================
//   <SwipeRow actionLabel="내일로" onAction={...}>{줄 내용}</SwipeRow>
// 화면 읽기 사용자는 같은 동작을 accessibilityActions(이름: actionLabel)로 실행할 수 있습니다.

import React, { useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { colors, font, radius } from '../../../shared/theme/theme';

const REVEAL = 88;   // 뒤 버튼 너비
const TRIGGER = 72;  // 이만큼 넘게 밀고 놓으면 실행

export default function SwipeRow({ actionLabel, onAction, children, style }) {
  const x = useRef(new Animated.Value(0)).current;
  const latest = useRef(onAction);
  latest.current = onAction;

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 가로로 확실히 밀 때만 가져감 (세로 스크롤 · 탭과 충돌하지 않게)
        onMoveShouldSetPanResponder: (_, g) => g.dx < -10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => x.setValue(Math.max(-REVEAL - 24, Math.min(0, g.dx))),
        onPanResponderRelease: (_, g) => {
          const fire = g.dx < -TRIGGER;
          Animated.spring(x, { toValue: 0, friction: 8, useNativeDriver: false }).start();
          if (fire) latest.current();
        },
        onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
      }),
    [x],
  );

  // 손가락이 TRIGGER 를 넘으면 뒤 버튼이 진해짐
  const bg = x.interpolate({ inputRange: [-TRIGGER - 1, -TRIGGER, 0], outputRange: [colors.coral, colors.coralSoft, colors.coralSoft] });
  const fg = x.interpolate({ inputRange: [-TRIGGER - 1, -TRIGGER, 0], outputRange: [colors.white, colors.coral, colors.coral] });

  return (
    <View
      style={[styles.wrap, style]}
      accessible={false}
      accessibilityActions={[{ name: 'swipeAction', label: actionLabel }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === 'swipeAction' && onAction()}
    >
      <Animated.View style={[styles.under, { backgroundColor: bg }]}>
        <Animated.Text style={[styles.underText, { color: fg }]}>{actionLabel}</Animated.Text>
      </Animated.View>
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.card, overflow: 'hidden' },
  under: { position: 'absolute', top: 0, bottom: 0, right: 0, width: REVEAL + 40, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 16, borderRadius: radius.card },
  underText: { fontSize: font.body, fontWeight: '800', width: REVEAL - 16, textAlign: 'center' },
});
