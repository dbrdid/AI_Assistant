// ============================================================
// TabBar.js — 선택한 화면의 이름을 펼치는 상단 탐색
// ============================================================

import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../shared/components/Icon';

import { TABS } from './routes';
import { palette } from '../features/stella/theme';

function NavigationTab({ item, selected, onSelect }) {
  const width = useRef(new Animated.Value(selected ? 2.6 : 1)).current;

  useEffect(() => {
    const motion = Animated.timing(width, { toValue: selected ? 2.6 : 1, duration: 220, useNativeDriver: false });
    motion.start();
    return () => motion.stop();
  }, [selected, width]);
  const labelOpacity = width.interpolate({
    inputRange: [1, 1.85, 2.6], outputRange: [0, 0, 1], extrapolate: 'clamp',
  });
  const iconOpacity = Animated.subtract(1, labelOpacity);
  return <Animated.View style={{ flex: width, minWidth: 44 }}><Pressable
    accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected }} aria-selected={selected}
    onPress={() => onSelect(item.route)}
    style={({ pressed }) => [styles.tab, selected && styles.selected, pressed && { opacity: .6 }]}>
    <Animated.View pointerEvents="none" style={{ opacity: iconOpacity }}>
      <Icon name={item.icon} size={18} color={palette.subtle} strokeWidth={1.6} />
    </Animated.View>
    <Animated.View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants"
      style={[styles.expandedContent, { opacity: labelOpacity }]}>
      <Icon name={item.icon} size={18} color={palette.text} strokeWidth={2.1} />
      <Text style={styles.label}>{item.label}</Text>
    </Animated.View>
  </Pressable></Animated.View>;
}
// preview: 길게 눌러 좌우로 고르는 중인 탭. 고르는 동안 막대에 테두리를 두르고 그 탭을 펼친다
export default function TabBar({ current, preview, onSelect }) {
  const shown = preview ?? current;
  return <View accessibilityRole="tablist" accessibilityLabel="주 탐색" style={[styles.bar, preview && styles.picking]}>
    {TABS.map(item => <NavigationTab key={item.route} item={item} selected={item.route === shown} onSelect={onSelect} />)}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 26, borderWidth: 1, borderColor: 'transparent' },
  picking: { borderColor: palette.muted },
  tab: { minHeight: 44, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 6, backgroundColor: 'transparent' },
  selected: { backgroundColor: palette.raised },
  expandedContent: { position: 'absolute', alignSelf: 'center', width: 180, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  label: { flexShrink: 0, color: palette.text, fontSize: 13, fontWeight: '600' },
});
