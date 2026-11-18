// 아래에서 위로 올라오는 창 (AI 채팅의 업로드된 파일 목록)
//   top: 창의 위쪽 끝 (AI 채팅 머리글 바로 아래까지 올라오게 머리글 높이를 넘겨 받음)
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { CircleButton } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

export default function UpSheet({ visible, top = 0, title, onClose, children }) {
  const { height: screen } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const height = Math.max(240, screen - top);
  const y = useRef(new Animated.Value(height)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      y.setValue(height);
      Animated.parallel([
        Animated.timing(y, { toValue: 0, duration: 260, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(y, { toValue: height, duration: 200, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: fade }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="창 닫기" />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[styles.sheet, { height, paddingBottom: insets.bottom + spacing.lg, transform: [{ translateY: y }] }]}
        >
          <View style={styles.grip} />
          <View style={styles.head}>
            <Text style={styles.title} accessibilityRole="header">{title}</Text>
            <CircleButton icon="x" label="닫기" onPress={onClose} size={36} iconSize={18} />
          </View>
          <View style={styles.body}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(38,57,53,0.35)' },
  sheet: { backgroundColor: colors.cream, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, paddingHorizontal: spacing.lg, borderTopWidth: 1, borderColor: colors.line },
  grip: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginTop: spacing.sm, marginBottom: spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  title: { flexShrink: 1, fontSize: font.header + 1, fontWeight: '800', color: colors.ink },
  body: { flex: 1, gap: spacing.sm },
});
