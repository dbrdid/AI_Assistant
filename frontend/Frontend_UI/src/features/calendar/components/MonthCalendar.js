// ============================================================
// MonthCalendar.js — "한 달 달력" 화면
// ============================================================
// Figma 시안: 왼쪽 큰 '2026년 11월' · 오른쪽 ‹ › 동그란 버튼 · 요일 줄 · 날짜 칸(선택 = 진녹색 동그라미)
// 아래(children)에는 선택한 날의 일정 목록(흰 시트)이 붙습니다.

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { CircleButton } from '../../../shared/components/Ui';
import Icon from '../../../shared/components/Icon';
import { WEEKDAYS, isSameDay, monthMatrix, toKey } from '../utils/DateUtils';

const OUTSIDE = '#B9C5C1'; // 이번 달이 아닌 날짜 (아주 흐린 글자)

export default function MonthCalendar({
  year,
  month,
  selected,
  today,
  marks = {},
  holidays = {},
  highlight,
  onSelect,
  onPrev,
  onNext,
  onPickMonth,
  children,
}) {
  // 이 달의 달력 표(주 단위 배열)를 계산
  const weeks = monthMatrix(year, month);
  // 연·월 고르기 창
  const [picking, setPicking] = useState(false);
  const [pickYear, setPickYear] = useState(year);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.grid}>
        {/* ---------- 1) 맨 위: 2026년 11월 ·  ‹ › ---------- */}
        <View style={styles.head}>
          {/* 달 이름을 누르면 연·월을 골라서 이동. month 는 0~11 이라서 +1 */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="연도와 월 선택"
            onPress={() => {
              setPickYear(year);
              setPicking(true);
            }}
            hitSlop={6}
            style={styles.monthBtnRow}
          >
            <Text style={styles.month} accessibilityRole="header">{year}년 {month + 1}월</Text>
            <Icon name="chevronDown" size={16} color={colors.muted} />
          </Pressable>
          <View style={styles.monthNav}>
            <CircleButton icon="chevronLeft" label="이전 달" onPress={onPrev} size={34} iconSize={18} />
            <CircleButton icon="chevronRight" label="다음 달" onPress={onNext} size={34} iconSize={18} />
          </View>
        </View>

        {/* ---------- 2) 요일 줄 (일요일만 코랄) ---------- */}
        <View style={styles.weekRow}>
          {WEEKDAYS.map((w, i) => (
            <Text key={w} style={[styles.weekday, i === 0 && { color: colors.coral }]}>
              {w}
            </Text>
          ))}
        </View>

        {/* ---------- 3) 날짜 칸들: 주(줄) 단위로 반복 ---------- */}
        {weeks.map((week, wi) => (
          <View key={wi} style={styles.weekRow}>
            {week.map((d, di) => {
              // 그 달이 아닌 칸: 앞/뒤 달의 날짜를 흐리게만 표시 (누를 수 없음)
              if (!d) {
                const outside = new Date(year, month, 1 + wi * 7 + di - new Date(year, month, 1).getDay());
                return (
                  <View key={di} style={styles.cell} importantForAccessibility="no" accessibilityElementsHidden>
                    <View style={styles.dayCircle}>
                      <Text style={[styles.dayText, styles.outsideText]}>{outside.getDate()}</Text>
                    </View>
                    <View style={styles.dots} />
                  </View>
                );
              }

              const key = toKey(d);
              const isSelected = isSameDay(d, selected); // 선택된 날인가?
              const isToday = isSameDay(d, today);       // 오늘인가?
              const holiday = holidays[key];             // 공휴일 이름 (없으면 undefined)
              const mark = marks[key];                   // 일정 정보 (없으면 undefined)
              const isHit = highlight && highlight.has(key);

              return (
                <Pressable
                  key={di}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`${month + 1}월 ${d.getDate()}일${isToday ? ', 오늘' : ''}${holiday ? `, ${holiday}` : ''}${mark ? `, 일정 ${mark.n}개` : ''}`}
                  onPress={() => onSelect(d)}
                  style={styles.cell}
                >
                  {/* 동그라미: 선택됐으면 진녹색으로 채움, 오늘이면 테두리, 검색에 걸렸으면 연한 민트 */}
                  <View
                    style={[
                      styles.dayCircle,
                      isHit && styles.hitCircle,
                      isToday && styles.todayRing,
                      isSelected && styles.selectedCircle,
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayText,
                        (di === 0 || holiday) && { color: colors.coral }, // 일요일·공휴일은 코랄
                        isToday && !isSelected && { color: colors.mintDark },
                        isSelected && { color: colors.white }, // 선택되면 흰 글씨
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </View>
                  {/* 일정 점: 최대 3개. 일정 = 민트, 할 일 = 진녹색, 기한 초과 = 코랄, 완료 = 회색 */}
                  <View style={styles.dots}>
                    {mark &&
                      (mark.dots || []).map((c, i) => <View key={i} style={[styles.dot, { backgroundColor: c }]} />)}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      {/* ---------- 4) 아래: 선택한 날의 일정 목록 등 ---------- */}
      {children}

      {/* ---------- 연·월 고르기 창 ---------- */}
      <Modal transparent visible={picking} animationType="fade" onRequestClose={() => setPicking(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <View style={styles.yearRow}>
              <CircleButton icon="chevronLeft" label="이전 해" onPress={() => setPickYear((y) => Math.max(1900, y - 1))} size={36} iconSize={18} />
              <Text style={styles.pickYear}>{pickYear}년</Text>
              <CircleButton icon="chevronRight" label="다음 해" onPress={() => setPickYear((y) => Math.min(2100, y + 1))} size={36} iconSize={18} />
            </View>
            <View style={styles.monthGrid}>
              {Array.from({ length: 12 }).map((_, m) => {
                const on = pickYear === year && m === month;
                return (
                  <Pressable
                    key={m}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      setPicking(false);
                      onPickMonth(pickYear, m);
                    }}
                    style={[styles.monthBtn, on && styles.monthBtnOn]}
                  >
                    <Text style={[styles.monthBtnText, on && { color: colors.white, fontWeight: '800' }]}>{m + 1}월</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable accessibilityRole="button" onPress={() => setPicking(false)} style={styles.closeBtn}>
              <Text style={styles.closeText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // flexGrow: 1 → 아래 일정 시트가 화면 맨 아래까지 늘어날 수 있게
  content: { flexGrow: 1 },
  grid: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  // 맨 위 줄: 왼쪽 달 이름, 오른쪽 ‹ › 버튼
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 40, marginBottom: spacing.md, paddingLeft: spacing.xs },
  monthBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  month: { fontSize: 23, fontWeight: '800', color: colors.ink },
  monthNav: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // 한 주(7칸)를 가로로 나란히
  weekRow: { flexDirection: 'row' },
  // flex: 1 → 7칸이 폭을 똑같이 나눠 가짐
  weekday: { flex: 1, textAlign: 'center', fontSize: 13, fontWeight: '700', color: colors.muted, paddingVertical: spacing.xs },
  cell: { flex: 1, height: 52, alignItems: 'center', justifyContent: 'center' },
  dayCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  hitCircle: { backgroundColor: colors.mintSoft },
  todayRing: { borderWidth: 1.5, borderColor: colors.mintDark },
  selectedCircle: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  dayText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  outsideText: { color: OUTSIDE, fontWeight: '600' },
  dots: { flexDirection: 'row', gap: 3, height: 5, marginTop: 3, alignItems: 'center' },
  dot: { width: 4, height: 4, borderRadius: 2 },

  // 연·월 고르기 창
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.lg },
  yearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pickYear: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  monthBtn: {
    width: '23%',
    flexGrow: 1,
    minHeight: 44,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthBtnOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  monthBtnText: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
  closeBtn: { minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
