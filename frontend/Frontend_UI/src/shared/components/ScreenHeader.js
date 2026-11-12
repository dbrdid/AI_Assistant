// ============================================================
// ScreenHeader.js — 화면 맨 위의 "제목 줄" (모든 화면이 공통으로 사용)
// ============================================================


import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../hooks/useInsets';
import { colors, font, spacing } from '../theme/theme';
import { useMenu } from '../../navigation/MenuContext';

export default function ScreenHeader({ title, onBack, right }) {
  // 노치/상태바에 제목이 가려지지 않도록 위쪽 안전영역 높이를 가져옴
  const insets = useSafeAreaInsets();
  // 메뉴 열기 함수
  const { open } = useMenu();

  return (
    <View style={[styles.bar, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={onBack ? '뒤로 가기' : '메뉴 열기'} // 화면 읽기 프로그램용 설명
        onPress={onBack || open} // onBack 이 있으면 그것, 없으면 메뉴 열기
        hitSlop={12}             // 버튼 주변 12px 도 터치로 인정(누르기 쉽게)
        style={styles.side}
      >
        <Text style={styles.icon}>{onBack ? '‹' : '☰'}</Text>
      </Pressable>

      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>

      {/* 오른쪽 자리: right 가 있으면 표시, 없으면 비어 있음 (제목을 가운데로 맞추는 용도 겸용) */}
      <View style={[styles.side, styles.right]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',        // 자식들을 가로로 나란히
    alignItems: 'center',        // 세로 가운데 정렬
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.cream,
  },
  side: { width: 44, minHeight: 32, justifyContent: 'center' },
  right: { alignItems: 'flex-end' }, // 오른쪽 자리의 내용은 오른쪽 끝에 붙임
  icon: { fontSize: 26, color: colors.ink },
  // flex: 1 → 양옆 버튼을 뺀 나머지 폭을 제목이 전부 차지, textAlign center 로 가운데 정렬
  title: { flex: 1, textAlign: 'center', fontSize: font.title, fontWeight: '800', color: colors.ink },
});
