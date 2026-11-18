// ============================================================
// ScreenHeader.js — 화면 맨 위의 "제목 줄" (모든 화면이 공통으로 사용)
// ============================================================
// Figma 시안: 왼쪽 동그란 흰 버튼(‹, 탭 첫 화면에는 없음) · 가운데 제목 · 오른쪽 자리(동그란 버튼/알약 버튼)

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../hooks/useInsets';
import { colors, font, spacing } from '../theme/theme';
import { useLeadAction } from '../../navigation/ScreenEntry';
import { CircleButton } from './Ui';

export default function ScreenHeader({ title, onBack, right, lead: leadOverride }) {
  // 노치/상태바에 제목이 가려지지 않도록 위쪽 안전영역 높이를 가져옴
  const insets = useSafeAreaInsets();
  // 왼쪽 버튼: 하단 탭으로 연 화면이면 없음, 다른 화면에서 들어왔으면 ‹(onBack)
  const lead = useLeadAction(onBack);

  return (
    <View style={[styles.bar, { paddingTop: insets.top + spacing.sm }]}>
      {/* 제목: 양옆 버튼 폭과 상관없이 화면 정가운데 */}
      <View pointerEvents="none" style={[styles.titleWrap, { top: insets.top + spacing.sm }]}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
      </View>

      <View style={styles.side}>
        {leadOverride || (!lead.hidden && <CircleButton icon="chevronLeft" label="뒤로 가기" onPress={lead.onPress} />)}
      </View>

      {/* 오른쪽 자리: right 가 있으면 표시, 없으면 비어 있음 */}
      <View style={[styles.side, styles.right]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.cream,
    minHeight: 40,
  },
  titleWrap: { position: 'absolute', left: 96, right: 96, height: 40, alignItems: 'center', justifyContent: 'center' },
  side: { minWidth: 40, minHeight: 40, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  right: { justifyContent: 'flex-end' },
  title: { fontSize: font.header, fontWeight: '800', color: colors.ink },
});
