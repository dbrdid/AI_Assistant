// ============================================================
// SettingsScreen.js — 설정
// ============================================================


import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { PLANS, useSettings } from '../../../data/settings/SettingsStore';
import { signOut } from '../../../data/auth/AuthStore';
import { Row, SectionTitle, useNotice } from '../../../shared/components/SettingsUi';

export default function SettingsScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu();
  const s = useSettings();
  const [confirmOut, setConfirmOut] = useState(false);
  const notice = useNotice();
  const name = s.profile.name.trim();

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader title="설정" />
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" accessibilityLabel="계정 정보 보기" onPress={() => navigation.navigate(ROUTES.Account)} style={styles.account}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{name ? name.charAt(0) : '?'}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name}>{name || '이름을 설정해 주세요'}</Text>
            <Text style={styles.email}>{s.profile.email || '로그인 전'} · {PLANS[s.plan].name}</Text>
          </View>
          <Text style={styles.chev}>›</Text>
        </Pressable>

        <SectionTitle>앱 설정</SectionTitle>
        <Row label="보안 및 권한 설정" onPress={() => navigation.navigate(ROUTES.Security)} />
        <Row label="AI 및 브리핑 설정" onPress={() => navigation.navigate(ROUTES.AiSettings)} />
        <Row label="알림 설정" onPress={() => navigation.navigate(ROUTES.NotificationSettings)} />
        <Row label="파일 보관함" onPress={() => navigation.navigate(ROUTES.Files)} />
        <Row label="백업 및 복원" onPress={() => navigation.navigate(ROUTES.Backup)} />
        <Row label="구독 관리" value={PLANS[s.plan].name} onPress={() => navigation.navigate(ROUTES.Subscription)} />

        <SectionTitle>계정</SectionTitle>
        <Row label="로그아웃" onPress={() => setConfirmOut(true)} />
        <Row label="회원탈퇴" danger onPress={() => navigation.navigate(ROUTES.Withdraw)} />
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
          if (!r.ok) notice.show('로그인 기능이 연결되면 사용할 수 있어요');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  account: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.mintSoft, borderWidth: 1, borderColor: colors.mint },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 22, fontWeight: '800', color: colors.white },
  name: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  email: { fontSize: font.caption, color: colors.muted },
  chev: { fontSize: 22, color: colors.muted },
});
