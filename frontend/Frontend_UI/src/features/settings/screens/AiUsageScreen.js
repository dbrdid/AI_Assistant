// ============================================================
// AiUsageScreen.js — AI 이용량 (스토리보드 90~91장)
// ============================================================
// "이번 달 사용량": 질문 · 요약 · 녹음 · 텍스트 변환의 (사용 횟수 / 요금제 한도) 막대
// + 팀원 초대 횟수, [요금제 변경] → 구독 관리 화면
// 사용 횟수는 앱에서 AI 질문·요약·변환을 쓸 때마다 올라가요(달이 바뀌면 0 부터). 녹음은 녹음 기능 연결 후 집계돼요.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { MONTHLY_INVITES, invitesLeft } from '../../../data/projects/ProjectStore';
import { PLANS, USAGE_LABELS, getUsage, limitOf, useSettings } from '../../../data/settings/SettingsStore';

function Bar({ label, used, limit }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const full = used >= limit;
  return (
    <View style={styles.item} accessibilityLabel={`${label} ${used}회 사용, 한도 ${limit}회`}>
      <View style={styles.itemHead}>
        <Text style={styles.itemLabel}>{label}</Text>
        <Text style={[styles.itemCount, full && { color: colors.coral }]}>{used}/{limit}</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${ratio * 100}%` }, full && { backgroundColor: colors.coral }]} />
      </View>
    </View>
  );
}

export default function AiUsageScreen({ navigation }) {
  const s = useSettings(); // 이용량이 바뀌면 다시 그리기
  const u = getUsage();
  const used = MONTHLY_INVITES - invitesLeft();

  return (
    <View style={styles.root}>
      <ScreenHeader title="AI 이용량" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>이번 달 사용량</Text>
        <Text style={styles.plan}>현재 요금제 · {PLANS[s.plan].name}</Text>
        {Object.keys(USAGE_LABELS).map((k) => (
          <Bar key={k} label={USAGE_LABELS[k]} used={u[k]} limit={limitOf(k)} />
        ))}
        <Bar label="팀원 초대 횟수" used={used} limit={MONTHLY_INVITES} />

        <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.Subscription)} style={styles.btn}>
          <Text style={styles.btnText}>요금제 변경</Text>
        </Pressable>
        <Text style={styles.note}>녹음 사용량은 녹음 기능이 연결되면 집계돼요.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  heading: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  plan: { fontSize: font.body, color: colors.mintDark, fontWeight: '700' },
  item: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: spacing.sm },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between' },
  itemLabel: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  itemCount: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.mint },
  btn: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  btnText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  note: { fontSize: font.caption, color: colors.muted },
});
