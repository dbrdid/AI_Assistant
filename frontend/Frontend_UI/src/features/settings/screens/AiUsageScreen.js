// ============================================================
// AiUsageScreen.js — AI 이용량
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { getProjectInviteQuota } from '../../../lib/stella/project-team';
import { supabase } from '../../../lib/stella/supabase';
import { loadAiUsage, PLANS } from '../../../data/settings/SettingsStore';

function Bar({ label, used, limit, unit = '회' }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const known = Number.isFinite(limit) && limit > 0;
  const full = known && used >= limit;
  return (
    <View style={styles.item} accessibilityLabel={`${label} ${used}${unit} 사용, 한도 ${limit}${unit}`}>
      <View style={styles.itemHead}>
        <Text style={styles.itemLabel}>{label}</Text>
        <Text style={[styles.itemCount, full && { color: colors.coral }]}>{known ? `${used}/${limit}${unit}` : '한도 확인 필요'}</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${ratio * 100}%` }, full && { backgroundColor: colors.coral }]} />
      </View>
    </View>
  );
}

export default function AiUsageScreen({ navigation }) {
  const [usage, setUsage] = useState(null);
  const [inviteQuota, setInviteQuota] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextUsage, nextInviteQuota] = await Promise.all([
        loadAiUsage(),
        getProjectInviteQuota(supabase),
      ]);
      setUsage(nextUsage);
      setInviteQuota(nextInviteQuota);
    } catch (e) {
      setError(e?.message || '이용량을 불러오지 못했어요.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <View style={styles.root}>
      <ScreenHeader title="AI 이용량" onBack={navigation.goBack} />
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.heading}>이번 달 사용량</Text>
        <Text style={styles.plan}>현재 요금제, {usage ? PLANS[usage.plan].name : '불러오는 중'}</Text>
        {loading && !usage ? <ActivityIndicator color={colors.mintDark} style={styles.loader} /> : null}
        {!!error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={load}>
              <Text style={styles.retry}>다시 불러오기</Text>
            </Pressable>
          </View>
        )}
        {usage?.items.map(item => (
          <Bar key={item.key} label={item.label} used={item.used} limit={item.limit} unit={item.unit} />
        ))}
        {inviteQuota && (
          <Bar label="프로젝트 초대" used={inviteQuota.used} limit={inviteQuota.limit} unit="회" />
        )}

        <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.Subscription)} style={styles.btn}>
          <Text style={styles.btnText}>요금제 변경</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  heading: { fontSize: font.title, fontWeight: '600', color: colors.ink },
  plan: { fontSize: font.body, color: colors.mintDark, fontWeight: '500' },
  item: { padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, gap: spacing.sm },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between' },
  itemLabel: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
  itemCount: { fontSize: font.bodyLg, fontWeight: '600', color: colors.mintDark },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.mint },
  btn: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  btnText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  note: { fontSize: font.caption, color: colors.muted },
  loader: { paddingVertical: spacing.xl },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.coralSoft, gap: spacing.sm },
  errorText: { fontSize: font.body, color: colors.coral },
  retry: { fontSize: font.body, fontWeight: '500', color: colors.mintDark },
});
