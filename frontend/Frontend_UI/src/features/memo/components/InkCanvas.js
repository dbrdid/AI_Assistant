// ============================================================
// InkCanvas.js — 손글씨 / 지우개 캔버스
// ============================================================

import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { hitsStroke, newStrokeId, pointsToPath } from '../utils/InkUtils';
import { FILL } from '../../../shared/theme/theme';

const ERASE_RADIUS = 14; // 지우개 반지름(px)
const MIN_STEP = 1.5;    // 이보다 조금 움직인 건 점으로 안 찍음 (점이 너무 많아지는 것 방지)

// 획 하나. 점이 안 바뀌면 다시 그리지 않도록 memo 로 감쌈
const StrokePath = React.memo(function StrokePath({ stroke, faded }) {
  return (
    <Path
      d={pointsToPath(stroke.p)}
      stroke={stroke.c}
      strokeWidth={stroke.w}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      opacity={faded ? 0.25 : 1}
    />
  );
});

export default function InkCanvas({ strokes, mode, color, width, onChange }) {
  const active = mode === 'pen' || mode === 'eraser';

  const [draft, setDraft] = useState(null);         // 지금 그리고 있는 획
  const [erasedIds, setErasedIds] = useState([]);   // 지우개가 닿아서 "지워질 예정"인 획들

  // 제스처 코드는 한 번만 만들어지므로 최신 값은 ref 에서 읽음
  const live = useRef({});
  live.current = { strokes, mode, color, width, onChange };
  const pts = useRef([]);            // 그리는 중인 점들
  const erased = useRef(new Set());  // 지울 획 번호들

  const eraseAt = (x, y) => {
    let changed = false;
    live.current.strokes.forEach((s) => {
      if (!erased.current.has(s.id) && hitsStroke(s, x, y, ERASE_RADIUS)) {
        erased.current.add(s.id);
        changed = true;
      }
    });
    if (changed) setErasedIds(Array.from(erased.current));
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false, // 쓰는 도중 다른 곳이 제스처를 빼앗지 못하게
        onPanResponderGrant: (e) => {
          const x = Math.round(e.nativeEvent.locationX * 10) / 10;
          const y = Math.round(e.nativeEvent.locationY * 10) / 10;
          if (live.current.mode === 'eraser') {
            erased.current = new Set();
            eraseAt(x, y);
          } else {
            pts.current = [[x, y]];
            setDraft({ c: live.current.color, w: live.current.width, p: pts.current.slice() });
          }
        },
        onPanResponderMove: (e) => {
          const x = Math.round(e.nativeEvent.locationX * 10) / 10;
          const y = Math.round(e.nativeEvent.locationY * 10) / 10;
          if (live.current.mode === 'eraser') {
            eraseAt(x, y);
            return;
          }
          const last = pts.current[pts.current.length - 1];
          if (last && Math.hypot(x - last[0], y - last[1]) < MIN_STEP) return;
          pts.current.push([x, y]);
          setDraft({ c: live.current.color, w: live.current.width, p: pts.current.slice() });
        },
        onPanResponderRelease: () => finish(),
        onPanResponderTerminate: () => finish(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 손가락을 뗐을 때: 그린 획을 저장하거나 지운 획을 반영
  function finish() {
    const L = live.current;
    if (L.mode === 'eraser') {
      if (erased.current.size > 0) {
        const gone = erased.current;
        L.onChange(L.strokes.filter((s) => !gone.has(s.id)));
      }
      erased.current = new Set();
      setErasedIds([]);
    } else if (pts.current.length > 0) {
      L.onChange([...L.strokes, { id: newStrokeId(), c: L.color, w: L.width, p: pts.current }]);
      pts.current = [];
      setDraft(null);
    }
  }

  return (
    <View
      style={FILL}
      // 펜/지우개일 때만 터치를 받고, 키보드 모드에서는 아래 글자 입력창으로 통과
      pointerEvents={active ? 'auto' : 'none'}
      {...(active ? pan.panHandlers : {})}
    >
      <Svg style={FILL} pointerEvents="none">
        {strokes.map((s) => (
          <StrokePath key={s.id} stroke={s} faded={erasedIds.includes(s.id)} />
        ))}
        {draft && <StrokePath stroke={draft} />}
      </Svg>
    </View>
  );
}
