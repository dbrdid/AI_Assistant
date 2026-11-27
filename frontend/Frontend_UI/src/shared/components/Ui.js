// ============================================================
// Ui.js — Figma 'Stella 앱 시안' 스타일의 공통 부품
// ============================================================
//   CircleButton : 머리글의 동그란 흰 버튼 (☰, 🔔, +, 뒤로 등)
//   PillButton   : 머리글 오른쪽 '완료' 같은 알약 버튼
//   Card         : 흰 카드 + 얇은 테두리
//   Chip         : 필터 칩 (선택 시 진한 녹색)
//   Tag          : 연한 민트 바탕의 작은 꼬리표 (프로젝트 이름 등)
//   IconTile     : 연한 민트 사각 타일 안의 아이콘
//   DashedButton : 점선 테두리 '+ 추가' 버튼
//   StatBox      : 아이콘 + 이름 + 숫자 상자 (오늘 일정 3 등)

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { colors, font, radius, spacing } from '../theme/theme';
import { useInsets } from '../hooks/useInsets';

// 화면 아래 오른쪽 '만들기' 버튼: 홈 하단 도크(features/stella homeDock)와 같은 자리·모양.
// 엄지가 닿기 쉬운 곳에 자주 쓰는 생성 동작을 두고, 같은 기능은 모든 화면에서 같은 자리에 둔다.
export function BottomCreate({ label, onPress, icon = 'plus' }) {
  return (
    <BottomBar>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.dockButton, pressed && { opacity: 0.5 }]}>
        <Icon name={icon} size={21} color={colors.ink} />
      </Pressable>
    </BottomBar>
  );
}

// 모든 화면의 하단 줄: 홈 개요 도크와 같은 1px 윗선·좌우 16·면 없음. 왼쪽 정보, 오른쪽 동작.
export function BottomBar({ children, style }) {
  const insets = useInsets();
  return <View style={[styles.dock, { paddingBottom: Math.max(10, insets.bottom) }, style]}>{children}</View>;
}

// 하단 줄 오른쪽 글자 동작 (저장 등)
export function BarAction({ label, onPress, disabled, danger }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.dockButton, { paddingHorizontal: 8 }, pressed && { opacity: 0.5 }, disabled && { opacity: 0.4 }]}>
      <Text style={{ fontSize: 16, fontWeight: '600', color: danger ? colors.coral : colors.ink }}>{label}</Text>
    </Pressable>
  );
}

export function CircleButton({ icon, onPress, label, size = 40, iconSize = 20, color = colors.ink, badge, disabled, children, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.circle, { width: size, height: size, borderRadius: size / 2 }, pressed && { backgroundColor: colors.mintSoft }, disabled && { opacity: 0.4 }, style]}
    >
      {children || <Icon name={icon} size={iconSize} color={color} />}
      {!!badge && <View style={styles.badgeDot} />}
    </Pressable>
  );
}

export function PillButton({ label, onPress, kind = 'primary', disabled, style }) {
  const primary = kind === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.pill, kind === 'text' ? styles.pillTextOnly : primary ? styles.pillPrimary : styles.pillGhost, pressed && { opacity: 0.6 }, disabled && { opacity: 0.4 }, style]}
    >
      <Text style={[styles.pillText, { color: primary ? colors.onPrimary : colors.ink }, kind === 'text' && { fontSize: 16 }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style, onPress, onLongPress, accessibilityLabel, dim }) {
  if (!onPress && !onLongPress) return <View style={[styles.card, dim && { opacity: 0.7 }, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.card, dim && { opacity: 0.7 }, pressed && { backgroundColor: colors.mintSoft }, style]}
    >
      {children}
    </Pressable>
  );
}

export function InlineDeletePrompt({ question, hint, onDelete }) {
  return (
    <View style={styles.inlineDelete}>
      <Text style={styles.inlineDeleteQuestion}>{question}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={question + ' 삭제'} accessibilityHint={hint} onPress={onDelete} style={styles.inlineDeleteButton}>
        <Text style={styles.inlineDeleteText}>삭제</Text>
      </Pressable>
    </View>
  );
}

