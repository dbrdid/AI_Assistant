// ============================================================
// SubscriptionScreen.js — 구독 관리 (스토리보드 93~94장)
// ============================================================
// 현재 요금제 · 다음 결제일 · [구독 해지] · [요금제 변경]
// ※ 결제가 아직 연결되지 않아 지금은 항상 "무료"이고, 요금제 변경·구독 해지는 결제 연결 후에 동작해요.
//    (결제 실패 팝업 "결제수단을 다시 확인해 주세요"는 결제 연결할 때 PaymentFailedDialog 로 쓰면 됩니다.)

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { PLANS, useSettings } from '../../../data/settings/SettingsStore';
import { PaymentFailedDialog } from '../../error/components/ErrorViews';
import { useNotice } from '../../../shared/components/SettingsUi';

const PLAN_INFO = {
  free: '기본 기능 · AI 월 한도 기본 제공',
  pro: 'AI 이용량 확대 · 파일 저장 용량 확대',
  team: '팀 공간 · 팀원 초대 확대',
};

export default function SubscriptionScreen({ navigation, route }) {
  const s = useSettings();
  const [choosing, setChoosing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [payFailed, setPayFailed] = useState(!!(route && route.params && route.params.paymentFailed)); // 결제가 연결되면 결제 실패 시 이 값을 true 로 넘겨 이동
  const notice = useNotice();
  const paid = s.plan !== 'free';

  return (
    <View style={styles.root}>
      <ScreenHeader title="구독 관리" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.label}>현재 요금제</Text>
          <Text style={styles.plan}>{PLANS[s.plan].name}</Text>
          <Text style={styles.label}>다음 결제일</Text>
          <Text style={styles.date}>{paid ? '결제 연동 후 표시돼요' : '-  (무료 요금제는 결제가 없어요)'}</Text>
        </View>

        <Pressable accessibilityRole="button" onPress={() => setChoosing(true)} style={styles.primary}>
          <Text style={styles.primaryText}>요금제 변경</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !paid }}
          disabled={!paid}
          onPress={() => setConfirmCancel(true)}
          style={[styles.ghost, !paid && { opacity: 0.4 }]}
        >
          <Text style={styles.ghostText}>구독 해지</Text>
        </Pressable>
        {!paid && <Text style={styles.note}>이용 중인 유료 요금제가 없어요.</Text>}
      </ScrollView>
      {notice.view}
      <PaymentFailedDialog visible={payFailed} onConfirm={() => setPayFailed(false)} />

      <Modal transparent visible={choosing} animationType="fade" onRequestClose={() => setChoosing(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>요금제 선택</Text>
            {Object.keys(PLANS).map((id) => {
              const on = id === s.plan;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    setChoosing(false);
                    if (!on) notice.show('결제 기능이 연결되면 변경할 수 있어요');
                  }}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.optionName}>{PLANS[id].name}</Text>
                    <Text style={styles.optionSub}>{PLAN_INFO[id]}</Text>
                  </View>
                  {on && <Text style={styles.current}>현재</Text>}
                </Pressable>
              );
            })}
            <Pressable accessibilityRole="button" onPress={() => setChoosing(false)} style={styles.ghost}>
              <Text style={styles.ghostText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={confirmCancel}
        title="구독을 해지할까요?"
        sub="해지하면 다음 결제일부터 무료 요금제로 바뀌어요."
        confirmText="구독 해지"
        danger
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          notice.show('결제 기능이 연결되면 사용할 수 있어요');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: spacing.xs },
  label: { fontSize: font.caption, color: colors.muted, marginTop: spacing.sm },
  plan: { fontSize: 28, fontWeight: '800', color: colors.mintDark },
  date: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
  primary: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  note: { fontSize: font.caption, color: colors.muted },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm },
  dialogTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink, marginBottom: spacing.sm },
  option: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  optionOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  optionName: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  optionSub: { fontSize: font.caption, color: colors.muted },
  current: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
});
