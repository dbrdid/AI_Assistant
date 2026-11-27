// ============================================================
// DateTimePicker.js — 날짜 / 시간 고르기 창 (외부 패키지 없이 직접 만든 것)
// ============================================================
//   DatePickerModal : 월 달력에서 날짜 선택 (‹ › 로 달 이동)
//   TimePickerModal : 시 / 분(5분 단위) 목록에서 선택, "지우기" 로 시간 없음 처리

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../theme/theme';
import { WEEKDAYS, fromKey, isSameDay, monthMatrix, toKey } from '../../features/calendar/utils/DateUtils';

function Shell({ visible, onClose, children }) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>{children}</View>
      </View>
    </Modal>
  );
}

export function DatePickerModal({ visible, value, onPick, onClose }) {
  const base = value ? fromKey(value) : new Date();
  const [cur, setCur] = useState({ y: base.getFullYear(), m: base.getMonth() });
  const weeks = monthMatrix(cur.y, cur.m);
  const selected = value ? fromKey(value) : null;
  const shift = (n) => {
    const d = new Date(cur.y, cur.m + n, 1);
    setCur({ y: d.getFullYear(), m: d.getMonth() });
  };
  return (
    <Shell visible={visible} onClose={onClose}>
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
                onPress={() => onPick(toKey(d))}
                style={styles.dayCell}
              >
                <View style={[styles.day, selected && isSameDay(d, selected) && styles.dayOn]}>
                  <Text style={[styles.dayText, di === 0 && { color: colors.coral }, selected && isSameDay(d, selected) && { color: colors.onPrimary, fontWeight: '600' }]}>{d.getDate()}</Text>
                </View>
              </Pressable>
            ) : (
              <View key={di} style={styles.dayCell} />
            ),
          )}
        </View>
      ))}
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.closeBtn}><Text style={styles.closeText}>닫기</Text></Pressable>
    </Shell>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

export function TimePickerModal({ visible, value, title, onPick, onClear, onClose }) {
  const [h, m] = value ? value.split(':') : ['09', '00'];
  const [hh, setHh] = useState(h);
  const [mm, setMm] = useState(MINUTES.includes(m) ? m : '00');
  return (
    <Shell visible={visible} onClose={onClose}>
      <Text style={styles.navTitle}>{title || '시간 선택'}</Text>
      <View style={styles.cols}>
        <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} style={styles.col} contentContainerStyle={{ gap: 6 }}>
          {HOURS.map((x) => (
            <Pressable key={x} accessibilityRole="button" accessibilityState={{ selected: hh === x }} onPress={() => setHh(x)} style={[styles.opt, hh === x && styles.optOn]}>
              <Text style={[styles.optText, hh === x && styles.optTextOn, (hh === x) && { fontWeight: '700' }]}>{x}시</Text>
            </Pressable>
          ))}
        </ScrollView>
        <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} style={styles.col} contentContainerStyle={{ gap: 6 }}>
          {MINUTES.map((x) => (
            <Pressable key={x} accessibilityRole="button" accessibilityState={{ selected: mm === x }} onPress={() => setMm(x)} style={[styles.opt, mm === x && styles.optOn]}>
              <Text style={[styles.optText, mm === x && styles.optTextOn, (mm === x) && { fontWeight: '700' }]}>{x}분</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={onClear} style={[styles.btn, styles.btnGhost]}><Text style={styles.closeText}>지우기</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} style={[styles.btn, styles.btnGhost]}><Text style={styles.closeText}>취소</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => onPick(`${hh}:${mm}`)} style={[styles.btn, { backgroundColor: colors.action }]}><Text style={[styles.closeText, { color: colors.onPrimary }]}>확인</Text></Pressable>
      </View>
    </Shell>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nav: { fontSize: 28, color: colors.ink, paddingHorizontal: spacing.sm },
  navTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink, textAlign: 'center' },
  row: { flexDirection: 'row', gap: spacing.sm },
  wd: { flex: 1, textAlign: 'center', fontSize: font.caption, fontWeight: '500', color: colors.muted },
  dayCell: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' },
  day: { width: 34, height: 34, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: colors.action },
  dayText: { fontSize: font.body, color: colors.ink },
  closeBtn: { minHeight: 44, borderRadius: radius.md, borderWidth: 0, borderColor: colors.line, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  cols: { flexDirection: 'row', gap: spacing.md, height: 240 },
  col: { flex: 1 },
  opt: { minHeight: 40, borderRadius: radius.sm, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  optOn: { backgroundColor: 'transparent', borderColor: colors.actionBorder },
  optText: { fontSize: font.bodyLg, color: colors.ink },
  optTextOn: { color: colors.onPrimary, fontWeight: '600' },
  btn: { flex: 1, minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 0, borderColor: colors.line },
});
