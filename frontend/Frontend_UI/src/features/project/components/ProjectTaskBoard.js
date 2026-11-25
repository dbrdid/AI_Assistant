import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { alertUser } from '../../../data/alert';
import { STATUSES, updateTask } from '../../../data/tasks/TaskStore';
import { Chip } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

export default function ProjectTaskBoard({ tasks, canEdit, onOpen }) {
  const statuses = [...new Set([...STATUSES, ...tasks.map(task => task.status)])];
  const moveTask = (task, status) => {
    try {
      updateTask(task.id, { status }, { expectedRevision: task.revision });
    } catch (error) {
      alertUser('상태를 변경하지 못했어요', error.code === 'revision_conflict'
        ? '할 일이 다른 곳에서 수정됐어요. 최신 상태를 확인해 주세요.'
        : '잠시 뒤 다시 시도해 주세요.');
    }
  };
  if (tasks.length === 0) return <Text style={styles.empty}>프로젝트에 연결된 할 일이 없어요.</Text>;
  return (
    <ScrollView horizontal>
        <View style={styles.board}>
          {statuses.map(status => {
            const group = tasks.filter(task => task.status === status);
            return (
              <View key={status} style={styles.column}>
                <Text accessibilityRole="header" style={styles.heading}>{status} {group.length}</Text>
                {group.map(task => (
                  <View key={task.id} style={styles.card}>
                    <Pressable accessibilityRole="button" accessibilityLabel={`${task.title} 열기`} onPress={() => onOpen(task.id)} style={styles.open}>
                      <Text style={styles.title}>{task.title}</Text>
                      {!!task.date && <Text style={styles.date}>{task.date}</Text>}
                    </Pressable>
                    {canEdit && (
                      <View style={styles.actions}>
                        {STATUSES.filter(next => next !== task.status).map(next => (
                          <Chip key={next} label={next} onPress={() => moveTask(task, next)} />
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            );
          })}
        </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  board: { flexDirection: 'row', gap: spacing.md },
  column: { width: 232, gap: spacing.sm, paddingVertical: spacing.xs },
  heading: { fontSize: font.body, fontWeight: '500', color: colors.ink, paddingHorizontal: spacing.xs },
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.card },
  open: { minHeight: 48, padding: spacing.md, justifyContent: 'center', gap: spacing.xs },
  title: { fontSize: font.body, fontWeight: '600', color: colors.ink },
  date: { fontSize: font.caption, color: colors.muted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.md },
});
