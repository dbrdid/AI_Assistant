// ============================================================
// MemoLinks.js — 메모에 연결된 일정·할 일 줄
// ============================================================

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { useMemos } from '../../../data/memos/MemoStore';
import { useTasks } from '../../../data/tasks/TaskStore';

// 연결(고리) 아이콘 (Icon.js 에 없어서 여기서 그림)
function LinkIcon({ size = 13, color = colors.mintDark }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <Path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  );
}

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
          <LinkIcon />
          <Text style={styles.text} numberOfLines={1}>{t.title}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 0 },
  row: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: { flexDirection: 'row', gap: 4, maxWidth: 220, minHeight: 30, paddingHorizontal: spacing.md, borderRadius: 999, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  text: { flexShrink: 1, fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
});
