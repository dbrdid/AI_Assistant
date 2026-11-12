// ============================================================
// CalendarSearch.js — 캘린더 일정 검색
// ============================================================

import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { shortDate, tagText } from '../../../data/tasks/TaskStore';
import { toKey } from '../utils/DateUtils';

export default function CalendarSearch({ query, onChange, matches, onPick, onClose }) {
  const todayKey = toKey(new Date());
  const hasQuery = query.trim().length > 0;

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Text style={styles.icon}>🔍</Text>
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
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      {!hasQuery ? (
        <Text style={styles.hint}>검색어와 일치하는 일정이 있는 날짜가 달력에 표시돼요.</Text>
      ) : matches.length === 0 ? (
        <Text style={styles.hint}>"{query.trim()}"에 해당하는 일정이 없어요.</Text>
      ) : (
        <>
          <Text style={styles.count}>일정 {matches.length}개</Text>
          {matches.map((t) => (
            <Pressable
              key={t.id}
              accessibilityRole="button"
              accessibilityLabel={`${t.title}, ${shortDate(t)}`}
              onPress={() => onPick(t)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.mintSoft }]}
            >
              <Text style={styles.date}>{shortDate(t)}</Text>
              <View style={styles.body}>
                <Text style={styles.title} numberOfLines={1}>{t.title}</Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {[t.start, tagText(t, todayKey), t.place].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </Pressable>
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
    minHeight: 46,
    borderRadius: 23,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  icon: { fontSize: 16 },
  input: { flex: 1, fontSize: font.bodyLg, color: colors.ink, paddingVertical: 8 },
  close: { fontSize: 16, color: colors.muted },
  hint: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  count: { fontSize: font.caption, color: colors.muted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  date: { fontSize: font.body, fontWeight: '800', color: colors.mintDark, minWidth: 44 },
  body: { flex: 1, gap: 2 },
  title: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  meta: { fontSize: font.caption, color: colors.muted },
});
