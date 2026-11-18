// ============================================================
// AuthUi.js — 로그인/가입 화면들이 같이 쓰는 부품 (Figma 'Stella 앱 시안' 스타일)
// ============================================================


import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { colors, font, radius, shadow, spacing, FILL } from '../../../shared/theme/theme';
import Icon from '../../../shared/components/Icon';
import { CircleButton } from '../../../shared/components/Ui';

export function AuthFrame({ title, subtitle, onBack, hero, children }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
      {onBack ? (
        <View style={styles.back}>
          <CircleButton icon="chevronLeft" label="뒤로 가기" onPress={onBack} />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]} keyboardShouldPersistTaps="handled">
        {hero}
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// 로그인 화면 위쪽의 앱 로고: 민트 그라데이션 원 + 반짝임 아이콘
export function AuthLogo() {
  return (
    <View style={styles.logo} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={64} height={64} style={FILL}>
        <Defs>
          <LinearGradient id="authLogo" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.mint} />
            <Stop offset="1" stopColor={colors.mintDark} />
          </LinearGradient>
        </Defs>
        <Circle cx={32} cy={32} r={32} fill="url(#authLogo)" />
      </Svg>
      {/* 웹에서는 absolute 배경이 아이콘 위에 그려지므로 아이콘을 한 층 위로 */}
      <View style={{ zIndex: 1 }}>
        <Icon name="sparkles" size={28} color={colors.white} />
      </View>
    </View>
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
          <Pressable accessibilityRole="button" accessibilityLabel={show ? '비밀번호 숨기기' : '비밀번호 보기'} onPress={() => setShow((v) => !v)} hitSlop={10}>
            <Icon name={show ? 'eyeOff' : 'eye'} size={20} color={colors.muted} />
          </Pressable>
        )}
      </View>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

// kind: 'primary'(진한 녹색) | 'ghost'(흰 바탕) | 'outline'(녹색 테두리) | 'kakao'(노랑)
export function AuthButton({ label, onPress, kind = 'primary', disabled, busy, icon }) {
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
      {!!icon && !busy && <Icon name={icon} size={20} color={tone.text} />}
      <Text style={[styles.btnText, { color: tone.text }]}>{busy ? '잠시만요…' : label}</Text>
    </Pressable>
  );
}

const BUTTON_TONES = {
  primary: { box: { backgroundColor: colors.mintDark }, text: colors.white },
  ghost: { box: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, text: colors.ink },
  outline: { box: { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.mintDark }, text: colors.mintDark },
  kakao: { box: { backgroundColor: colors.kakao }, text: '#191600' },
};

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
  back: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, alignItems: 'flex-start' },
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.lg },
  logo: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginTop: spacing.xl, ...shadow.float },
  title: { fontSize: 26, lineHeight: 36, fontWeight: '800', color: colors.ink },
  subtitle: { fontSize: font.body, color: colors.muted, lineHeight: 21, marginTop: -spacing.sm },
  label: { fontSize: 13, fontWeight: '700', color: colors.ink },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 52, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  input: { flex: 1, fontSize: font.bodyLg, color: colors.ink, paddingVertical: 10, outlineStyle: 'none' },
  hint: { fontSize: font.caption, color: colors.muted },
  btn: { flexDirection: 'row', gap: spacing.sm, minHeight: 54, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  btnPrimary: { backgroundColor: colors.mintDark },
  btnText: { fontSize: font.bodyLg, fontWeight: '800' },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  dTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  dMsg: { fontSize: font.body, color: colors.muted, lineHeight: 21 },
});
