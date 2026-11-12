// ============================================================
// ProposalListScreen.js — AI 제안 "검증 필요" 목록
// ============================================================
// 탭: 확인 대기 / 보류. 카드를 누르면 확인 화면(ProposalConfirm)으로 이동.
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { useProposals } from '../../../data/proposals/ProposalStore';

export const KIND_LABEL = { event: '일정', task: '할 일', memo: '메모' };
const SRC = { memo: '메모', record: '녹음' };

export default function ProposalListScreen({ navigation }) {
  const all = useProposals();
  const [tab, setTab] = useState('pending');
  const list = all.filter((p) => p.status === tab);
  const count = (s) => all.filter((p) => p.status === s).length;

  return (
    <View style={styles.root}>
      <ScreenHeader title="AI 제안 확인" onBack={navigation.goBack} />
      <View style={styles.tabs}>
        {[['pending', '확인 대기'], ['hold', '보류']].map(([k, label]) => (
          <Pressable key={k} accessibilityRole="button" accessibilityState={{ selected: tab === k }} onPress={() => setTab(k)} style={[styles.tab, tab === k && styles.tabOn]}>
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{label} {count(k)}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {list.length === 0 && (
          <Text style={styles.empty}>{tab === 'pending' ? '확인할 AI 제안이 없어요.\n메모나 녹음에서 일정이 보이면 여기에 알려드려요.' : '보류한 제안이 없어요.'}</Text>
        )}
        {list.map((p) => (
          <Pressable key={p.id} accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.ProposalConfirm, { id: p.id })} style={styles.card}>
            <View style={styles.row}>
              <View style={styles.badge}><Text style={styles.badgeText}>{KIND_LABEL[p.kind]}</Text></View>
              <Text style={styles.src}>{SRC[p.sourceType] || '메모'}에서 찾음</Text>
            </View>
            <Text style={styles.title} numberOfLines={1}>{p.title || '(제목 없음)'}</Text>
            {!!p.date && <Text style={styles.meta}>{p.date.slice(5).replace('-', '/')}{p.start ? ` ${p.start}` : ''}{p.place ? ` · ${p.place}` : ''}</Text>}
            {!!p.evidence && <Text style={styles.evidence} numberOfLines={2}>“{p.evidence}”</Text>}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  tabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  tab: { minHeight: 40, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  tabOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  tabText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  tabTextOn: { color: colors.white },
  body: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  empty: { textAlign: 'center', color: colors.muted, fontSize: font.body, lineHeight: 22, marginTop: spacing.xxl },
  card: { backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: spacing.lg, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badge: { backgroundColor: colors.mintDark, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: colors.white, fontSize: font.caption, fontWeight: '800' },
  src: { fontSize: font.caption, color: colors.muted },
  title: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  meta: { fontSize: font.body, color: colors.ink },
  evidence: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
});
