// ============================================================
// SettingsUi.js — 설정 화면들이 같이 쓰는 작은 부품
// ============================================================
//   Group     : 여러 줄을 하나의 흰 카드로 묶고, 줄 사이에 얇은 구분선 (Figma 설정 시안)
//   Row       : 아이콘 타일 + 이름 + 값 + › 한 줄. Group 밖에서 쓰면 혼자서 카드 모양
//   ToggleRow : 켜고 끄는 스위치 한 줄
//   Radio     : 동그란 선택 표시 (◉ ○ 대신)

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Icon from './Icon';
import { IconTile } from './Ui';
import { colors, font, radius, spacing } from '../theme/theme';

// Group 안에 있는 줄인지, 첫 줄인지 알려 주는 통로 (null 이면 혼자 있는 줄)
const GroupCtx = createContext(null);

// Fragment(<>…</>)·배열·조건부(false) 를 풀어서 줄 목록으로 만듦
const flatten = (children) =>
  React.Children.toArray(children).flatMap((c) => (c && c.type === React.Fragment ? flatten(c.props.children) : [c]));

export function Group({ children, style }) {
  const items = flatten(children);
  if (!items.length) return null;
  return (
    <View style={[styles.group, style]}>
      {items.map((c, i) => (
        <GroupCtx.Provider key={c.key ?? i} value={{ first: i === 0 }}>
          {c}
        </GroupCtx.Provider>
      ))}
    </View>
  );
}

// 줄 위쪽 구분선: 아이콘이 있으면 아이콘 다음부터 시작
function Divider({ icon }) {
  return <View pointerEvents="none" style={[styles.divider, { left: icon ? spacing.lg + 32 + spacing.md : spacing.lg }]} />;
}

function useRowFrame() {
  const g = useContext(GroupCtx);
  return { grouped: !!g, first: !g || g.first, frame: g ? styles.rowGrouped : styles.rowAlone };
}

export function SectionTitle({ children }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Row({ label, value, onPress, danger, sub, icon }) {
  const { first, frame } = useRowFrame();
  const body = (
    <>
      {!first && <Divider icon={icon} />}
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
  if (!onPress) return <View style={[styles.row, frame]}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.row, frame, pressed && { backgroundColor: colors.mintSoft }]}>
      {body}
    </Pressable>
  );
}

export function ToggleRow({ label, sub, value, onValueChange, disabled, icon }) {
  const { first, frame } = useRowFrame();
  return (
    <View style={[styles.row, frame, disabled && { opacity: 0.5 }]}>
      {!first && <Divider icon={icon} />}
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
  sectionTitle: { fontSize: font.caption, fontWeight: '700', color: colors.muted, marginTop: spacing.md, marginLeft: spacing.xs },
  group: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 58, paddingHorizontal: spacing.lg, paddingVertical: 10 },
  // 혼자 있는 줄: 그대로 카드 모양
  rowAlone: { borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  // Group 안의 줄: 카드는 Group 이 그림
  rowGrouped: { backgroundColor: colors.card },
  divider: { position: 'absolute', top: 0, right: 0, height: 1, backgroundColor: colors.line },
  rowLabel: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  rowSub: { fontSize: font.caption, color: colors.muted, lineHeight: 17 },
  rowValue: { fontSize: font.body, color: colors.muted },
  radio: { borderWidth: 2, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  save: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  saveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.ink, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body, textAlign: 'center' },
});
