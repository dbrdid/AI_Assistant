// ============================================================
// DateTimePicker.js — 날짜 / 시간 고르기 창 (외부 패키지 없이 직접 만든 것)
// ============================================================
//   DatePickerModal : 월 달력에서 날짜 선택 (‹ › 로 달 이동)
//   TimePickerModal : 시 / 분(5분 단위) 목록에서 선택, "지우기" 로 시간 없음 처리

import React, { useLayoutEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../theme/theme';
import { SheetModal } from './Motion';
import { WEEKDAYS, fromKey, isSameDay, monthMatrix, toKey } from '../../features/calendar/utils/DateUtils';

export function DatePickerModal({ visible, value, onPick, onClose }) {
  const selected = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toKey(fromKey(value)) === value
    ? fromKey(value)
    : null;
  const base = selected ?? new Date();
  const year = base.getFullYear();
  const month = base.getMonth();
  const [cur, setCur] = useState({ y: year, m: month });
  useLayoutEffect(() => {
    if (visible) setCur({ y: year, m: month });
  }, [visible, year, month]);
  const weeks = monthMatrix(cur.y, cur.m);
  const shift = (n) => setCur(previous => {
    const d = new Date(previous.y, previous.m + n, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  return (
    <SheetModal visible={visible} onClose={onClose} label="날짜 선택" style={styles.dialog}>
      <View style={styles.navRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="이전 달" onPress={() => shift(-1)} hitSlop={10}><Text style={styles.nav}>‹</Text></Pressable>
        <Text style={styles.navTitle}>{cur.y}년 {cur.m + 1}월</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="다음 달" onPress={() => shift(1)} hitSlop={10}><Text style={styles.nav}>›</Text></Pressable>
      </View>
      <View style={styles.row}>
        {WEEKDAYS.map((w, i) => (
          <Text key={w} style={[styles.wd, i === 0 && { color: colors.coral }, i === 6 && { color: colors.mintDark }]}>{w}</Text>
        ))}
      </View>
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.row}>
          {week.map((d, di) =>
            d ? (
              <Pressable
                key={di}
                accessibilityRole="button"
                accessibilityLabel={`${cur.m + 1}월 ${d.getDate()}일`}
                accessibilityState={{ selected: Boolean(selected && isSameDay(d, selected)) }}
                onPress={() => onPick(toKey(d))}
                style={styles.dayCell}
              >
                <View style={[styles.day, selected && isSameDay(d, selected) && styles.dayOn]}>
                  <Text style={[styles.dayText, di === 0 && { color: colors.coral }, selected && isSameDay(d, selected) && styles.optTextOn]}>{d.getDate()}</Text>
                </View>
              </Pressable>
            ) : (
              <View key={di} style={styles.dayCell} />
            ),
          )}
        </View>
      ))}
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.closeBtn}><Text style={styles.closeText}>닫기</Text></Pressable>
    </SheetModal>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

export function TimePickerModal({ visible, value, title, onPick, onClear, onClose }) {
  const [h, m] = typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value.split(':')
    : ['09', '00'];
  const [hh, setHh] = useState(h);
  const [mm, setMm] = useState(m);
  const minutes = MINUTES.includes(m) ? MINUTES : [...MINUTES, m].sort();
  useLayoutEffect(() => {
    if (!visible) return;
    setHh(h);
    setMm(m);
  }, [visible, h, m]);
  return (
    <SheetModal visible={visible} onClose={onClose} label={title || '시간 선택'} style={styles.dialog}>
      <Text style={styles.navTitle}>{title || '시간 선택'}</Text>
      <View style={styles.cols}>
        <ScrollView showsHorizontalScrollIndicator={false} style={styles.col}>
          {HOURS.map((x) => (
            <Pressable key={x} accessibilityRole="button" accessibilityState={{ selected: hh === x }} onPress={() => setHh(x)} style={[styles.opt, hh === x && styles.optOn]}>
              <Text style={[styles.optText, hh === x && styles.optTextOn]}>{x}시</Text>
            </Pressable>
          ))}
        </ScrollView>
        <ScrollView showsHorizontalScrollIndicator={false} style={styles.col}>
          {minutes.map((x) => (
            <Pressable key={x} accessibilityRole="button" accessibilityState={{ selected: mm === x }} onPress={() => setMm(x)} style={[styles.opt, mm === x && styles.optOn]}>
              <Text style={[styles.optText, mm === x && styles.optTextOn]}>{x}분</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={onClear} style={[styles.btn, styles.btnGhost]}><Text style={styles.closeText}>지우기</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} style={[styles.btn, styles.btnGhost]}><Text style={styles.closeText}>취소</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => onPick(`${hh}:${mm}`)} style={[styles.btn, { backgroundColor: colors.action }]}><Text style={[styles.closeText, { color: colors.onPrimary }]}>확인</Text></Pressable>
      </View>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  dialog: { gap: spacing.sm },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nav: { fontSize: 28, color: colors.ink, paddingHorizontal: spacing.sm },
  navTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink, textAlign: 'center' },
  row: { flexDirection: 'row', gap: spacing.sm },
  wd: { flex: 1, textAlign: 'center', fontSize: font.caption, fontWeight: '500', color: colors.muted },
  dayCell: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' },
  day: { width: 34, height: 34, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  dayOn: { borderWidth: 1, borderColor: colors.ink },
  dayText: { fontSize: font.body, color: colors.ink },
  closeBtn: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  cols: { flexDirection: 'row', gap: spacing.md, height: 240 },
  col: { flex: 1 },
  opt: { minHeight: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  optOn: { borderColor: colors.ink },
  optText: { fontSize: font.bodyLg, color: colors.ink },
  optTextOn: { color: colors.ink, fontWeight: '600' },
  btn: { flex: 1, minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.line },
});
