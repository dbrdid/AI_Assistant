// ============================================================
// MemoLinks.js — 메모에 연결된 일정·할 일 줄
// ============================================================

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { useMemos } from '../../../data/memos/MemoStore';
import { useTasks } from '../../../data/tasks/TaskStore';

export default function MemoLinks({ memoId, navigation }) {
  const memos = useMemos();
  const tasks = useTasks();
  const memo = memos.find((m) => m.id === memoId);
  const linked = ((memo && memo.taskIds) || []).map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
  if (linked.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={styles.wrap}>
      {linked.map((t) => (
        <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`연결된 ${t.title} 열기`} onPress={() => navigation.navigate(ROUTES.TaskEdit, { taskId: t.id })} style={styles.chip}>
          <Text style={styles.text} numberOfLines={1}>🔗 {t.title}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 0 },
  row: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  chip: { maxWidth: 220, minHeight: 32, paddingHorizontal: spacing.md, borderRadius: 16, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
});
