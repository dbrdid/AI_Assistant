// ============================================================
// AuthUi.js — 로그인/가입 화면들이 같이 쓰는 부품 (Figma 'Stella 앱 시안' 스타일)
// ============================================================


import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import Icon from '../../../shared/components/Icon';
import { CircleButton } from '../../../shared/components/Ui';

export function AuthFrame({ title, subtitle, onBack, children }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
      {onBack ? (
        <View style={styles.back}>
          <CircleButton icon="chevronLeft" label="뒤로 가기" onPress={onBack} />
        </View>
      ) : null}
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>Atria</Text>
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function AuthField({ label, value, onChangeText, secure, hint, keyboardType, autoCapitalize = 'none', placeholder, maxLength, editable = true, icon }) {
  const [show, setShow] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, !editable && { opacity: 0.6 }]}>
        {!!icon && <Icon name={icon} size={20} color={colors.muted} />}
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
          <Pressable accessibilityRole="button" accessibilityLabel={show ? '비밀번호 숨기기' : '비밀번호 보기'} onPress={() => setShow((v) => !v)} style={{minWidth:44,minHeight:44,alignItems:"center",justifyContent:"center",marginRight:-12}}>
            <Icon name={show ? 'eyeOff' : 'eye'} size={20} color={colors.muted} />
          </Pressable>
        )}
      </View>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

// kind: 'primary'(진한 녹색) | 'ghost'(흰 바탕) | 'outline'(녹색 테두리) | 'kakao'(노랑)
export function AuthButton({ label, onPress, kind = 'primary', disabled, busy, icon, logo }) {
  const off = disabled || busy;
  const tone = BUTTON_TONES[kind] || BUTTON_TONES.ghost;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.btn, tone.box, pressed && { opacity: 0.85 }, off && { opacity: 0.5 }]}
    >
      {!!logo && !busy && logo}
      {!!icon && !busy && <Icon name={icon} size={20} color={tone.text} />}
      <Text style={[styles.btnText, { color: tone.text }]}>{busy ? '잠시만요…' : label}</Text>
    </Pressable>
  );
}

const BUTTON_TONES = {
  primary: { box: { backgroundColor: colors.action }, text: colors.onPrimary },
  ghost: { box: { backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line }, text: colors.ink },
  outline: { box: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line }, text: colors.mintDark },
  // 소셜 로그인: 각 회사 버튼 가이드 색 (Google 흰색, 카카오 노란색 #FEE500)
  google: { box: { backgroundColor: '#131314', borderWidth: 1, borderColor: '#8E918F' }, text: '#E3E3E3' },
  kakao: { box: { backgroundColor: colors.kakao }, text: 'rgba(0,0,0,0.85)' },
};

// dialog: { icon, title, message } 또는 null
export function AuthDialog({ dialog, onConfirm }) {
  return (
    <Modal transparent visible={!!dialog} animationType="fade" onRequestClose={onConfirm}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>
          {dialog && (
            <>
              <Text style={styles.dTitle}>{dialog.title}</Text>
              <Text style={styles.dMsg}>{dialog.message}</Text>
              <Pressable accessibilityRole="button" onPress={onConfirm} style={[styles.btn, styles.btnPrimary, { marginTop: spacing.sm }]}>
                <Text style={[styles.btnText, { color: colors.onPrimary }]}>확인</Text>
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
  back: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, alignItems: 'flex-start' },
  content: {width:'100%',maxWidth:420,alignSelf:'center',paddingHorizontal:28,paddingTop:28,gap:18},
  brand: { fontSize: 15, fontWeight: '600', color: colors.muted, letterSpacing: 0.2, marginBottom: -10 },
  title: { fontSize: 24, lineHeight: 32, fontWeight: '600', color: colors.ink },
  subtitle: { fontSize: font.body, color: colors.muted, lineHeight: 21, marginTop: -spacing.sm },
  label: { fontSize: 13, fontWeight: '500', color: colors.ink },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 46, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line },
  input: { flex: 1, fontSize: font.bodyLg, color: colors.ink, paddingVertical: 10, outlineStyle: 'none' },
  hint: { fontSize: font.caption, color: colors.muted },
  btn: { flexDirection: 'row', gap: spacing.sm, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  btnPrimary: { backgroundColor: colors.action },
  btnText: { fontSize: font.bodyLg, fontWeight: '500' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  dTitle: { fontSize: font.title, fontWeight: '600', color: colors.ink },
  dMsg: { fontSize: font.body, color: colors.muted, lineHeight: 21 },
});
