// ============================================================
// SettingsUi.js — 설정 화면들이 같이 쓰는 작은 부품
// ============================================================
//   Group     : 여러 줄을 하나의 흰 카드로 묶고, 줄 사이에 얇은 구분선 (Figma 설정 시안)
//   Row       : 아이콘 타일 + 이름 + 값 + › 한 줄. Group 밖에서 쓰면 혼자서 카드 모양
//   ToggleRow : 켜고 끄는 스위치 한 줄
//   Radio     : 동그란 선택 표시 (◉ ○ 대신)

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Icon from './Icon';
import { IconTile } from './Ui';
import { colors, font, radius, spacing } from '../theme/theme';

// Fragment(<>…</>)·배열·조건부(false) 를 풀어서 줄 목록으로 만듦
const flatten = (children) =>
  React.Children.toArray(children).flatMap((c) => (c && c.type === React.Fragment ? flatten(c.props.children) : [c]));

export function Group({ children, style }) {
  const items = flatten(children);
  if (!items.length) return null;
  return <View style={[styles.group, style]}>{items}</View>;
}

export function SectionTitle({ children }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Row({ label, value, onPress, danger, sub, icon }) {
  const body = (
    <>
      {!!icon && (
        <IconTile
          icon={icon}
          size={32}
          iconSize={18}
          bg={danger ? colors.coralSoft : colors.mintSoft}
          color={danger ? colors.coral : colors.mintDark}
        />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowLabel, danger && { color: colors.coral }]}>{label}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      {value !== undefined && <Text style={styles.rowValue}>{value}</Text>}
      {onPress && <Icon name="chevronRight" size={18} color={colors.muted} />}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.mintSoft }]}>
      {body}
    </Pressable>
  );
}

export function ToggleRow({ label, sub, value, onValueChange, disabled, icon }) {
  return (
    <View style={[styles.row, disabled && { opacity: 0.5 }]}>
      {!!icon && <IconTile icon={icon} size={32} iconSize={18} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      <Switch
        accessibilityLabel={label}
        disabled={disabled}
        value={!!value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.line, true: colors.mint }}
        thumbColor={colors.white}
      />
    </View>
  );
}

// 동그란 선택 표시. on 이면 안에 진한 녹색 점
export function Radio({ on, size = 22 }) {
  return (
    <View style={[styles.radio, { width: size, height: size, borderRadius: size / 2 }, on && { borderColor: colors.mintDark }]}>
      {on && <View style={{ width: size / 2, height: size / 2, borderRadius: size / 4, backgroundColor: colors.mintDark }} />}
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
  group: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  rowLabel: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  rowSub: { fontSize: font.caption, color: colors.muted, lineHeight: 17 },
  rowValue: { fontSize: font.body, color: colors.muted },
  radio: { borderWidth: 2, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  save: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  saveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.ink, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body, textAlign: 'center' },
});
