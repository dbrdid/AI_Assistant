// ============================================================
// MoreScreen.js — '나' (홈 왼쪽 위 프로필): 내 계정 · AI · 도구 · 설정 모음
// ============================================================

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { Group, Row, SectionTitle } from '../../../shared/components/SettingsUi';
import Icon from '../../../shared/components/Icon';
import { colors, spacing } from '../../../shared/theme/theme';
import { MORE_SECTIONS, ROUTES } from '../../../navigation/routes';
import { useProposals } from '../../../data/proposals/ProposalStore';
import { PLANS, useSettings } from '../../../data/settings/SettingsStore';
import { useInsets } from '../../../shared/hooks/useInsets';

export default function MoreScreen({ navigation }) {
  const insets = useInsets();
  const s = useSettings();
  const name = s.profile.name.trim();
  const waiting = useProposals().filter((p) => p.status === 'pending').length;
  // 목록 오른쪽에 보여 줄 값 (확인할 제안 개수)
  const valueOf = { [ROUTES.Proposals]: waiting ? `${waiting}건` : '' };

  return (
    <View style={styles.root}>
      <ScreenHeader title="모든 도구" onBack={navigation.goBack} />
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingBottom: spacing.xxl + insets.bottom }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="계정 정보 보기" onPress={() => navigation.navigate(ROUTES.Account)} style={({ pressed }) => [styles.account, pressed && { backgroundColor: colors.raised }]}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{name ? name.charAt(0) : '나'}</Text></View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name}>{name || '이름을 설정해 주세요'}</Text>
            <Text style={styles.email} numberOfLines={1}>{s.profile.email && s.profile.email !== name ? `${s.profile.email}, ${PLANS[s.plan].name}` : !s.profile.email ? `로그인 전, ${PLANS[s.plan].name}` : PLANS[s.plan].name}</Text>
          </View>
          <Icon name="chevronRight" size={14} color={colors.muted} />
        </Pressable>
        {MORE_SECTIONS.map((sec) => (
          <View key={sec.title}>
            <SectionTitle>{sec.title}</SectionTitle>
            <Group>
              {sec.items.map((i) => (
                <Row key={i.route} icon={i.icon} label={i.label} value={valueOf[i.route] || undefined} onPress={() => navigation.navigate(i.route, i.params)} />
              ))}
            </Group>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: spacing.xxl, gap: 4 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 17, fontWeight: '600', color: colors.onPrimary },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  email: { fontSize: 12, color: colors.muted },
});
