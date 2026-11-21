// ============================================================
// TabBar.js — 선택한 화면의 이름을 펼치는 상단 탐색
// ============================================================

import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../shared/components/Icon';
import { useReducedMotion } from '../shared/components/Motion';
import { TABS } from './routes';
import { palette } from '../features/stella/theme';

function NavigationTab({ item, selected, onSelect }) {
  const width = useRef(new Animated.Value(selected ? 2.6 : 1)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    const motion = Animated.timing(width, { toValue: selected ? 2.6 : 1, duration: reduced ? 0 : 220, useNativeDriver: false });
    motion.start();
    return () => motion.stop();
  }, [selected, reduced, width]);
  const color = selected ? palette.text : palette.subtle;
  return <Animated.View style={{ flex: width, minWidth: 44 }}><Pressable
    accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected }} aria-selected={selected}
    onPress={() => onSelect(item.route)}
    style={({ pressed }) => [styles.tab, selected && styles.selected, pressed && { opacity: .6 }]}>
    <Icon name={item.icon} size={18} color={color} strokeWidth={selected ? 2.1 : 1.6} />
    {selected && <Text numberOfLines={1} style={styles.label}>{item.label}</Text>}
  </Pressable></Animated.View>;
}
export default function TabBar({ current, onSelect }) {
  return <View accessibilityRole="tablist" accessibilityLabel="주 탐색" style={styles.bar}>
    {TABS.map(item => <NavigationTab key={item.route} item={item} selected={item.route === current} onSelect={onSelect} />)}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  tab: { minHeight: 44, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 6, backgroundColor: palette.surface },
  selected: { backgroundColor: palette.raised },
  label: { color: palette.text, fontSize: 13, fontWeight: '600' },
});
