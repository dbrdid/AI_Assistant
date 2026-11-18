// ============================================================
// DayAgenda.js — 캘린더에서 선택한 날짜의 정보와 일정 목록
// ============================================================
// Figma 시안: '15일 일요일' + '오늘 · 일정 1 · 할 일 2' + 오른쪽 '+ 추가' 알약
// 항목 카드: 왼쪽 시간(시작/끝) · 색 막대(일정 = 민트, 할 일 = 진녹색, 완료 = 흐린 선) · 제목 · 아이콘 설명 · 할 일은 오른쪽 체크박스

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import { Card } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { WEEKDAYS_LONG, toKey } from '../utils/DateUtils';
import { classify, deleteTask, occursOn, shortDate, taskIn, toggleDone } from '../../../data/tasks/TaskStore';

// spaces: 여러 공간을 합쳐 볼 때 { 공간 id: { name, color } } (색 막대·공간 이름에 씀). 한 공간뿐이면 null
export default function DayAgenda({ selected, tasks, spaces, holidayName, lunarText, onAdd, onEdit }) {
  const key = toKey(selected);
  const todayKey = toKey(new Date());
  const items = tasks.filter((t) => occursOn(t, key)); // 이미 시간순으로 정렬되어 들어옴 (여러 날 일정은 걸친 날마다)

  const [actionId, setActionId] = useState(null);   // 꾹 눌러서 [편집][삭제] 가 열린 항목
  const [confirmId, setConfirmId] = useState(null); // 삭제 확인 창에 올린 항목

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
    .join(' · ');

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
          <Icon name="plus" size={16} color={colors.mintDark} strokeWidth={2.4} />
          <Text style={styles.addText}>추가</Text>
        </Pressable>
      </View>

      {/* 그날의 일정 */}
      {items.length === 0 ? (
        <Text style={styles.empty}>이 날은 일정이 없어요</Text>
      ) : (
        items.map((t) => {
          const done = t.status === '완료';
          const open = actionId === t.id;
          const isEvent = t.kind === 'event';
          const c = classify(t, todayKey);
          // 설명 줄: 일정은 📍장소, 할 일은 '할 일 · 프로젝트(또는 완료/초과)'
          const subIcon = isEvent ? (t.place ? 'pin' : 'calendar') : 'checkCircle';
          const span = t.endDate ? `${shortDate(t.date)}~${shortDate(t.endDate)}` : null; // 여러 날 일정
          const space = spaces ? spaces[t.workspaceId] : null;
          const subText = isEvent
            ? [space?.name, span, t.place || (span || space ? null : '일정'), t.project].filter(Boolean).join(' · ')
            : [space?.name ?? '할 일', done ? '완료' : t.project, c === 'overdue' ? '초과' : null].filter(Boolean).join(' · ');
          // 색 막대: 여러 공간이면 공간 색, 아니면 일정 = 민트 · 할 일 = 진녹색
          const barColor = done ? colors.line : space ? space.color : isEvent ? colors.mint : colors.mintDark;
          const toggle = () => (t.workspaceId ? taskIn(t, 'toggleDone', t.id) : toggleDone(t.id)); // 합쳐 볼 때는 그 항목의 공간에서
          return (
            <Card key={t.id} style={[styles.item, open && styles.itemOpen]}>
              <View style={styles.itemMain}>
                {/* 내용: 짧게 누르면 편집 화면, 꾹 누르면 [편집][삭제] */}
                <Pressable
                  style={styles.itemBody}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.title} ${isEvent ? '일정' : '할 일'}`}
                  onPress={() => (open ? setActionId(null) : onEdit(t))}
                  onLongPress={() => setActionId(open ? null : t.id)}
                  delayLongPress={350}
                >
                  {/* 시간: 시작(굵게) / 끝(흐리게) */}
                  <View style={styles.timeCol}>
                    <Text style={[styles.timeStart, !t.start && styles.timeAllDay]}>{t.start || '종일'}</Text>
                    {t.end ? <Text style={styles.timeEnd}>{t.end}</Text> : null}
                  </View>
                  <View style={[styles.bar, { backgroundColor: barColor }]} />
                  <View style={styles.textCol}>
                    <Text style={[styles.itemTitle, done && styles.itemTitleDone]} numberOfLines={1}>{t.title}</Text>
                    <View style={styles.metaRow}>
                      <Icon name={subIcon} size={14} color={c === 'overdue' ? colors.coral : colors.muted} />
                      <Text style={[styles.itemMeta, c === 'overdue' && { color: colors.coral }]} numberOfLines={1}>{subText}</Text>
                    </View>
                  </View>
                </Pressable>
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

              {open && (
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setActionId(null);
                      onEdit(t);
                    }}
                    style={[styles.actionBtn, styles.editBtn]}
                  >
                    <Text style={styles.editText}>편집</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setConfirmId(t)}
                    style={[styles.actionBtn, styles.delBtn]}
                  >
                    <Text style={styles.delText}>삭제</Text>
                  </Pressable>
                </View>
              )}
            </Card>
          );
        })
      )}

      <ConfirmDialog
        visible={confirmId !== null}
        title="일정을 삭제할까요?"
        sub="삭제한 일정은 복구할 수 없어요."
        confirmText="삭제"
        danger
        onCancel={() => setConfirmId(null)}
        onConfirm={() => {
          if (confirmId.workspaceId) taskIn(confirmId, 'deleteTask', confirmId.id);
          else deleteTask(confirmId.id);
          setConfirmId(null);
          setActionId(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: 2 },
  headText: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: spacing.sm },
  title: { fontSize: 18, fontWeight: '800', color: colors.ink },
  holiday: { fontSize: font.caption, fontWeight: '700', color: colors.coral },
  sub: { fontSize: 13, color: colors.muted },

  // '+ 추가' 알약 (연한 민트 바탕 + 진녹색 글자)
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.mintSoft,
  },
  addText: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },

  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.sm },

  item: { paddingVertical: 12, paddingHorizontal: spacing.lg, gap: spacing.sm },
  itemOpen: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  itemMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  itemBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  timeCol: { width: 46, gap: 2 },
  timeStart: { fontSize: 15, fontWeight: '800', color: colors.ink },
  timeAllDay: { fontSize: 13, color: colors.muted },
  timeEnd: { fontSize: 13, color: colors.muted },
  bar: { width: 3, alignSelf: 'stretch', borderRadius: 2, minHeight: 36 },
  textCol: { flex: 1, gap: 4 },
  itemTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  itemTitleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  itemMeta: { flex: 1, fontSize: 13, color: colors.muted },
  check: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },

  actions: { flexDirection: 'row', gap: spacing.sm },
  actionBtn: { flex: 1, minHeight: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  editBtn: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  editText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  delBtn: { backgroundColor: colors.coral },
  delText: { fontSize: font.body, fontWeight: '700', color: colors.white },
});
