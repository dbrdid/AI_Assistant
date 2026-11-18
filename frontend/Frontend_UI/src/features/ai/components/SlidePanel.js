// 오른쪽에서 왼쪽으로 밀려 들어오는 창 (AI 채팅의 이전 대화 · AI 설정)
//   폭: 화면의 1/4. 폰처럼 좁은 화면에서는 글이 읽히도록 최소 300 (화면보다 넓어지지 않게 화면의 90%까지)
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { CircleButton } from '../../../shared/components/Ui';
import { colors, font, spacing } from '../../../shared/theme/theme';

export default function SlidePanel({ visible, title, onClose, children }) {
  const { width: screen } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = Math.min(Math.max(screen / 4, 300), screen * 0.9);
  const x = useRef(new Animated.Value(width)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      x.setValue(width);
      Animated.parallel([
        Animated.timing(x, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(x, { toValue: width, duration: 180, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
    // 폭이 바뀌어도(화면 회전) 열림 상태만 따라감
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
          style={[styles.panel, { width, paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg, transform: [{ translateX: x }] }]}
        >
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
  root: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(38,57,53,0.35)' },
  panel: { height: '100%', backgroundColor: colors.cream, paddingHorizontal: spacing.lg, borderLeftWidth: 1, borderLeftColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  title: { flexShrink: 1, fontSize: font.header + 1, fontWeight: '800', color: colors.ink },
  body: { flex: 1, gap: spacing.sm },
});
