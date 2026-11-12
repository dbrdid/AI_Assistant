// ============================================================
// ProjectInviteScreen.js — 팀원 초대 (스토리보드 74장)
// ============================================================
// route.params: { projectId }
// 입력: 이메일(형식 검사) / 초대 방법(링크 · 메일) / 초대할 프로젝트 이름 표시 / 이번 달 남은 초대 횟수
// 남은 횟수가 0 이면 발송이 막힙니다.
// ※ 지금은 "초대 기록"만 저장합니다 (프로젝트 팀원 화면의 초대 대기에 표시). 실제 메일·링크 발송과
//   초대 수락(스토리보드 75장)은 서버가 준비되면 sendInvite 자리에 연결합니다.

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { MONTHLY_INVITES, addInvite, getProject, invitesLeft, isEmail, useProjects } from '../../../data/projects/ProjectStore';

const METHODS = ['메일', '링크'];

export default function InviteScreen({ navigation, route }) {
  const projectId = route?.params?.projectId;
  useProjects(); // 남은 횟수가 바뀌면 다시 그리기
  const project = getProject(projectId);
  const [email, setEmail] = useState('');
  const [method, setMethod] = useState('메일');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const left = invitesLeft();

  const send = () => {
    if (left <= 0) return setError('이번 달 초대 횟수를 모두 사용했어요.');
    if (method === '메일' && !isEmail(email)) return setError('이메일 형식이 올바르지 않아요. 예) name@example.com');
    setError('');
    // TODO(서버): 여기에서 실제 초대 메일/링크를 발송
    addInvite(projectId, { email: method === '메일' ? email : '', method });
    setSent(true);
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="팀원 초대" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.field}>
          <Text style={styles.label}>초대할 프로젝트</Text>
          <View style={styles.box}><Text style={styles.boxText}>{project ? project.title : '프로젝트를 찾을 수 없어요'}</Text></View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>초대 방법</Text>
          <View style={styles.chipRow}>
            {METHODS.map((m) => (
              <Pressable key={m} accessibilityRole="button" accessibilityState={{ selected: method === m }} onPress={() => setMethod(m)} style={[styles.chip, method === m && styles.chipOn]}>
                <Text style={[styles.chipText, method === m && { color: colors.white, fontWeight: '800' }]}>{m}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {method === '메일' && (
          <View style={styles.field}>
            <Text style={styles.label}>이메일</Text>
            <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="name@example.com" placeholderTextColor={colors.muted} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} accessibilityLabel="초대할 이메일" />
          </View>
        )}

        <View style={styles.warn}>
          <Text style={styles.warnText}>현재 요금제로 팀원 한도 또는 초대 횟수가 초과되어 초대가 제한될 수 있습니다</Text>
          <Text style={styles.left}>이번 달 남은 초대 횟수 {left} / {MONTHLY_INVITES}회</Text>
        </View>

        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

        <Pressable accessibilityRole="button" disabled={!project} onPress={send} style={[styles.send, (!project || left <= 0) && { opacity: 0.5 }]}>
          <Text style={styles.sendText}>발송</Text>
        </Pressable>
      </ScrollView>

      <ConfirmDialog
        visible={sent}
        title="초대를 기록했어요"
        sub="실제 메일·링크 발송은 서버가 연결된 뒤에 지원돼요. 팀원 화면의 '초대 대기'에서 볼 수 있어요."
        confirmText="확인"
        onCancel={() => setSent(false)}
        onConfirm={() => {
          setSent(false);
          navigation.goBack();
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  field: { gap: spacing.sm },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  box: { minHeight: 46, borderRadius: radius.md, backgroundColor: colors.mintSoft, borderWidth: 1, borderColor: colors.mint, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  boxText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.mintDark },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: { minHeight: 40, paddingHorizontal: spacing.xl, borderRadius: 20, justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  warn: { gap: spacing.sm, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  warnText: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  left: { fontSize: font.body, fontWeight: '800', color: colors.ink },
  error: { fontSize: font.body, fontWeight: '700', color: colors.coral },
  send: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  sendText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
});
