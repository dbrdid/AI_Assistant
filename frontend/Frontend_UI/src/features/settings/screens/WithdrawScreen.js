// ============================================================
// WithdrawScreen.js — 회원탈퇴 
// ============================================================


import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { deleteAccount, loadWithdrawPreview } from '../../../data/auth/AuthStore';
import { useNotice } from '../../../shared/components/SettingsUi';
import Icon from '../../../shared/components/Icon';
import { withdrawErrorMessage, withdrawPreviewText } from '../../../lib/stella/withdraw';

export default function WithdrawScreen({ navigation }) {
  const [agree, setAgree] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // 서버 미리 보기: 공간별로 삭제·넘김·나가기
  const [previewError, setPreviewError] = useState('');
  const notice = useNotice();

  useEffect(() => {
    let alive = true;
    loadWithdrawPreview()
      .then((rows) => alive && setPreview(rows))
      .catch((e) => alive && setPreviewError(withdrawErrorMessage(e)));
    return () => { alive = false; };
  }, []);

  return (
    <View style={styles.root}>
      <ScreenHeader title="회원탈퇴" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>탈퇴하면 이렇게 돼요</Text>
          <Text style={styles.line}>• 계정과 개인 공간의 메모·할 일·일정이 삭제돼요</Text>
          <Text style={styles.line}>• 삭제된 정보는 되돌릴 수 없어요</Text>
          <Text style={styles.line}>• 조직에 공유한 기록은 워크스페이스에 남아요</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.line}>• 이용 중인 요금제·백업·녹음은 탈퇴와 함께 삭제돼요</Text>
          <Text style={styles.line}>• 공유 공간에 남긴 기록의 작성자는 '탈퇴한 사용자'로 표시돼요</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>내 공유 공간은 이렇게 돼요</Text>
          {preview === null && !previewError && <ActivityIndicator color={colors.mintDark} style={{ alignSelf: 'flex-start' }} />}
          {!!previewError && <Text style={[styles.line, { color: colors.coral }]}>{previewError}</Text>}
          {preview && preview.length === 0 && <Text style={styles.line}>참여 중인 공유 공간이 없어요.</Text>}
          {preview && preview.map((p) => <Text key={p.workspace_id} style={styles.line}>• {withdrawPreviewText(p)}</Text>)}
        </View>

        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: agree }} onPress={() => setAgree((v) => !v)} style={styles.agree}>
          <Icon name={agree ? 'checkSquare' : 'square'} size={24} color={agree ? colors.mintDark : colors.muted} />
          <Text style={styles.agreeText}>위 내용을 확인했습니다</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !agree || !preview || busy }}
          disabled={!agree || !preview || busy}
          onPress={() => setConfirm(true)}
          style={[styles.danger, (!agree || !preview || busy) && { opacity: 0.4 }]}
        >
          <Text style={styles.dangerText}>{busy ? '탈퇴 처리 중…' : '탈퇴하기'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={navigation.goBack} style={styles.cancel}>
          <Text style={styles.cancelText}>취소</Text>
        </Pressable>
      </ScrollView>
      {notice.view}

      <ConfirmDialog
        visible={confirm}
        title="정말로 탈퇴하시겠습니까?"
        sub="계정과 이 기기의 개인 기록이 바로 삭제되고 되돌릴 수 없어요"
        confirmText="탈퇴"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setConfirm(false);
          setBusy(true);
          const r = await deleteAccount(); // 성공하면 로그인 화면으로 바뀜
          setBusy(false);
          if (!r.ok) notice.show(r.message);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, gap: spacing.sm },
  cardTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  line: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  agree: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48 },
  agreeText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  danger: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.coral, alignItems: 'center', justifyContent: 'center' },
  dangerText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  cancel: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
