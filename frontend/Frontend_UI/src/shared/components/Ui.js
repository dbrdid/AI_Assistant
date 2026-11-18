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
      style={({ pressed }) => [styles.pill, primary ? styles.pillPrimary : styles.pillGhost, pressed && { opacity: 0.8 }, disabled && { opacity: 0.4 }, style]}
    >
      <Text style={[styles.pillText, { color: primary ? colors.white : colors.ink }]}>{label}</Text>
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
      style={({ pressed }) => [styles.card, dim && { opacity: 0.7 }, pressed && { backgroundColor: '#F7FBF9' }, style]}
    >
      {children}
    </Pressable>
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
      <Text style={[styles.chipText, active && { color: colors.white }]} numberOfLines={1}>{label}</Text>
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
      <Icon name="plus" size={18} color={colors.mintDark} />
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
  sectionLabel: { fontSize: font.caption, fontWeight: '700', color: colors.muted },
});

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  badgeDot: { position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.coral, borderWidth: 1, borderColor: colors.white },
  pill: { minHeight: 40, paddingHorizontal: 18, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  pillPrimary: { backgroundColor: colors.mintDark },
  pillGhost: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  pillText: { fontSize: font.body, fontWeight: '800' },
  card: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: spacing.lg },
  chip: { minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  tag: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.mintSoft },
  tagOutline: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill },
  tagMuted: { backgroundColor: '#E6ECEA', borderRadius: radius.pill },
  tagText: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
  tile: { alignItems: 'center', justifyContent: 'center' },
  dashed: { flexDirection: 'row', gap: 6, minHeight: 50, borderRadius: radius.card, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  dashedText: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  stat: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, paddingHorizontal: spacing.md, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.cream },
  statLabel: { flex: 1, fontSize: font.body, color: colors.muted },
  statValue: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
});
