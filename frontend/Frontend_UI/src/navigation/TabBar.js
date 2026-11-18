// ============================================================
// TabBar.js — 화면 맨 아래 하단 탭 (오늘 · 메모 · 캘린더 · 할 일 · 더보기)
// ============================================================

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../shared/hooks/useInsets';
import Icon from '../shared/components/Icon';
import { colors, spacing } from '../shared/theme/theme';
import { TABS } from './routes';

export default function TabBar({ current, onSelect }) {
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {TABS.map((t) => {
        const on = t.route === current;
        const color = on ? colors.mintDark : colors.muted;
        return (
          <Pressable
            key={t.route}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(t.route)}
            style={({ pressed }) => [styles.tab, pressed && { opacity: 0.6 }]}
          >
            <Icon name={t.icon} size={22} color={color} strokeWidth={on ? 2.2 : 1.8} />
            <Text style={[styles.label, { color }, on && styles.labelOn]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream, paddingTop: 6 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 2 },
  label: { fontSize: 11, fontWeight: '600' },
  labelOn: { fontWeight: '800' },
});
