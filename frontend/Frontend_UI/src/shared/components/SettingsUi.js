// ============================================================
// SettingsUi.js — 설정 화면들이 같이 쓰는 작은 부품
// ============================================================
//   Group     : 여러 줄을 묶고 줄 사이에 얇은 구분선 (Notion 설정처럼 상자 없이 평평하게)
//   Row       : 아이콘 + 이름 + 값 + › 한 줄
//   ToggleRow : 켜고 끄는 스위치 한 줄
//   Radio     : 동그란 선택 표시 (◉ ○ 대신)

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Icon from './Icon';
import { colors, font, radius, spacing } from '../theme/theme';
import { useInsets } from '../hooks/useInsets';

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
  // 구분선은 글자 시작점부터: 아이콘 열(4 + 18 + 12)을 비워 둔다.
  return <View pointerEvents="none" style={[styles.divider, { left: icon ? 4 + 18 + 12 : 4 }]} />;
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
        <Icon name={icon} size={18} color={danger ? colors.coral : colors.muted}/>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowLabel, danger && { color: colors.coral }]}>{label}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      {value !== undefined && <Text style={styles.rowValue}>{value}</Text>}
      {onPress && <Icon name="chevronRight" size={14} color={colors.muted} />}
    </>
  );
  if (!onPress) return <View style={[styles.row, frame]}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.row, frame, pressed && { backgroundColor: colors.raised }]}>
      {body}
    </Pressable>
  );
}

export function ToggleRow({ label, sub, value, onValueChange, disabled, icon }) {
  const { first, frame } = useRowFrame();
  return (
    <View style={[styles.row, frame, disabled && { opacity: 0.5 }]}>
      {!first && <Divider icon={icon} />}
      {!!icon && <Icon name={icon} size={18} color={colors.muted}/>}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      <Switch
        accessibilityLabel={label}
        disabled={disabled}
        value={!!value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.raised, true: colors.subtle }}
        thumbColor={colors.ink}
      />
    </View>
  );
}

// 동그란 선택 표시. on 이면 안에 진한 녹색 점
export function Radio({ on, size = 22 }) {
  return (
    <View style={[styles.radio, { width: size, height: size, borderRadius: size / 2 }, on && { borderColor: colors.mintDark }]}>
      {on && <View style={{ width: size / 2, height: size / 2, borderRadius: size / 4, backgroundColor: colors.ink }} />}
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
  const insets = useInsets();
  const [text, setText] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (t) => {
    setText(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(''), 2400);
  };
  const view = text ? (
    <View pointerEvents="none" style={[styles.notice, { bottom: Math.max(spacing.xl, insets.bottom + spacing.md) }]}>
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  ) : null;
  return { show, view };
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const styles = StyleSheet.create({
  // Notion 설정·홈 개요처럼 상자 없이 평평한 행 + 얇은 구분선, 묶음 제목은 작고 흐리게
  sectionTitle: { fontSize: 12, fontWeight: '400', color: colors.muted, marginTop: 18, marginBottom: 2, marginLeft: 4 },
  group: {},
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingHorizontal: 4, paddingVertical: 10 },
  rowAlone: {},
  // Group 안의 줄: 카드는 Group 이 그림
  rowGrouped: { backgroundColor: 'transparent' },
  divider: { position: 'absolute', top: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  rowLabel: { fontSize: 15, fontWeight: '400', color: colors.ink },
  rowSub: { fontSize: font.caption, color: colors.muted, lineHeight: 17 },
  rowValue: { fontSize: 13, color: colors.muted },
  radio: { borderWidth: 2, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  save: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  saveText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.action, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.onPrimary, fontSize: font.body, textAlign: 'center' },
});
