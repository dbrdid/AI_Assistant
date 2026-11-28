// ============================================================
// DayAgenda.js — 캘린더에서 선택한 날짜의 정보와 일정 목록
// ============================================================
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../../../shared/components/Icon';
import ScheduleRow from './ScheduleRow';
import { InlineDeletePrompt } from '../../../shared/components/Ui';
import { useClaimSwipeGesture } from '../../../shared/hooks/useClaimSwipeGesture';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { WEEKDAYS_LONG, toKey } from '../utils/DateUtils';
import { relativeTime } from '../utils/relativeTime.mjs';
import { classify, deleteTask, occursOn, shortDate, taskIn, toggleDone } from '../../../data/tasks/TaskStore';

// spaces: 여러 공간을 한 목록에 표시할 때 사용하는 공간 정보.
export default function DayAgenda({ selected, tasks, spaces, holidayName, lunarText, onAdd, onEdit }) {
  const claimSwipe = useClaimSwipeGesture();
  const key = toKey(selected);
  const now = new Date();
  const todayKey = toKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const items = tasks.filter((t) => occursOn(t, key)); // 이미 시간순으로 정렬되어 들어옴 (여러 날 일정은 걸친 날마다)

  const [selection, setSelection] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setSelection(null); setError(''); }, [key, spaces]);
  const selectedItem = selection?.date === key ? items.find(item => item.id === selection.id) : null;
  const select = (item) => {
    setError('');
    setSelection(item === selectedItem ? null : { date: key, id: item.id });
  };
  const deleteSelected = () => {
    if (!selectedItem) return;
    try {
      if (selectedItem.workspaceId) taskIn(selectedItem, 'deleteTask', selectedItem.id);
      else deleteTask(selectedItem.id);
      setSelection(null);
      setError('');
    } catch (error) {
      setError(error.code === 'read_only' ? '보기 전용 공간의 항목은 삭제할 수 없어요.' : '삭제하지 못했어요.');
    }
  };

  const m = selected.getMonth() + 1;
  const d = selected.getDate();

  // 부제: 오늘 · 일정 n · 할 일 n · 음력
  const events = items.filter((t) => t.kind === 'event').length;
  const todos = items.length - events;
  const sub = [
    key === todayKey ? '오늘' : null,
    events ? `일정 ${events}` : null,
    todos ? `할 일 ${todos}` : null,
    lunarText || null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={styles.root}>
      {/* 날짜 제목 + 부제 + 오른쪽 '+ 추가' */}
      <View style={styles.headRow}>
        <View style={styles.headText}>
          <View style={styles.titleRow}>
            <Text style={styles.title} accessibilityRole="header">{d}일 {WEEKDAYS_LONG[selected.getDay()]}</Text>
            {holidayName ? <Text style={styles.holiday}>{holidayName}</Text> : null}
          </View>
          {sub ? <Text style={styles.sub} numberOfLines={1}>{sub}</Text> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${m}월 ${d}일에 일정 추가`}
          onPress={() => onAdd(key)}
          hitSlop={6}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.75 }]}
        >
          <Icon name="plus" size={14} color={colors.mintDark} strokeWidth={2.4} />
          <Text style={styles.addText}>추가</Text>
        </Pressable>
      </View>

      {/* 그날의 일정 */}
      {items.length === 0 ? (
        <Text style={styles.empty}>이 날은 일정이 없어요</Text>
      ) : (
        items.map((t) => {
          const done = t.status === '완료';
          const open = selectedItem === t;
          const isEvent = t.kind === 'event';
          const c = classify(t, todayKey);
          const span = t.endDate ? `${shortDate(t.date)}~${shortDate(t.endDate)}` : null; // 여러 날 일정
          const space = spaces ? spaces[t.workspaceId] : null;
          // 오늘 일정: 시작까지 남은 시간 또는 진행 중 남은 시간 (Notion 캘린더의 예정, 남음 표시)
          const rel = isEvent && !done && key === todayKey ? relativeTime(t.start, t.end, nowMinutes) : null;
          const details = isEvent
            ? [space?.name, span, t.place, rel, t.project]
            : [space?.name ?? '할 일', done ? '완료' : t.project, c === 'overdue' ? '초과' : null];
          const toggle = () => (t.workspaceId ? taskIn(t, 'toggleDone', t.id) : toggleDone(t.id)); // 합쳐 볼 때는 그 항목의 공간에서
          return (
            <View key={t.id} style={[styles.item, open && styles.itemOpen]}>
              <View style={styles.itemMain}>
                <ScheduleRow
                  item={t}
                  details={details}
                  selected={open}
                  overdue={c === 'overdue'}
                  style={styles.itemBody}
                  onPress={() => (selectedItem ? select(t) : onEdit(t))}
                  onLongPress={() => { claimSwipe(); select(t); }}
                />
                {/* 완료 체크박스 (할 일만) */}
                {!isEvent && (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: done }}
                    accessibilityLabel={`${t.title} 완료 표시`}
                    onPress={toggle}
                    hitSlop={10}
                    style={styles.check}
                  >
                    <Icon name={done ? 'checkSquare' : 'square'} size={24} color={done ? colors.mintDark : colors.muted} />
                  </Pressable>
                )}
              </View>

            </View>
          );
        })
      )}

      {selectedItem && (
        <InlineDeletePrompt
          question={selectedItem.kind === 'event' ? '일정을 삭제할까요?' : '할 일을 삭제할까요?'}
          hint="삭제한 항목은 복구할 수 없어요."
          onDelete={deleteSelected}
        />
      )}
      {!!error && <Text accessibilityRole="alert" style={styles.itemMeta}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: 2 },
  headText: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: spacing.sm },
  title: { fontSize: 18, fontWeight: '600', color: colors.ink },
  holiday: { fontSize: font.caption, fontWeight: '500', color: colors.coral },
  sub: { fontSize: 13, color: colors.muted },

  // '+ 추가': 홈 오늘의 '+ 추가'와 같은 면 없는 흐린 글자
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, minHeight: 44, minWidth: 44 },
  addText: { fontSize: font.caption, fontWeight: '500', color: colors.muted },

  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.sm },

  item: { paddingVertical: 6, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 6, borderWidth: 1, borderColor: 'transparent', gap: spacing.sm },
  itemOpen: { borderColor: colors.actionBorder, backgroundColor: colors.card },
  itemMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  itemBody: { flex: 1 },
  itemMeta: { flex: 1, fontSize: 13, color: colors.muted },
  check: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },

});
