// ============================================================
// TabBar.js — 선택한 화면의 이름을 펼치는 하단 탐색
// ============================================================

import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../shared/components/Icon';
import { useInsets } from '../shared/hooks/useInsets';

import { TABS } from './routes';
import { palette } from '../features/stella/theme';

export const TAB_BAR_HEIGHT = 56;

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
export default function TabBar({ current, onSelect }) {
  const insets = useInsets();
  return <View accessibilityRole="tablist" accessibilityLabel="주 탐색"
    style={[styles.bar, { height: TAB_BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom }]}>
    {TABS.map(item => <NavigationTab key={item.route} item={item} selected={item.route === current} onSelect={onSelect} />)}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 6, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: palette.line, backgroundColor: palette.background },
  tab: { minHeight: 44, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 6, backgroundColor: 'transparent' },
  selected: { backgroundColor: palette.raised },
  expandedContent: { position: 'absolute', alignSelf: 'center', width: 180, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  label: { flexShrink: 0, color: palette.text, fontSize: 13, fontWeight: '600' },
});
