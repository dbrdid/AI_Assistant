// ============================================================
// AuthUi.js — 로그인/가입 화면들이 같이 쓰는 부품
// ============================================================
//  AuthFrame  : 제목 + 스크롤 + 키보드 피하기 (왼쪽 위 ‹ 뒤로가기는 onBack 이 있을 때만)
//  AuthField  : 라벨 + 입력칸 (비밀번호 칸은 👁 표시/숨김 버튼)
//  AuthButton : 큰 버튼 (primary / ghost)
//  AuthDialog : 오류·안내 창 (스토리보드의 ⚠ / 🔒 메시지)

import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

export function AuthFrame({ title, subtitle, onBack, children }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="뒤로 가기" onPress={onBack} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      ) : (
        <View style={styles.back} />
      )}
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function AuthField({ label, value, onChangeText, secure, hint, keyboardType, autoCapitalize = 'none', placeholder, maxLength, editable = true }) {
  const [show, setShow] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, !editable && { opacity: 0.6 }]}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          secureTextEntry={!!secure && !show}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          maxLength={maxLength}
          editable={editable}
          accessibilityLabel={label}
        />
        {!!secure && (
          <Pressable accessibilityRole="button" accessibilityLabel={show ? '비밀번호 숨기기' : '비밀번호 보기'} onPress={() => setShow((v) => !v)} hitSlop={10}>
            <Text style={styles.eye}>{show ? '🙈' : '👁'}</Text>
          </Pressable>
        )}
      </View>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

export function AuthButton({ label, onPress, kind = 'primary', disabled, busy }) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      disabled={off}
      onPress={onPress}
      style={[styles.btn, kind === 'primary' ? styles.btnPrimary : styles.btnGhost, off && { opacity: 0.5 }]}
    >
      <Text style={[styles.btnText, kind === 'primary' ? { color: colors.white } : { color: colors.ink }]}>{busy ? '잠시만요…' : label}</Text>
    </Pressable>
  );
}

// dialog: { icon, title, message } 또는 null
export function AuthDialog({ dialog, onConfirm }) {
  return (
    <Modal transparent visible={!!dialog} animationType="fade" onRequestClose={onConfirm}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>
          {dialog && (
            <>
              <Text style={styles.dTitle}>{dialog.icon ? `${dialog.icon}  ` : ''}{dialog.title}</Text>
              <Text style={styles.dMsg}>{dialog.message}</Text>
              <Pressable accessibilityRole="button" onPress={onConfirm} style={[styles.btn, styles.btnPrimary, { marginTop: spacing.sm }]}>
                <Text style={[styles.btnText, { color: colors.white }]}>확인</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  back: { width: 48, height: 40, paddingLeft: spacing.lg, justifyContent: 'center' },
  backText: { fontSize: 32, color: colors.ink, marginTop: -4 },
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.lg },
  title: { fontSize: 30, fontWeight: '800', color: colors.ink },
  subtitle: { fontSize: font.body, color: colors.muted, lineHeight: 21, marginTop: -spacing.sm },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  input: { flex: 1, fontSize: font.bodyLg, color: colors.ink, paddingVertical: 10 },
  eye: { fontSize: 20 },
  hint: { fontSize: font.caption, color: colors.muted },
  btn: { minHeight: 54, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  btnPrimary: { backgroundColor: colors.mintDark },
  btnGhost: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  btnText: { fontSize: font.bodyLg, fontWeight: '800' },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  dTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  dMsg: { fontSize: font.body, color: colors.muted, lineHeight: 21 },
});
