// ============================================================
// SettingsUi.js — 설정 화면들이 같이 쓰는 작은 부품
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../theme/theme';

export function SectionTitle({ children }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Row({ label, value, onPress, danger, sub }) {
  const body = (
    <>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowLabel, danger && { color: colors.coral }]}>{label}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      {value !== undefined && <Text style={styles.rowValue}>{value}</Text>}
      {onPress && <Text style={styles.chev}>›</Text>}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.mintSoft }]}>
      {body}
    </Pressable>
  );
}

export function ToggleRow({ label, sub, value, onValueChange }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      <Switch
        accessibilityLabel={label}
        value={!!value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.line, true: colors.mint }}
        thumbColor={colors.white}
      />
    </View>
  );
}

export function SaveButton({ onPress, disabled, label = '저장하기' }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.save, disabled && { opacity: 0.4 }]}
    >
      <Text style={styles.saveText}>{label}</Text>
    </Pressable>
  );
}

export function useNotice() {
  const [text, setText] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (t) => {
    setText(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(''), 2400);
  };
  const view = text ? (
    <View pointerEvents="none" style={styles.notice}>
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  ) : null;
  return { show, view };
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const styles = StyleSheet.create({
  sectionTitle: { fontSize: font.caption, fontWeight: '800', color: colors.muted, marginTop: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  rowLabel: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  rowSub: { fontSize: font.caption, color: colors.muted, lineHeight: 17 },
  rowValue: { fontSize: font.body, color: colors.muted },
  chev: { fontSize: 22, color: colors.muted },
  save: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  saveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.ink, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body, textAlign: 'center' },
});
