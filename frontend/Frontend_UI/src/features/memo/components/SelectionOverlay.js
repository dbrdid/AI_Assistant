// ============================================================
// SelectionOverlay.js — 손글씨 변환할 "영역"을 손가락으로 끌어서 지정하는 투명 덮개
// ============================================================
// 메모 페이지 위에 겹쳐 둡니다. 손가락으로 대각선으로 끌면 점선 네모가 그려지고,
// 손가락을 떼면 그 영역({x1,y1,x2,y2})을 onSelect 로 알려줍니다. (좌표는 페이지 기준)

import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { colors, FILL } from '../../../shared/theme/theme';

export default function SelectionOverlay({ onSelect }) {
  const [rect, setRect] = useState(null); // 끌고 있는 네모 { x1, y1, x2, y2 } (보이는 용도)
  const start = useRef({ x: 0, y: 0 });
  const live = useRef({});
  live.current = { onSelect };

  const toRect = (x, y) => ({
    x1: Math.min(start.current.x, x),
    y1: Math.min(start.current.y, y),
    x2: Math.max(start.current.x, x),
    y2: Math.max(start.current.y, y),
  });

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          start.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
          setRect(toRect(start.current.x, start.current.y));
        },
        onPanResponderMove: (e) => setRect(toRect(e.nativeEvent.locationX, e.nativeEvent.locationY)),
        onPanResponderRelease: (e) => {
          const r = toRect(e.nativeEvent.locationX, e.nativeEvent.locationY);
          setRect(null);
          // 너무 작게 끌었으면(그냥 탭) 무시
          if (r.x2 - r.x1 > 12 && r.y2 - r.y1 > 12) live.current.onSelect(r);
        },
        onPanResponderTerminate: () => setRect(null),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <View style={FILL} {...pan.panHandlers}>
      {rect && (
        <View
          pointerEvents="none"
          style={[
            styles.box,
            { left: rect.x1, top: rect.y1, width: rect.x2 - rect.x1, height: rect.y2 - rect.y1 },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.mint,
    backgroundColor: 'rgba(93,201,178,0.15)',
  },
});
