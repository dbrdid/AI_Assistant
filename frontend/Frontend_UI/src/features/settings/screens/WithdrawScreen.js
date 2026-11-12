// ============================================================
// WithdrawScreen.js — 회원탈퇴 
// ============================================================


import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { deleteAccount } from '../../../data/auth/AuthStore';
import { useNotice } from '../../../shared/components/SettingsUi';

export default function WithdrawScreen({ navigation }) {
  const [agree, setAgree] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const notice = useNotice();

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
          <Text style={styles.line}>• 이용 중인 요금제는 탈퇴와 함께 해지돼요</Text>
          <Text style={styles.line}>• 조직의 마지막 관리자는 관리자 역할을 넘긴 뒤에만 탈퇴할 수 있어요</Text>
        </View>

        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: agree }} onPress={() => setAgree((v) => !v)} style={styles.agree}>
          <Text style={[styles.box, agree && { color: colors.mintDark }]}>{agree ? '☑' : '☐'}</Text>
          <Text style={styles.agreeText}>위 내용을 확인했습니다</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !agree }}
          disabled={!agree}
          onPress={() => setConfirm(true)}
          style={[styles.danger, !agree && { opacity: 0.4 }]}
        >
          <Text style={styles.dangerText}>탈퇴하기</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={navigation.goBack} style={styles.cancel}>
          <Text style={styles.cancelText}>취소</Text>
        </Pressable>
      </ScrollView>
      {notice.view}

      <ConfirmDialog
        visible={confirm}
        title="정말로 탈퇴하시겠습니까?"
        sub="사용의 모든 정보가 삭제됩니다"
        confirmText="확인"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setConfirm(false);
          const r = await deleteAccount();
          if (!r.ok) notice.show('로그인 기능이 연결되면 사용할 수 있어요 (지금은 데이터가 삭제되지 않아요)');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: spacing.sm },
  cardTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  line: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  agree: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48 },
  box: { fontSize: 26, color: colors.muted },
  agreeText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  danger: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.coral, alignItems: 'center', justifyContent: 'center' },
  dangerText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  cancel: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
