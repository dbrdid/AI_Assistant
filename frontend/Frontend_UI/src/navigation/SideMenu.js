import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../shared/hooks/useInsets';
import { useWorkspaces } from '../data/workspaces/WorkspaceStore';
import { colors, font, radius, spacing, FILL } from '../shared/theme/theme';

export default function SideMenu({ visible, onClose, onNavigate, currentRoute, sections }) {
  const { width: screenWidth } = useWindowDimensions();
  const panelWidth = Math.min(screenWidth * 0.8, 320);
  const insets = useSafeAreaInsets();
  const { current } = useWorkspaces();
  const x = useRef(new Animated.Value(-panelWidth)).current;
  const animation = useRef(null);
  const mountedRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (animation.current) animation.current.stop();
    if (visible) {
      mountedRef.current = true;
      setMounted(true);
      x.setValue(-panelWidth);
      animation.current = Animated.timing(x, { toValue: 0, duration: 220, useNativeDriver: true });
    } else if (mountedRef.current) {
      animation.current = Animated.timing(x, { toValue: -panelWidth, duration: 180, useNativeDriver: true });
      animation.current.start(({ finished }) => {
        if (finished) {
          mountedRef.current = false;
          setMounted(false);
        }
      });
    }
    if (visible && animation.current) animation.current.start();
    return () => {
      if (animation.current) animation.current.stop();
    };
  }, [visible, panelWidth, x]);

  if (!mounted) return null;

  const go = (route) => {
    onClose();
    if (route !== currentRoute) onNavigate(route);
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="메뉴 닫기" />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.panel, { width: panelWidth, paddingTop: insets.top + spacing.lg, transform: [{ translateX: x }] }]}
        >
          <Text style={styles.heading}>메뉴</Text>
          <Text style={styles.space} numberOfLines={1}>현재 공간 · {current.name}</Text>
          <ScrollView style={styles.list} contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.lg }]}>
            {sections.map((section) => (
              <View key={section.title} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.items.map((item) => {
                  const active = item.route === currentRoute;
                  return (
                    <Pressable
                      key={item.route}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => go(item.route)}
                      style={({ pressed }) => [styles.item, (active || pressed) && styles.itemActive]}
                    >
                      <Text style={[styles.itemText, active && styles.itemTextActive]}>{item.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  backdrop: { ...FILL, backgroundColor: 'rgba(38,57,53,0.4)' },
  panel: { height: '100%', paddingHorizontal: spacing.lg, backgroundColor: colors.cream },
  heading: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  space: { marginTop: spacing.xs, fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
  list: { marginTop: spacing.lg },
  listContent: { gap: spacing.md },
  section: { gap: spacing.xs },
  sectionTitle: { marginHorizontal: spacing.md, marginBottom: spacing.xs, fontSize: font.caption, fontWeight: '800', color: colors.muted },
  item: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.md },
  itemActive: { backgroundColor: colors.mintSoft },
  itemText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  itemTextActive: { color: colors.mintDark, fontWeight: '800' },
});
