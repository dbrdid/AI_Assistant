// ============================================================
// CalendarSearch.js — 캘린더 일정 검색
// ============================================================

import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import Icon from '../../../shared/components/Icon';
import ScheduleRow from './ScheduleRow';
import { shortDate, tagText } from '../../../data/tasks/TaskStore';
import { toKey } from '../utils/DateUtils';

export default function CalendarSearch({ query, onChange, matches, onPick, onClose }) {
  const todayKey = toKey(new Date());
  const hasQuery = query.trim().length > 0;

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Icon name="search" size={18} color={colors.muted} />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={onChange}
          placeholder="일정 제목, 장소, 설명 검색"
          placeholderTextColor={colors.muted}
          autoFocus
          returnKeyType="search"
          accessibilityLabel="일정 검색어 입력"
        />
        <Pressable accessibilityRole="button" accessibilityLabel="검색 닫기" onPress={onClose} hitSlop={10}>
          <Icon name="x" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {!hasQuery ? null : matches.length === 0 ? (
        <Text style={styles.hint}>"{query.trim()}"에 해당하는 일정이 없어요.</Text>
      ) : (
        <>
          <Text style={styles.count}>일정 {matches.length}개</Text>
          {matches.map((t) => (
            <ScheduleRow
              key={t.id}
              item={t}
              details={[shortDate(t), tagText(t, todayKey), t.place]}
              onPress={() => onPick(t)}
            />
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  input: { flex: 1, fontSize: font.bodyLg, color: colors.ink, paddingVertical: 8 },
  hint: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  count: { fontSize: font.caption, fontWeight: '500', color: colors.muted },
});
