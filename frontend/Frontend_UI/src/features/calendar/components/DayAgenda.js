// ============================================================
// DayAgenda.js — 캘린더에서 "선택한 날짜"의 정보와 일정 목록
// ============================================================
// 스토리보드 "캘린더" 46~47장
//   - 날짜 제목:  10일 화요일  ·  음력 8월 30일  ·  (공휴일이면 이름)
//   - "10월 10일에 추가" 줄을 누르면 일정 추가 화면으로 이동
//   - 그날의 일정 목록: 왼쪽 체크박스(완료 표시), 제목, 시간 · 꼬리표(임박 등)
//   - 일정을 "꾹 누르면" 아래에 [편집] [삭제] 버튼이 나타남. (삭제는 확인 창을 거침)
//
// props
//   selected    : 선택한 날짜(Date)
//   tasks       : 전체 항목 목록 (이 안에서 선택한 날짜 것만 골라 보여줌)
//   holidayName : 공휴일 이름 (없으면 undefined)
//   lunarText   : "음력 8월 30일" (없으면 null)
//   onAdd(dateKey) / onEdit(id)

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { WEEKDAYS_LONG, toKey } from '../utils/DateUtils';
import { deleteTask, tagText, toggleDone } from '../../../data/tasks/TaskStore';

export default function DayAgenda({ selected, tasks, holidayName, lunarText, onAdd, onEdit }) {
  const key = toKey(selected);
  const todayKey = toKey(new Date());
  const items = tasks.filter((t) => t.date === key); // 이미 시간순으로 정렬되어 들어옴

  const [actionId, setActionId] = useState(null);   // 꾹 눌러서 [편집][삭제] 가 열린 항목
  const [confirmId, setConfirmId] = useState(null); // 삭제 확인 창에 올린 항목

  const m = selected.getMonth() + 1;
  const d = selected.getDate();

  return (
    <View style={styles.root}>
      {/* 날짜 제목 + 음력 + 공휴일 */}
      <View style={styles.titleRow}>
        <Text style={styles.title}>{d}일 {WEEKDAYS_LONG[selected.getDay()]}</Text>
        {lunarText ? <Text style={styles.lunar}>{lunarText}</Text> : null}
        {holidayName ? <Text style={styles.holiday}>{holidayName}</Text> : null}
      </View>

      {/* 추가 줄 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${m}월 ${d}일에 일정 추가`}
        onPress={() => onAdd(key)}
        style={({ pressed }) => [styles.addRow, pressed && { backgroundColor: colors.mintSoft }]}
      >
        <Text style={styles.addPlus}>＋</Text>
        <Text style={styles.addText}>{m}월 {d}일에 추가</Text>
      </Pressable>

      {/* 그날의 일정 */}
      {items.length === 0 ? (
        <Text style={styles.empty}>이 날은 일정이 없어요</Text>
      ) : (
        items.map((t) => {
          const done = t.status === '완료';
          const open = actionId === t.id;
          const time = t.start ? (t.end ? `${t.start}~${t.end}` : t.start) : '';
          return (
            <View key={t.id} style={[styles.item, open && styles.itemOpen]}>
              <View style={styles.itemMain}>
                {/* 완료 체크박스 */}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: done }}
                  accessibilityLabel={`${t.title} 완료 표시`}
                  onPress={() => toggleDone(t.id)}
                  hitSlop={8}
                >
                  <Text style={[styles.check, done && styles.checkOn]}>{done ? '☑' : '☐'}</Text>
                </Pressable>
                {/* 내용: 짧게 누르면 편집 화면, 꾹 누르면 [편집][삭제] */}
                <Pressable
                  style={styles.itemBody}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.title} 일정`}
                  onPress={() => (open ? setActionId(null) : onEdit(t.id))}
                  onLongPress={() => setActionId(open ? null : t.id)}
                  delayLongPress={350}
                >
                  <Text style={[styles.itemTitle, done && styles.itemTitleDone]} numberOfLines={1}>{t.title}</Text>
                  <Text style={styles.itemMeta} numberOfLines={1}>
                    {[time, tagText(t, todayKey), t.place].filter(Boolean).join(' · ')}
                  </Text>
                </Pressable>
              </View>

              {open && (
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setActionId(null);
                      onEdit(t.id);
                    }}
                    style={[styles.actionBtn, styles.editBtn]}
                  >
                    <Text style={styles.editText}>편집</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setConfirmId(t.id)}
                    style={[styles.actionBtn, styles.delBtn]}
                  >
                    <Text style={styles.delText}>삭제</Text>
                  </Pressable>
                </View>
              )}
            </View>
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
          deleteTask(confirmId);
          setConfirmId(null);
          setActionId(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: spacing.sm },
  title: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  lunar: { fontSize: font.caption, fontWeight: '500', color: '#A3B1AC' },
  holiday: { fontSize: font.caption, fontWeight: '700', color: colors.coral },

  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    borderRadius: 23,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  addPlus: { fontSize: 18, color: colors.mintDark, fontWeight: '800' },
  addText: { fontSize: font.body, color: colors.muted },

  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.sm },

  item: {
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.md,
    gap: spacing.sm,
  },
  itemOpen: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  itemMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  check: { fontSize: 24, color: colors.muted },
  checkOn: { color: colors.mintDark },
  itemBody: { flex: 1, gap: 2, minHeight: 40, justifyContent: 'center' },
  itemTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  itemTitleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  itemMeta: { fontSize: font.caption, color: colors.muted },

  actions: { flexDirection: 'row', gap: spacing.sm },
  actionBtn: { flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  editBtn: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  editText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  delBtn: { backgroundColor: colors.coral },
  delText: { fontSize: font.body, fontWeight: '700', color: colors.white },
});
