// ============================================================
// PhotoStrip.js — 메모에 붙은 사진 줄 (메모 편집 화면 제목 아래)
// ============================================================

import React, { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { detachPhoto, useMemos } from '../../../data/memos/MemoStore';
import { useFiles } from '../../../data/files/FileStore';

export default function PhotoStrip({ memoId }) {
  const memos = useMemos();
  const files = useFiles();
  const [big, setBig] = useState(null); // 크게 볼 파일
  const memo = memos.find((m) => m.id === memoId);
  const photos = ((memo && memo.photos) || []).map((id) => files.find((f) => f.id === id)).filter(Boolean);
  if (photos.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {photos.map((f) => (
          <Pressable key={f.id} accessibilityRole="imagebutton" accessibilityLabel={`사진 ${f.name} 크게 보기`} onPress={() => setBig(f)}>
            <Image source={{ uri: f.uri }} style={styles.thumb} />
          </Pressable>
        ))}
      </ScrollView>

      <Modal transparent visible={!!big} animationType="fade" onRequestClose={() => setBig(null)}>
        <View style={styles.backdrop}>
          {big && <Image source={{ uri: big.uri }} style={styles.big} resizeMode="contain" accessibilityLabel={big.name} />}
          <View style={styles.btns}>
            <Pressable accessibilityRole="button" onPress={() => { detachPhoto(memoId, big.id); setBig(null); }} style={[styles.btn, styles.ghost]}>
              <Text style={styles.ghostText}>메모에서 빼기</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setBig(null)} style={[styles.btn, styles.main]}>
              <Text style={styles.mainText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: spacing.sm },
  row: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  thumb: { width: 72, height: 72, borderRadius: radius.sm, backgroundColor: colors.line },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.lg },
  big: { width: '100%', height: '75%' },
  btns: { flexDirection: 'row', gap: spacing.sm, width: '100%', maxWidth: 360 },
  btn: { flex: 1, minHeight: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  ghost: { backgroundColor: colors.white },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.coral },
  main: { backgroundColor: colors.mintDark },
  mainText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
});
