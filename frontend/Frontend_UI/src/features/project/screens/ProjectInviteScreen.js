// ============================================================
// ProjectInviteScreen.js — 팀원 초대 
// ============================================================

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { addInvite, getProject, isEmail, useInviteQuota, useProjects } from '../../../data/projects/ProjectStore';
import { useWorkspaces } from '../../../data/workspaces/WorkspaceStore';

// 웹은 공유 창이 없을 수 있어 클립보드로 복사
async function shareText(message) {
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && navigator.share) return navigator.share({ text: message });
    if (typeof navigator !== 'undefined' && navigator.clipboard) return navigator.clipboard.writeText(message);
    return undefined;
  }
  return Share.share({ message });
}

const METHODS = ['메일', '링크'];

export default function InviteScreen({ navigation, route }) {
  const projectId = route?.params?.projectId;
  useProjects(); // 남은 횟수가 바뀌면 다시 그리기
  const project = getProject(projectId);
  const [email, setEmail] = useState('');
  const [method, setMethod] = useState('메일');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null); // 만든 초대 { code, shareText, mailed, mailError }
  const [busy, setBusy] = useState(false);
  const { current } = useWorkspaces();
  const quota = useInviteQuota();
  const loaded = !!quota;
  const left = quota ? quota.remaining : 0;
  const limit = quota ? quota.limit : 0;

  const send = async () => {
    if (busy) return;
    if (current.personal) return setError('개인 공간의 프로젝트는 이 기기에만 있어서 초대할 수 없어요. 공유 공간에서 프로젝트를 만들어 주세요.');
    if (loaded && left <= 0) return setError('이번 달 초대 횟수를 모두 사용했어요.');
    if (method === '메일' && !isEmail(email)) return setError('이메일 형식이 올바르지 않아요. 예) name@example.com');
    setError('');
    setBusy(true);
    try {
      setSent(await addInvite(projectId, { email: method === '메일' ? email.trim() : '', method }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const sentSub = sent
    ? `${sent.mailed ? `${email.trim()} 주소로 초대 메일을 보냈어요.\n` : sent.mailError ? `메일은 보내지 못했어요: ${sent.mailError}\n` : ''}초대 코드: ${sent.code}\n받는 사람이 앱에서 [공간 참여]를 누르고 코드를 입력하면 돼요.`
    : '';

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
          <Text style={styles.left}>{loaded ? `이번 달 남은 초대 횟수 ${left} / ${limit}회` : '남은 초대 횟수를 불러오는 중…'}</Text>
        </View>

        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

        <Pressable accessibilityRole="button" disabled={!project || busy} onPress={send} style={[styles.send, (!project || busy || (loaded && left <= 0)) && { opacity: 0.5 }]}>
          <Text style={styles.sendText}>{busy ? '초대 만드는 중…' : method === '메일' ? '초대 메일 보내기' : '초대 링크 만들기'}</Text>
        </Pressable>
      </ScrollView>

      <ConfirmDialog
        visible={!!sent}
        title="초대를 만들었어요"
        sub={sentSub}
        confirmText="초대 문구 공유"
        onCancel={() => {
          setSent(null);
          navigation.goBack();
        }}
        onConfirm={async () => {
          try { await shareText(sent.shareText); } catch { /* 공유 창을 닫음 */ }
          setSent(null);
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
