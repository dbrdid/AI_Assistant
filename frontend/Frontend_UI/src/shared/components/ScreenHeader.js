// ============================================================
// ScreenHeader.js — 화면 맨 위의 "제목 줄" (모든 화면이 공통으로 사용)
// ============================================================
// Figma 시안: 왼쪽 동그란 흰 버튼(‹, 탭 첫 화면에는 없음) · 가운데 제목 · 오른쪽 자리(동그란 버튼/알약 버튼)

import { StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../hooks/useInsets';
import { colors, font, spacing } from '../theme/theme';
import { useLeadAction, useScreenEntry } from '../../navigation/ScreenEntry';
import { CircleButton } from './Ui';

export default function ScreenHeader({ title, onBack, right, titleRightInset, lead: leadOverride }) {
  // 노치/상태바에 제목이 가려지지 않도록 위쪽 안전영역 높이를 가져옴
  const insets = useSafeAreaInsets();
  // 왼쪽 버튼: 하단 탭으로 연 화면이면 없음, 다른 화면에서 들어왔으면 ‹(onBack)
  const lead = useLeadAction(onBack);
  const { embedded } = useScreenEntry();
  // 상단 탭 안에서는 뒤로 가기·가운데 제목·구분선을 반복하지 않고 Stella 문서 화면처럼 왼쪽 제목 + 오른쪽 동작만 둔다.
  // 위 탭 이름(캘린더, 할 일 등)이 이미 제목 역할을 하므로 큰 제목을 다시 쓰지 않는다 (홈 개요와 같이). 동작이 없으면 줄도 없음.
  if (embedded) return !right && !leadOverride ? null : (
    <View style={styles.embedded}>
      {leadOverride}
      <View style={{ flex: 1 }} />
      <View style={[styles.side, styles.right]}>{right}</View>
    </View>
  );

  return (
    <View style={[styles.bar, { paddingTop: insets.top + spacing.sm }]}>
      {/* 제목: 양옆 버튼 폭과 상관없이 화면 정가운데 */}
      <View pointerEvents="none" style={[
        styles.titleWrap,
        { top: insets.top + spacing.sm },
        titleRightInset != null && { right: titleRightInset },
      ]}>
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
    paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.line, marginBottom: 8,
    paddingBottom: spacing.md,
    backgroundColor: colors.cream,
    minHeight: 40,
  },
  embedded: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: 20, paddingTop: 4, minHeight: 44, backgroundColor: colors.cream },
  titleWrap: { position: 'absolute', left: 64, right: 64, height: 40, alignItems: 'center', justifyContent: 'center' },
  side: { minWidth: 40, minHeight: 40, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  right: { justifyContent: 'flex-end' },
  title: { fontSize: font.header, fontWeight: '600', color: colors.ink },
});
