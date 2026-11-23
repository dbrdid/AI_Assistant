// ============================================================
// SubscriptionScreen.js — 구독 관리 (서버 구독 · 시연용 가짜 결제, 실제 결제사 연동 없음)
// ============================================================


import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { PLANS, setServerPlan } from '../../../data/settings/SettingsStore';
import { PaymentFailedDialog } from '../../error/components/ErrorViews';
import { useNotice } from '../../../shared/components/SettingsUi';
import { supabase } from '../../../lib/stella/supabase';
import { billingErrorMessage, cancelSubscription, changePlan, getSubscription, nextPaymentText, planId, serverPlan, storageText } from '../../../lib/stella/billing';

const DONE = {
  SUBSCRIBED: '요금제를 시작했어요',
  CHANGED: '요금제를 바꿨어요',
  RESUMED: '해지 예약을 취소했어요',
  ALREADY_ACTIVE: '이미 이용 중인 요금제예요',
  CANCEL_SCHEDULED: '다음 결제일부터 무료 요금제로 바뀌어요',
  ALREADY_FREE: '이미 무료 요금제예요',
};

const PLAN_IDS = ['free', 'pro', 'team'];

const BENEFITS = [
  { label: '녹음 변환', value: p => `${p.ai.stt_minutes}분/월` },
  { label: 'AI 요약·추출', value: p => `${p.ai.analyze}회/월` },
  { label: 'AI 질문', value: p => `${p.ai.query}회/월` },
  { label: '메모 정리', value: p => `${p.ai.organize}회/월` },
  { label: '사진 글자 인식', value: p => `${p.ai.ocr}회/월` },
  { label: '안건 비교', value: p => `${p.ai.agenda}회/월` },
  { label: '프로젝트 초대', value: p => `${p.project_invites_per_month}회/월` },
  { label: '클라우드 저장', value: p => storageText(p.workspace_storage_bytes) },
  { label: '백업 저장', value: p => storageText(p.backup_storage_bytes) },
];

const won = value => `${String(Math.round(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;

export default function SubscriptionScreen({ navigation, route }) {
  const [sub, setSub] = useState(null);      // 서버 구독 (get_my_subscription)
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
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
  const hasPlanCatalog = !!sub && PLAN_IDS.every(id => sub.plans?.[serverPlan(id)]);

  const choose = async (id) => {
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
        <View style={styles.comparisonHeading}>
          <Text style={styles.sectionTitle}>요금제 비교</Text>
          <Text style={styles.note}>무료·PRO·TEAM 혜택과 월 제공량을 비교해 보세요.</Text>
        </View>
        {hasPlanCatalog ? (
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.tableScroll}>
            <View style={styles.table}>
              <View style={[styles.tableRow, styles.tableHeader]}>
                <View style={[styles.featureCell, styles.headerCell]}>
                  <Text style={styles.headerLabel}>기능</Text>
                </View>
                {PLAN_IDS.map(id => {
                  const plan = sub.plans[serverPlan(id)];
                  return (
                    <View key={id} style={[styles.planCell, styles.headerCell]}>
                      <Text style={styles.planName}>{PLANS[id].name}</Text>
                      <Text style={styles.planPrice}>{plan.price_krw === 0 ? '무료' : `월 ${won(plan.price_krw)}`}</Text>
                    </View>
                  );
                })}
              </View>
              {BENEFITS.map((benefit, index) => (
                <View key={benefit.label} style={[styles.tableRow, index % 2 === 1 && styles.alternateRow]}>
                  <View style={styles.featureCell}>
                    <Text style={styles.featureLabel}>{benefit.label}</Text>
                  </View>
                  {PLAN_IDS.map(id => (
                    <View key={id} style={styles.planCell}>
                      <Text style={styles.benefitValue}>{benefit.value(sub.plans[serverPlan(id)])}</Text>
                    </View>
                  ))}
                </View>
              ))}
              <View style={[styles.tableRow, styles.tableFooter]}>
                <View style={styles.featureCell} />
                {PLAN_IDS.map(id => {
                  const on = id === current;
                  return (
                    <View key={id} style={styles.planCell}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: busy || on, selected: on }}
                        disabled={!sub || busy || on}
                        onPress={() => choose(id)}
                        style={[styles.selectButton, on && styles.selectedButton, busy && !on && styles.disabledButton]}
                      >
                        <Text style={[styles.selectText, on && styles.selectedText]}>
                          {busy && !on ? '처리 중…' : on ? '이용 중' : '선택'}
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </View>
          </ScrollView>
        ) : loadError ? (
          <Text style={styles.error}>요금제 혜택을 불러오지 못했어요. 다시 불러와 주세요.</Text>
        ) : (
          <ActivityIndicator color={colors.mintDark} style={styles.loader} />
        )}
        <Text style={styles.note}>기본 AI 모델: 텍스트·이미지 작업은 OpenAI GPT-6.1 Terra, 녹음 변환은 GPT-transcribe예요. 서버 설정에 따라 모델은 달라질 수 있어요.</Text>
        <Text style={styles.note}>시연용 결제예요. 실제로 돈이 결제되지 않아요.</Text>
      </ScrollView>
      {notice.view}
      <PaymentFailedDialog visible={payFailed} onConfirm={() => setPayFailed(false)} />

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
  card: { padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: spacing.xs },
  label: { fontSize: font.caption, color: colors.muted, marginTop: spacing.sm },
  plan: { fontSize: 28, fontWeight: '800', color: colors.mintDark },
  date: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
  error: { fontSize: font.body, fontWeight: '700', color: colors.coral },
  ghost: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  note: { fontSize: font.caption, color: colors.muted },
  sectionTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  comparisonHeading: { gap: spacing.xs, marginTop: spacing.sm },
  tableScroll: { paddingBottom: spacing.xs },
  table: { width: 378, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  tableRow: { flexDirection: 'row', minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.line },
  tableHeader: { minHeight: 68, backgroundColor: colors.mintSoft },
  headerCell: { justifyContent: 'center' },
  featureCell: { width: 102, justifyContent: 'center', paddingHorizontal: spacing.sm },
  planCell: { width: 92, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2 },
  headerLabel: { fontSize: font.caption, fontWeight: '700', color: colors.ink },
  planName: { fontSize: font.body, fontWeight: '800', color: colors.ink },
  planPrice: { fontSize: 11, fontWeight: '700', color: colors.mintDark, marginTop: 2 },
  alternateRow: { backgroundColor: colors.cream },
  featureLabel: { fontSize: 11, fontWeight: '600', color: colors.ink },
  benefitValue: { fontSize: 11, color: colors.ink, textAlign: 'center' },
  tableFooter: { minHeight: 56, borderBottomWidth: 0 },
  selectButton: { minWidth: 74, minHeight: 34, borderRadius: radius.sm, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  selectedButton: { backgroundColor: colors.mintSoft, borderWidth: 1, borderColor: colors.mint },
  disabledButton: { opacity: 0.6 },
  selectText: { fontSize: 11, fontWeight: '800', color: colors.white },
  selectedText: { color: colors.mintDark },
  loader: { paddingVertical: spacing.xl },
});
