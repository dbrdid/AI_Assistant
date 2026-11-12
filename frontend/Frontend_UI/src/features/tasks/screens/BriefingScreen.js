// ============================================================
// BriefingScreen.js — 오늘의 브리핑 (스토리보드 40~43장)
// ============================================================
// 오늘 일정(시간순) / 마감 임박(접기 가능) / 미해결 안건 = 기한 지난 미완료 (접기 가능)

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { pendingOf, useProposals } from '../../../data/proposals/ProposalStore';
import { WEEKDAYS_LONG, toKey } from '../../calendar/utils/DateUtils';
import { classify, shortDate, tagText, useTasks } from '../../../data/tasks/TaskStore';

function Section({ title, count, open, onToggle, children }) {
  return (
    <View style={styles.section}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title} {count}</Text>
        <Text style={styles.chev}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open && <View style={{ gap: spacing.sm }}>{children}</View>}
    </View>
  );
}

export default function BriefingScreen({ navigation }) {
  const tasks = useTasks();
  const now = new Date();
  const todayKey = toKey(now);
  const [soonOpen, setSoonOpen] = useState(true);
  const [overOpen, setOverOpen] = useState(true);

  const today = tasks.filter((t) => t.date === todayKey);
  const soon = tasks.filter((t) => classify(t, todayKey) === 'soon');
  const overdue = tasks.filter((t) => classify(t, todayKey) === 'overdue');
  const proposals = pendingOf(useProposals());
  const empty = today.length + soon.length + overdue.length + proposals.length === 0;

  const row = (t) => (
    <Pressable
      key={t.id}
      accessibilityRole="button"
      onPress={() => navigation.navigate(ROUTES.TaskEdit, { taskId: t.id })}
      style={styles.row}
    >
      <Text style={styles.rowTime}>{t.date === todayKey ? t.start || '종일' : shortDate(t)}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowTitle, t.status === '완료' && styles.done]} numberOfLines={1}>{t.title}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>{[tagText(t, todayKey), t.place].filter(Boolean).join(' · ')}</Text>
      </View>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      <ScreenHeader title="오늘의 브리핑" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.date}>{now.getMonth() + 1}월 {now.getDate()}일 {WEEKDAYS_LONG[now.getDay()]}</Text>
        {empty ? (
          <Text style={styles.empty}>오늘은 브리핑할 내용이 없어요</Text>
        ) : (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>오늘 일정 {today.length}</Text>
              {today.length === 0 ? <Text style={styles.rowMeta}>오늘 일정이 없어요</Text> : today.map(row)}
            </View>
            {proposals.length > 0 && (
              <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.Proposals)} style={styles.section}>
                <Text style={styles.sectionTitle}>검증 필요 {proposals.length}  ›</Text>
                <Text style={styles.rowMeta}>AI가 찾은 일정·할 일을 확인해 주세요</Text>
              </Pressable>
            )}
            <Section title="마감 임박" count={soon.length} open={soonOpen} onToggle={() => setSoonOpen((v) => !v)}>
              {soon.length === 0 ? <Text style={styles.rowMeta}>임박한 항목이 없어요</Text> : soon.map(row)}
            </Section>
            <Section title="미해결 안건" count={overdue.length} open={overOpen} onToggle={() => setOverOpen((v) => !v)}>
              {overdue.length === 0 ? <Text style={styles.rowMeta}>미해결 안건이 없어요</Text> : overdue.map(row)}
            </Section>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  date: { fontSize: font.body, color: colors.muted },
  empty: { fontSize: font.bodyLg, color: colors.muted, textAlign: 'center', paddingVertical: spacing.xxl },
  section: { gap: spacing.sm },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 36 },
  sectionTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  chev: { fontSize: 16, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  rowTime: { minWidth: 48, fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  rowTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  rowMeta: { fontSize: font.caption, color: colors.muted },
  done: { color: colors.muted, textDecorationLine: 'line-through' },
});
