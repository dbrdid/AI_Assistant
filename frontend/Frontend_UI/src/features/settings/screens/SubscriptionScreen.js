// ============================================================
// SubscriptionScreen.js — 구독 관리 (서버 구독 · 시연용 가짜 결제, 실제 결제사 연동 없음)
// ============================================================


import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { PLANS, setServerPlan } from '../../../data/settings/SettingsStore';
import { PaymentFailedDialog } from '../../error/components/ErrorViews';
import { useNotice } from '../../../shared/components/SettingsUi';
import { supabase } from '../../../lib/stella/supabase';
import { billingErrorMessage, cancelSubscription, changePlan, getSubscription, nextPaymentText, planId, planOptionText } from '../../../lib/stella/billing';

const DONE = {
  SUBSCRIBED: '요금제를 시작했어요',
  CHANGED: '요금제를 바꿨어요',
  RESUMED: '해지 예약을 취소했어요',
  ALREADY_ACTIVE: '이미 이용 중인 요금제예요',
  CANCEL_SCHEDULED: '다음 결제일부터 무료 요금제로 바뀌어요',
  ALREADY_FREE: '이미 무료 요금제예요',
};

export default function SubscriptionScreen({ navigation, route }) {
  const [sub, setSub] = useState(null);      // 서버 구독 (get_my_subscription)
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [payFailed, setPayFailed] = useState(!!(route && route.params && route.params.paymentFailed));
  const notice = useNotice();
  // 같은 버튼을 다시 눌러도(재시도) 한 번만 결제되도록 요금제마다 요청 id를 하나씩 유지
  const requestIds = useRef({});

  const apply = useCallback((s) => {
    setSub(s);
    setServerPlan(planId(s)); // 설정·이용량 화면의 요금제 표시도 맞춤
  }, []);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      apply(await getSubscription(supabase));
    } catch (e) {
      setLoadError(billingErrorMessage(e));
    }
  }, [apply]);
  useEffect(() => { load(); }, [load]);

  const current = sub ? planId(sub) : null;
  const paid = sub ? sub.state === 'ACTIVE' : false;

  const choose = async (id) => {
    setChoosing(false);
    if (busy || id === current) return;
    requestIds.current[id] ??= randomUUID();
    setBusy(true);
    try {
      const r = await changePlan(supabase, id, { requestId: requestIds.current[id] });
      apply(r.subscription);
      if (!r.ok) setPayFailed(true);
      else notice.show(DONE[r.action] ?? '처리했어요');
      delete requestIds.current[id]; // 결과를 받았으면 다음 변경은 새 요청
    } catch (e) {
      notice.show(billingErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setConfirmCancel(false);
    if (busy) return;
    setBusy(true);
    try {
      apply(await cancelSubscription(supabase));
      notice.show(DONE.CANCEL_SCHEDULED);
    } catch (e) {
      notice.show(billingErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="구독 관리" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.label}>현재 요금제</Text>
          {sub ? (
            <Text style={styles.plan}>
              {PLANS[current].name}
              {sub.state === 'CANCELING' ? ' (해지 예약)' : ''}
            </Text>
          ) : loadError ? (
            <Text style={styles.error}>{loadError}</Text>
          ) : (
            <ActivityIndicator color={colors.mintDark} style={{ alignSelf: 'flex-start', marginVertical: spacing.sm }} />
          )}
          <Text style={styles.label}>다음 결제일</Text>
          <Text style={styles.date}>{sub ? nextPaymentText(sub) : '-'}</Text>
        </View>

        {!!loadError && (
          <Pressable accessibilityRole="button" onPress={load} style={styles.ghost}>
            <Text style={styles.ghostText}>다시 불러오기</Text>
          </Pressable>
        )}

        <Pressable accessibilityRole="button" disabled={!sub || busy} onPress={() => setChoosing(true)} style={[styles.primary, (!sub || busy) && { opacity: 0.5 }]}>
          <Text style={styles.primaryText}>{busy ? '처리 중…' : '요금제 변경'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !paid || busy }}
          disabled={!paid || busy}
          onPress={() => setConfirmCancel(true)}
          style={[styles.ghost, (!paid || busy) && { opacity: 0.4 }]}
        >
          <Text style={styles.ghostText}>구독 해지</Text>
        </Pressable>
        {sub && !paid && (
          <Text style={styles.note}>{sub.state === 'CANCELING' ? '해지 예약 중이에요. 같은 요금제를 다시 고르면 해지가 취소돼요.' : '이용 중인 유료 요금제가 없어요.'}</Text>
        )}
        <Text style={styles.note}>시연용 결제예요. 실제로 돈이 결제되지 않아요.</Text>
      </ScrollView>
      {notice.view}
      <PaymentFailedDialog visible={payFailed} onConfirm={() => setPayFailed(false)} />

      <Modal transparent visible={choosing} animationType="fade" onRequestClose={() => setChoosing(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>요금제 선택</Text>
            {Object.keys(PLANS).map((id) => {
              const on = id === current;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => choose(id)}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.optionName}>{PLANS[id].name}</Text>
                    <Text style={styles.optionSub}>{sub ? planOptionText(sub, id) : ''}</Text>
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
        sub="해지하면 다음 결제일까지 지금 요금제를 쓰고, 그 뒤 무료 요금제로 바뀌어요."
        confirmText="구독 해지"
        danger
        onCancel={() => setConfirmCancel(false)}
        onConfirm={cancel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { padding: spacing.xl, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, gap: spacing.xs },
  label: { fontSize: font.caption, color: colors.muted, marginTop: spacing.sm },
  plan: { fontSize: 28, fontWeight: '800', color: colors.mintDark },
  date: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
  error: { fontSize: font.body, fontWeight: '700', color: colors.coral },
  primary: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  note: { fontSize: font.caption, color: colors.muted },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.card, padding: spacing.xl, gap: spacing.sm },
  dialogTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink, marginBottom: spacing.sm },
  option: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  optionOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  optionName: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  optionSub: { fontSize: font.caption, color: colors.muted },
  current: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.white, overflow: 'hidden' },
});
