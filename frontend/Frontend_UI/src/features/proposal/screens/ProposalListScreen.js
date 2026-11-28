// ============================================================
// ProposalListScreen.js — AI 제안 확인 목록 (목록에서 바로 추가 · 수정 · 보류 · 무시)
// ============================================================

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { PillButton } from '../../../shared/components/Ui';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { useProposals } from '../../../data/proposals/ProposalStore';
import ProposalCard from '../components/ProposalCard';
import { reviewReason, useProposalActions } from '../useProposalActions';

export default function ProposalListScreen({ navigation }) {
  const all = useProposals();
  const actions = useProposalActions(navigation);
  const [tab, setTab] = useState('pending');
  const [selectedProposal, setSelectedProposal] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const visible = all.filter((p) => !actions.hidden.has(p.id));
  const list = visible.filter((p) => p.status === tab);
  const count = (s) => visible.filter((p) => p.status === s).length;
  const ready = list.filter((p) => !reviewReason(p));

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="AI 제안"
        onBack={navigation.goBack}
        right={ready.length > 1 ? <PillButton kind="text" label="모두 추가" onPress={() => setConfirmAll(true)} /> : null}
      />
      <View style={styles.tabs}>
        {[['pending', '확인 대기'], ['hold', '보류']].map(([k, label]) => (
          <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} onPress={() => { setTab(k); setSelectedProposal(null); }} style={[styles.tab, tab === k && styles.tabOn]}>
            <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{label} {count(k)}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.body}>
        {list.length === 0 && (
          <Text style={styles.empty}>{tab === 'pending' ? '확인할 AI 제안이 없어요.\n메모나 녹음에서 일정이 보이면 여기에 알려드려요.' : '보류한 제안이 없어요.'}</Text>
        )}
        {list.map((p) => (
          <ProposalCard
            key={p.id}
            p={p}
            actions={actions}
            expanded={selectedProposal === p.id}
            onToggle={() => setSelectedProposal((id) => (id === p.id ? null : p.id))}
            onSource={() => navigation.navigate('MemoEdit', { memoId: p.sourceId })}
          />
        ))}
      </ScrollView>

      {actions.snack.view}
      <ConfirmDialog
        visible={confirmAll}
        title={`제안 ${ready.length}건을 모두 추가할까요?`}
        sub="날짜가 없거나 겹치는 제안은 빼고 추가해요."
        confirmText="모두 추가"
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          actions.addAll(ready);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  tabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  tab: { minHeight: 44, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderColor: 'transparent', justifyContent: 'center' },
  tabOn: { borderColor: colors.ink },
  tabText: { fontSize: font.body, fontWeight: '500', color: colors.muted },
  tabTextOn: { color: colors.ink },
  body: { padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md, paddingBottom: 96 },
  empty: { textAlign: 'center', color: colors.muted, fontSize: font.body, lineHeight: 22, marginTop: spacing.xxl },
});
