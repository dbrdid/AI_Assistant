// ============================================================
// DateTimePicker.js — 날짜 / 시간 고르기 창 (외부 패키지 없이 직접 만든 것)
// ============================================================
//   DatePickerModal : 월 달력에서 날짜 선택 (‹ › 로 달 이동)
//   TimePickerModal : 시 / 분(5분 단위) 목록에서 선택, "지우기" 로 시간 없음 처리

import React, { useLayoutEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../theme/theme';
import { SheetModal } from './Motion';
import Icon from './Icon';
import YearMonthWheel from './YearMonthWheel';
import { WEEKDAYS, fromKey, isSameDay, monthMatrix, toKey } from '../../features/calendar/utils/DateUtils';

export function DatePickerModal({ visible, value, onPick, onClose }) {
  const selected = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toKey(fromKey(value)) === value
    ? fromKey(value)
    : null;
  const today = new Date();
  const base = selected ?? today;
  const year = base.getFullYear();
  const month = base.getMonth();
  const [cur, setCur] = useState({ y: year, m: month });
  const [wheelOpen, setWheelOpen] = useState(false);
  const [wheelSession, setWheelSession] = useState(0);
  const [jumpVersion, setJumpVersion] = useState(0);
  const [draftY, setDraftY] = useState(year);
  const [draftM, setDraftM] = useState(month);
  useLayoutEffect(() => {
    if (visible) {
      setCur({ y: year, m: month });
      setWheelOpen(false);
    }
  }, [visible, year, month]);
  const weeks = monthMatrix(cur.y, cur.m);
  const shift = (dir) => setCur((p) => { const d = new Date(p.y, p.m + dir, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const toggleWheel = () => {
    if (!wheelOpen) {
      setDraftY(cur.y);
      setDraftM(cur.m);
      setWheelSession((n) => n + 1);
      setWheelOpen(true);
    } else {
      setWheelOpen(false);
    }
  };
  return (
    <SheetModal visible={visible} onClose={onClose} label="날짜 선택" style={styles.dialog}>
      <View style={styles.handle} />
      <View style={styles.navRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={wheelOpen ? '달력으로 돌아가기' : '연도와 월 선택'} onPress={toggleWheel} style={({ pressed }) => [styles.titleToggle, pressed && styles.pressed]}>
          <Text style={styles.navTitle}>{wheelOpen ? `${draftY}년 ${draftM + 1}월` : `${cur.y}년 ${cur.m + 1}월`}</Text>
          <Icon name={wheelOpen ? 'chevronUp' : 'chevronDown'} size={15} color={colors.muted} />
        </Pressable>
        {wheelOpen ? (
          <Pressable accessibilityRole="button" accessibilityLabel="이번 달로 이동" onPress={() => { setDraftY(today.getFullYear()); setDraftM(today.getMonth()); setJumpVersion((n) => n + 1); }} style={({ pressed }) => [styles.thisMonthBtn, pressed && styles.pressed]}>
            <Text style={styles.thisMonthText}>이번 달</Text>
          </Pressable>
        ) : (
          <View style={styles.navActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="이전 달" onPress={() => shift(-1)} style={({ pressed }) => [styles.navBtn, pressed && styles.pressed]}>
              <Icon name="chevronLeft" size={18} color={colors.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="다음 달" onPress={() => shift(1)} style={({ pressed }) => [styles.navBtn, pressed && styles.pressed]}>
              <Icon name="chevronRight" size={18} color={colors.ink} />
            </Pressable>
          </View>
        )}
      </View>
      {wheelOpen ? (
        <>
          <YearMonthWheel key={wheelSession} year={draftY} month={draftM} jumpVersion={jumpVersion} onChangeYear={setDraftY} onChangeMonth={setDraftM} />
          <View style={styles.wheelFooter}>
            <Pressable accessibilityRole="button" onPress={() => setWheelOpen(false)} style={({ pressed }) => [styles.wheelBtn, pressed && styles.pressed]}><Text style={styles.wheelCancelText}>취소</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => { setCur({ y: draftY, m: draftM }); setWheelOpen(false); }} style={({ pressed }) => [styles.wheelBtn, styles.wheelConfirm, pressed && { opacity: 0.85 }]}><Text style={styles.wheelConfirmText}>이동</Text></Pressable>
          </View>
        </>
      ) : (
        <>
          <View style={styles.row}>
            {WEEKDAYS.map((w, i) => (
              <Text key={w} style={[styles.wd, i === 0 && { color: colors.coral }]}>{w}</Text>
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
        </>
      )}
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
  dialog: { gap: spacing.sm, paddingTop: 12 },
  handle: { alignSelf: 'center', width: 32, height: 4, borderRadius: 3, backgroundColor: '#666', marginBottom: 6 },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  titleToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 8, marginLeft: -8, borderRadius: radius.sm },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  navBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: 16, fontWeight: '600', letterSpacing: -0.3, color: colors.ink, fontVariant: ['tabular-nums'] },
  pressed: { backgroundColor: colors.raised },
  thisMonthBtn: { minHeight: 44, paddingHorizontal: 10, marginRight: -10, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  thisMonthText: { fontSize: 13, fontWeight: '500', color: colors.muted },
  wheelFooter: { flexDirection: 'row', gap: 8, marginTop: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  wheelBtn: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  wheelCancelText: { fontSize: 14, fontWeight: '500', color: colors.muted },
  wheelConfirm: { backgroundColor: colors.action },
  wheelConfirmText: { fontSize: 14, fontWeight: '600', color: colors.onPrimary },
  row: { flexDirection: 'row', gap: spacing.sm },
  wd: { flex: 1, textAlign: 'center', fontSize: font.caption, fontWeight: '500', color: colors.muted },
  dayCell: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' },
  day: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: '#34373a', borderWidth: 1, borderColor: '#4c5054' },
  dayText: { fontSize: font.body, color: colors.ink, fontVariant: ['tabular-nums'] },
  closeBtn: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  cols: { flexDirection: 'row', gap: spacing.md, height: 240 },
  col: { flex: 1 },
  opt: { minHeight: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  optOn: { borderColor: colors.actionBorder, backgroundColor: colors.card },
  optText: { fontSize: font.bodyLg, color: colors.ink },
  optTextOn: { color: colors.ink, fontWeight: '600' },
  btn: { flex: 1, minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.line },
});
