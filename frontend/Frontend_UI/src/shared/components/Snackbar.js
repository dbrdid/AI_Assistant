// ============================================================
// Snackbar.js — 화면 아래에 잠깐 뜨는 안내 + 선택 버튼 (예: "완료했어요 · 되돌리기")
// ============================================================
// 사용법:
//   const snack = useSnackbar();
//   snack.show('완료했어요', { label: '되돌리기', onPress: () => ... });
//   return <View>...{snack.view}</View>;   // 화면 맨 끝에 놓기
// 버튼이 있으면 4초, 없으면 2.4초 뒤에 사라집니다.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../theme/theme';

export function useSnackbar({ bottom = spacing.lg } = {}) {
  const [state, setState] = useState(null); // { text, action }
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setState(null);
  }, []);
  const show = useCallback((text, action) => {
    clearTimeout(timer.current);
    setState({ text, action });
    timer.current = setTimeout(() => setState(null), action ? 4000 : 2400);
  }, []);

  const view = state ? (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom }]}>
      <View style={styles.bar}>
        <Text style={styles.text} accessibilityLiveRegion="polite" numberOfLines={2}>{state.text}</Text>
        {state.action && (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              hide();
              state.action.onPress();
            }}
            hitSlop={8}
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.btnText}>{state.action.label}</Text>
          </Pressable>
        )}
      </View>
    </View>
  ) : null;

  return { show, hide, view };
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  bar: { width: '100%', maxWidth: 480, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.ink },
  text: { flex: 1, fontSize: font.body, color: colors.white },
  btn: { minHeight: 32, justifyContent: 'center' },
  btnText: { fontSize: font.body, fontWeight: '800', color: colors.mint },
});