export function Chip({ label, active, onPress, style }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive, style]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

// tone: 'mint'(기본) | 'outline' | 'muted'
export function Tag({ label, tone = 'mint', style }) {
  return (
    <View style={[styles.tag, tone === 'outline' && styles.tagOutline, tone === 'muted' && styles.tagMuted, style]}>
      <Text style={[styles.tagText, tone !== 'mint' && { color: colors.muted }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function IconTile({ icon, size = 36, iconSize = 20, color = colors.mintDark, bg = colors.mintSoft, style }) {
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: bg }, style]}>
      <Icon name={icon} size={iconSize} color={color} />
    </View>
  );
}

export function DashedButton({ label, onPress, style }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.dashed, pressed && { backgroundColor: colors.mintSoft }, style]}>
      <Icon name="plus" size={17} color={colors.muted} />
      <Text style={styles.dashedText}>{label}</Text>
    </Pressable>
  );
}

export function StatBox({ icon, label, value, onPress, style }) {
  const body = (
    <>
      <Icon name={icon} size={20} color={colors.mintDark} />
      <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </>
  );
  if (!onPress) return <View style={[styles.stat, style]}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${value}`} onPress={onPress} style={({ pressed }) => [styles.stat, pressed && { backgroundColor: colors.mintSoft }, style]}>
      {body}
    </Pressable>
  );
}

export const uiStyles = StyleSheet.create({
  // 화면 공통 여백 (시안: 좌우 16)
  screenPad: { paddingHorizontal: spacing.lg },
  sectionLabel: { fontSize: font.caption, fontWeight: '500', color: colors.muted },
});

const styles = StyleSheet.create({
  inlineDelete: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  inlineDeleteQuestion: { flex: 1, fontSize: font.caption, color: colors.muted },
  inlineDeleteButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  inlineDeleteText: { fontSize: font.caption, fontWeight: '600', color: colors.coral },
  circle: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent', borderWidth: 0, borderColor: colors.line },
  badgeDot: { position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.coral, borderWidth: 1, borderColor: colors.white },
  dock: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 16, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  dockButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  // Stella 주요 버튼(features/stella/theme.js primary·secondary)과 같은 4px 모서리
  pill: { minHeight: 44, paddingHorizontal: 18, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  pillPrimary: { backgroundColor: colors.action },
  // 머리글 오른쪽 동작(저장·완료): Notion처럼 면 없는 글자 버튼
  pillTextOnly: { paddingHorizontal: 8, minWidth: 44 },
  pillGhost: { backgroundColor: 'transparent', borderWidth: 0, borderColor: colors.actionBorder },
  pillText: { fontSize: 14, fontWeight: '600' },
  card: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, padding: spacing.lg },
  // 선택 전 칩은 면 없이 흐린 글자, 선택된 칩만 낮은 대비의 면으로 표시한다(밝은 채움 금지).
  chip: { minHeight: 44, marginRight: 20, justifyContent: 'center' },
  chipActive: {},
  chipText: { fontSize: 12, color: colors.muted },
  chipTextActive: { color: colors.ink, fontWeight: '700' },
  tag: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, backgroundColor: colors.mintSoft },
  tagOutline: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
  tagMuted: { backgroundColor: colors.raised, borderRadius: radius.pill },
  tagText: { fontSize: font.caption, fontWeight: '500', color: colors.mintDark },
  tile: { alignItems: 'center', justifyContent: 'center' },
  // '+ 추가' 행: Notion의 새 페이지 행처럼 흐린 글자, 누를 때만 면 표시
  dashed: { flexDirection: 'row', gap: 8, minHeight: 44, borderRadius: radius.md, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'flex-start' },
  dashedText: { fontSize: 14, fontWeight: '500', color: colors.muted },
  stat: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, backgroundColor: colors.card },
  statLabel: { flex: 1, fontSize: font.body, color: colors.muted },
  statValue: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
});
