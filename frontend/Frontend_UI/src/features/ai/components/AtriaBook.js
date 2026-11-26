// Atria AI 책 아이콘: 펼친 책의 오른쪽 장이 가운데(책등)를 축으로 넘어간다.
// 평소에는 천천히, 답을 만드는 중(busy)에는 빠르게 넘긴다.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../../../shared/theme/theme';

const IDLE = { flip: 1400, rest: 1600 };   // 한 장 넘기는 시간, 다음 장까지 쉬는 시간 (ms)
const BUSY = { flip: 420, rest: 80 };

export default function AtriaBook({ size = 28, busy = false, color = colors.muted, label = 'Atria AI' }) {
  const turn = useRef(new Animated.Value(0)).current;   // 0 → 1: 오른쪽 장이 왼쪽으로 넘어감
  useEffect(() => {
    const { flip, rest } = busy ? BUSY : IDLE;
    turn.setValue(0);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(turn, { toValue: 1, duration: flip, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.delay(rest),
      Animated.timing(turn, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [busy, turn]);

  const half = size / 2;
  const scaleX = turn.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, -1] });
  const stroke = Math.max(1.5, size / 14);
  // 한쪽 장: 책등(왼쪽 끝)에서 바깥으로 살짝 휜 종이
  const page = `M${stroke / 2} ${size * 0.22} Q${half * 0.5} ${size * 0.14} ${half - stroke / 2} ${size * 0.2} V${size * 0.82} Q${half * 0.5} ${size * 0.76} ${stroke / 2} ${size * 0.84} Z`;
  return (
    <View accessibilityRole="image" accessibilityLabel={busy ? `${label}, 답을 만드는 중` : label} style={{ width: size, height: size }}>
      {/* 바닥에 펼쳐진 두 장 */}
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Path d={page} transform={`translate(${half}, 0)`} stroke={color} strokeWidth={stroke} strokeLinejoin="round" fill="none" />
        <Path d={page} transform={`translate(${half}, 0) scale(-1, 1)`} stroke={color} strokeWidth={stroke} strokeLinejoin="round" fill="none" />
      </Svg>
      {/* 넘어가는 장: 오른쪽 절반, 책등을 축으로 뒤집힘 */}
      <Animated.View style={{ position: 'absolute', left: half, top: 0, width: half, height: size, transformOrigin: 'left', transform: [{ scaleX }] }}>
        <Svg width={half} height={size}>
          <Path d={page} stroke={color} strokeWidth={stroke} strokeLinejoin="round" fill={colors.cream} />
        </Svg>
      </Animated.View>
    </View>
  );
}
