// ============================================================
// SettingsScreen.js — 설정
// ============================================================


import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { PLANS, useSettings } from '../../../data/settings/SettingsStore';
import { signOut } from '../../../data/auth/AuthStore';
import { Group, Row, SectionTitle, useNotice } from '../../../shared/components/SettingsUi';
import Icon from '../../../shared/components/Icon';

export default function SettingsScreen({ navigation }) {
  const s = useSettings();
  const [confirmOut, setConfirmOut] = useState(false);
  const notice = useNotice();
  const name = s.profile.name.trim();

  return (
    <View style={styles.root}>
      <ScreenHeader title="설정" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" accessibilityLabel="계정 정보 보기" onPress={() => navigation.navigate(ROUTES.Account)} style={({ pressed }) => [styles.account, pressed && { backgroundColor: colors.mintSoft }]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{name ? name.charAt(0) : '?'}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name}>{name || '이름을 설정해 주세요'}</Text>
            <Text style={styles.email} numberOfLines={1}>{s.profile.email || '로그인 전'} · {PLANS[s.plan].name}</Text>
          </View>
          <Icon name="chevronRight" size={18} color={colors.muted} />
        </Pressable>

        <SectionTitle>앱 설정</SectionTitle>
        <Group>
          <Row icon="shield" label="보안 및 권한 설정" onPress={() => navigation.navigate(ROUTES.Security)} />
          <Row icon="sparkles" label="AI 및 브리핑 설정" onPress={() => navigation.navigate(ROUTES.AiSettings)} />
          <Row icon="bell" label="알림 설정" onPress={() => navigation.navigate(ROUTES.NotificationSettings)} />
          <Row icon="folder" label="파일 보관함" onPress={() => navigation.navigate(ROUTES.Files)} />
          <Row icon="cloud" label="백업 및 복원" onPress={() => navigation.navigate(ROUTES.Backup)} />
          <Row icon="card" label="구독 관리" value={PLANS[s.plan].name} onPress={() => navigation.navigate(ROUTES.Subscription)} />
        </Group>

        <SectionTitle>계정</SectionTitle>
        <Group>
          <Row icon="logout" label="로그아웃" onPress={() => setConfirmOut(true)} />
          <Row icon="userX" label="회원탈퇴" danger onPress={() => navigation.navigate(ROUTES.Withdraw)} />
        </Group>
      </ScrollView>

      {notice.view}

      <ConfirmDialog
        visible={confirmOut}
        title="로그아웃 하시겠습니까?"
        sub="현재 기기의 로그인 정보를 삭제합니다"
        confirmText="확인"
        onCancel={() => setConfirmOut(false)}
        onConfirm={async () => {
          setConfirmOut(false);
          const r = await signOut();
          if (!r.ok) notice.show(r.message || '로그아웃하지 못했습니다');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  // 프로필 카드 (시안: 흰 카드 + 얇은 테두리)
  account: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 22, fontWeight: '800', color: colors.white },
  name: { fontSize: font.header, fontWeight: '800', color: colors.ink },
  email: { fontSize: 13, color: colors.muted },
});
