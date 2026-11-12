// ============================================================
// TaskListScreen.js — 할 일 목록 (스토리보드 78~81장)
// ============================================================
// 필터 칩: 전체 / 오늘 / 예정 / 임박 / 초과 / 완료 (각각 개수 표시)
// 항목: 체크박스(완료) + 제목 + "MM/DD · 꼬리표". 누르면 편집, 완료 항목은 맨 아래.

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { toKey } from '../../calendar/utils/DateUtils';
import { classify, shortDate, tagText, toggleDone, useTasks } from '../../../data/tasks/TaskStore';

const FILTERS = [
  { id: 'all', label: '전체' },
  { id: 'today', label: '오늘' },
  { id: 'upcoming', label: '예정' },
  { id: 'soon', label: '임박' },
  { id: 'overdue', label: '초과' },
  { id: 'done', label: '완료' },
];

export default function TasksScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu();
  const tasks = useTasks();
  const [filter, setFilter] = useState('all');
  const todayKey = toKey(new Date());

  const counts = useMemo(() => {
    const c = { all: tasks.length, today: 0, upcoming: 0, soon: 0, overdue: 0, done: 0 };
    tasks.forEach((t) => {
      c[classify(t, todayKey)] += 1;
    });
    return c;
  }, [tasks, todayKey]);

  const list = useMemo(() => {
    const filtered = filter === 'all' ? tasks : tasks.filter((t) => classify(t, todayKey) === filter);
    // 완료 항목은 맨 아래
    return filtered.slice().sort((a, b) => (a.status === '완료') - (b.status === '완료'));
  }, [tasks, filter, todayKey]);

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader title="할 일 목록" />
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <Pressable
                key={f.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setFilter(f.id)}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label} {counts[f.id]}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate(ROUTES.TaskEdit, { date: todayKey })}
          style={styles.add}
        >
          <Text style={styles.addText}>＋ 할 일 추가</Text>
        </Pressable>

        {list.length === 0 ? (
          <Text style={styles.empty}>해당하는 항목이 없어요</Text>
        ) : (
          list.map((t) => {
            const done = t.status === '완료';
            const c = classify(t, todayKey);
            return (
              <View key={t.id} style={styles.item}>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: done }}
                  accessibilityLabel={`${t.title} 완료 표시`}
                  onPress={() => toggleDone(t.id)}
                  hitSlop={8}
                >
                  <Text style={[styles.check, done && { color: colors.mintDark }]}>{done ? '☑' : '☐'}</Text>
                </Pressable>
                <Pressable
                  style={styles.body}
                  accessibilityRole="button"
                  onPress={() => navigation.navigate(ROUTES.TaskEdit, { taskId: t.id })}
                >
                  <Text style={[styles.title, done && styles.titleDone]} numberOfLines={1}>{t.title}</Text>
                  <Text style={[styles.meta, c === 'overdue' && { color: colors.coral, fontWeight: '700' }]} numberOfLines={1}>
                    {shortDate(t)} · {tagText(t, todayKey)}{t.start ? ` · ${t.start}` : ''}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  chips: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.md },
  chip: { paddingHorizontal: spacing.lg, minHeight: 38, borderRadius: 19, justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  chipTextOn: { color: colors.white },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  add: { minHeight: 46, borderRadius: 23, borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  addText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.lg, textAlign: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  check: { fontSize: 24, color: colors.muted },
  body: { flex: 1, minHeight: 40, justifyContent: 'center', gap: 2 },
  title: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  titleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  meta: { fontSize: font.caption, color: colors.muted },
});
