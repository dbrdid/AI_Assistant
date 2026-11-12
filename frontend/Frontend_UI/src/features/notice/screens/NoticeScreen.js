// ============================================================
// NoticeScreen.js — 알림 (스토리보드 29장)
// ============================================================
// 오늘 온 알림(일정 · 할 일 마감 · 브리핑 · AI 확인 요청 · 프로젝트)을 모아 보는 화면.
//   - 위쪽 칩으로 종류별로 걸러 보기, 칩 아래 한 줄에 [모두 읽음] · [모두 지우기]
//   - 알림을 누르면 읽음 처리하고 해당 화면(일정/프로젝트/브리핑)으로 이동, ✕ 로 하나씩 지우기
//   - 안 읽은 알림에는 민트색 점 / 화면에 들어오면 한꺼번에 읽음 처리하지 않고 눌러야 읽음

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { dateLabel } from '../../memo/components/MemoCard';
import { clearNotices, markAllRead, markRead, removeNotice, useNotices } from '../../../data/notices/NoticeStore';

const KIND = {
  schedule: { label: '일정', icon: '🗓️' },
  due: { label: '마감', icon: '⏰' },
  brief: { label: '브리핑', icon: '📋' },
  ai: { label: 'AI 확인', icon: '✦' },
  project: { label: '프로젝트', icon: '📁' },
};
const FILTERS = [{ id: 'all', label: '전체' }, ...Object.keys(KIND).map((k) => ({ id: k, label: KIND[k].label }))];

export default function NoticeScreen({ navigation }) {
  const all = useNotices();
  const [filter, setFilter] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const list = filter === 'all' ? all : all.filter((n) => n.kind === filter);
  const unread = all.filter((n) => !n.read).length;

  return (
    <View style={styles.root}>
      <ScreenHeader title="알림" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {FILTERS.map((f) => (
            <Pressable key={f.id} accessibilityRole="button" accessibilityState={{ selected: filter === f.id }} onPress={() => setFilter(f.id)} style={[styles.chip, filter === f.id && styles.chipOn]}>
              <Text style={[styles.chipText, filter === f.id && { color: colors.white }]}>{f.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {all.length > 0 && (
          <View style={styles.actions}>
            {unread > 0 ? (
              <Pressable accessibilityRole="button" onPress={markAllRead} hitSlop={8}>
                <Text style={styles.readAllText} numberOfLines={1}>안 읽은 {unread}개 · 모두 읽음</Text>
              </Pressable>
            ) : (
              <Text style={styles.allRead}>모두 읽었어요</Text>
            )}
            <Pressable accessibilityRole="button" onPress={() => setConfirmClear(true)} hitSlop={8}>
              <Text style={styles.clear} numberOfLines={1}>모두 지우기</Text>
            </Pressable>
          </View>
        )}

        {list.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{all.length === 0 ? '새 알림이 없어요' : '이 종류의 알림이 없어요'}</Text>
            <Text style={styles.emptySub}>일정이나 할 일에 알림을 설정하면 여기에 모여요.{'\n'}알림 종류와 방해 금지 시간은 설정 &gt; 알림 설정에서 바꿀 수 있어요.</Text>
          </View>
        ) : (
          list.map((n) => {
            const k = KIND[n.kind] || KIND.project;
            return (
              <Pressable
                key={n.id}
                accessibilityRole="button"
                accessibilityLabel={`${k.label} 알림 ${n.title}. ${n.body}`}
                onPress={() => {
                  markRead(n.id);
                  if (n.route) navigation.navigate(n.route, n.params);
                }}
                style={({ pressed }) => [styles.card, !n.read && styles.cardNew, pressed && { opacity: 0.75 }]}
              >
                <Text style={styles.icon}>{k.icon}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.titleRow}>
                    {!n.read && <View style={styles.dot} />}
                    <Text style={styles.title} numberOfLines={1}>{n.title}</Text>
                  </View>
                  <Text style={styles.body} numberOfLines={2}>{n.body}</Text>
                  <Text style={styles.time}>{k.label} · {dateLabel(n.at)}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="이 알림 지우기" onPress={() => removeNotice(n.id)} hitSlop={10}>
                  <Text style={styles.x}>✕</Text>
                </Pressable>
              </Pressable>
            );
          })
        )}
      </ScrollView>
      <ConfirmDialog
        visible={confirmClear}
        title="알림을 모두 지울까요?"
        sub="지운 알림은 다시 볼 수 없어요."
        confirmText="모두 지우기"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          clearNotices();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 40 },
  allRead: { fontSize: font.body, color: colors.muted },
  clear: { fontSize: font.body, fontWeight: '700', color: colors.coral },
  chips: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: { minHeight: 36, paddingHorizontal: spacing.lg, borderRadius: 18, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  readAllText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  empty: { alignItems: 'center', paddingTop: 80, gap: spacing.sm },
  emptyTitle: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 21 },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  cardNew: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  icon: { fontSize: 24 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.mintDark },
  title: { flex: 1, fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  body: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  time: { fontSize: font.caption, color: colors.muted },
  x: { fontSize: 16, color: colors.muted, paddingHorizontal: 4 },
});
