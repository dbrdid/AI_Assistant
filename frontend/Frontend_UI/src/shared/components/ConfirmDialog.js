// ============================================================
// ConfirmDialog.js — "~하시겠습니까?" 확인 창 (취소 / 확인)
// ============================================================
// props
//   visible       : 보일지 여부
//   title, sub    : 제목 / 보조 설명
//   confirmText   : 확인 버튼 글자 (기본 "확인")
//   danger        : true 면 확인 버튼이 코랄색(삭제처럼 위험한 동작)
//   onCancel(), onConfirm()

import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../theme/theme';

export default function ConfirmDialog({ visible, title, sub, confirmText = '확인', danger, onCancel, onConfirm }) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text style={styles.title}>{title}</Text>
          {!!sub && <Text style={styles.sub}>{sub}</Text>}
          <View style={styles.buttons}>
            <Pressable accessibilityRole="button" onPress={onCancel} style={[styles.btn, styles.cancel]}>
              <Text style={styles.cancelText}>취소</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onConfirm}
              style={[styles.btn, { backgroundColor: danger ? colors.coral : colors.mintDark }]}
            >
              <Text style={styles.confirmText}>{confirmText}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm },
  title: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  buttons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  btn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cancel: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  cancelText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  confirmText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.white },
});
