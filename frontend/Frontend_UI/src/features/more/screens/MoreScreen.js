// ============================================================
// MoreScreen.js — '나' (홈 왼쪽 위 프로필): 내 계정 · AI · 도구 · 설정 모음
// ============================================================

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { Group, Row, SectionTitle } from '../../../shared/components/SettingsUi';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { MORE_SECTIONS, ROUTES } from '../../../navigation/routes';
import { useProposals } from '../../../data/proposals/ProposalStore';
import { PLANS, useSettings } from '../../../data/settings/SettingsStore';

export default function MoreScreen({ navigation }) {
  const s = useSettings();
  const name = s.profile.name.trim();
  const waiting = useProposals().filter((p) => p.status === 'pending').length;
  // 목록 오른쪽에 보여 줄 값 (확인할 제안 개수)
  const valueOf = { [ROUTES.Proposals]: waiting ? `${waiting}건` : '' };

  return (
    <View style={styles.root}>
      <ScreenHeader title="나" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" accessibilityLabel="계정 정보 보기" onPress={() => navigation.navigate(ROUTES.Account)} style={({ pressed }) => [styles.account, pressed && { backgroundColor: colors.mintSoft }]}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{name ? name.charAt(0) : '나'}</Text></View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name}>{name || '이름을 설정해 주세요'}</Text>
            <Text style={styles.email} numberOfLines={1}>{s.profile.email || '로그인 전'} · {PLANS[s.plan].name}</Text>
          </View>
          <Icon name="chevronRight" size={18} color={colors.muted} />
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
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  account: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 20, fontWeight: '800', color: colors.white },
  name: { fontSize: font.header, fontWeight: '800', color: colors.ink },
  email: { fontSize: 13, color: colors.muted },
});
