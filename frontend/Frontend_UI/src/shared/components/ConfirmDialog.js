// ============================================================
// ConfirmDialog.js — "~하시겠습니까?" 확인 창 (취소 / 확인)
// ============================================================


import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme/theme';

export default function ConfirmDialog({ visible, title, sub, confirmText = '확인', danger, onCancel, onConfirm }) {
  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text style={styles.title}>{title}</Text>
          {!!sub && <Text style={styles.sub}>{sub}</Text>}
          <View style={styles.buttons}>
            <Pressable accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}>
              <Text style={styles.cancelText}>취소</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onConfirm} style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}>
              <Text style={[styles.confirmText, danger && { color: colors.coral }]}>{confirmText}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  // 앱의 시트·메뉴처럼 테두리 없는 어두운 면, 버튼은 글자만
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.card, borderRadius: 12, paddingTop: spacing.xl, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm, gap: spacing.sm },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.muted, lineHeight: 19 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  btn: { minHeight: 44, minWidth: 56, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontSize: 15, color: colors.muted },
  confirmText: { fontSize: 15, fontWeight: '600', color: colors.ink },
});
