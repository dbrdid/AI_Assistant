// ============================================================
// WorkspaceInviteScreen.js — 워크스페이스 초대
// ============================================================

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { joinWorkspace, switchWorkspace } from '../../../data/workspaces/WorkspaceStore';

export default function WorkspaceInviteScreen({ navigation, route }) {
  const p = route?.params || {};
  const expired = p.status === 'expired';
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    if (busy || expired) return;
    setBusy(true);
    const id = joinWorkspace({ name: p.name || '워크스페이스', role: p.role || '멤버', members: p.members || 2 });
    await switchWorkspace(id);
    setBusy(false);
    navigation.goBack();
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="워크스페이스 초대" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.name}>{p.name || '워크스페이스'}</Text>
          <Text style={styles.sub}>관리자 {p.inviter || '관리자'} 님이 초대했어요</Text>
          <Text style={styles.meta}>{p.role || '멤버'} · 멤버 {p.members || 2}명</Text>
        </View>

        <View style={styles.info}>
          <Text style={styles.infoText}>
            수락하면 워크스페이스에 공유된 기록과 할 일을 볼 수 있어요. 개인 공간 기록은 공개되지 않아요.
          </Text>
        </View>

        {expired && (
          <View style={styles.expired} accessibilityLiveRegion="polite">
            <Text style={styles.expiredTitle}>초대가 만료되었습니다</Text>
            <Text style={styles.expiredSub}>관리자에게 다시 요청해주세요.</Text>
          </View>
        )}

        <View style={styles.row}>
          <Pressable accessibilityRole="button" onPress={navigation.goBack} style={[styles.btn, styles.ghost]}>
            <Text style={styles.ghostText}>거절</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: expired }}
            disabled={expired || busy}
            onPress={accept}
            style={[styles.btn, styles.primary, (expired || busy) && { opacity: 0.4 }]}
          >
            <Text style={styles.primaryText}>{busy ? '참여하는 중…' : '수락'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  card: { padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: spacing.sm },
  name: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.bodyLg, color: colors.ink },
  meta: { fontSize: font.body, color: colors.mintDark, fontWeight: '700' },
  info: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.mintSoft },
  infoText: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  expired: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.coral, gap: 4 },
  expiredTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.coral },
  expiredSub: { fontSize: font.body, color: colors.ink },
  row: { flexDirection: 'row', gap: spacing.md },
  btn: { flex: 1, minHeight: 52, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  ghost: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  primary: { backgroundColor: colors.mintDark },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
});
