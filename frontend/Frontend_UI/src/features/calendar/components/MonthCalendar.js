// ============================================================
// MonthCalendar.js — "한 달 달력" 화면
// ============================================================
// Figma 시안: 왼쪽 큰 '2026년 11월' · 오른쪽 ‹ › 동그란 버튼 · 요일 줄 · 날짜 칸(선택 = 진녹색 동그라미)
// 아래(children)에는 선택한 날의 일정 목록(흰 시트)이 붙습니다.

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../../../shared/theme/theme';
import { SheetModal } from '../../../shared/components/Motion';
import { CircleButton } from '../../../shared/components/Ui';
import Icon from '../../../shared/components/Icon';
import YearMonthWheel from '../../../shared/components/YearMonthWheel';
import { WEEKDAYS, isSameDay, monthMatrix, toKey } from '../utils/DateUtils';

const OUTSIDE = '#6a6e71'; // 이번 달이 아닌 날짜: 어두운 배경에서 한 단계 물러난 회색
const WEEKEND = '#d79b9b'; // 일요일·공휴일: 코랄을 낮춘 색(강조보다 구분용)
const TODAY = '#ffffff'; // 오늘: 가장 밝은 글자 + 굵게(녹색 없이 구분)

function MonthPickerBody({ initialYear, initialMonth, todayYear, todayMonth, onClose, onConfirm }) {
  const [pickYear, setPickYear] = useState(initialYear);
  const [pickMonth, setPickMonth] = useState(initialMonth);
  const [jumpVersion, setJumpVersion] = useState(0);

  return (
    <>
      <View style={styles.pickerHandle} />
      <View style={styles.pickerHeader}>
        <Text style={styles.pickYear}>{pickYear}년 {pickMonth + 1}월</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="이번 달로 이동"
          onPress={() => {
            setPickYear(todayYear);
            setPickMonth(todayMonth);
            setJumpVersion((n) => n + 1);
          }}
          style={({ pressed }) => [styles.thisMonthBtn, pressed && styles.pickerPressed]}
        >
          <Text style={styles.thisMonthText}>이번 달</Text>
        </Pressable>
      </View>
      <View style={styles.pickerDivider} />
      <YearMonthWheel
        year={pickYear}
        month={pickMonth}
        jumpVersion={jumpVersion}
        onChangeYear={setPickYear}
        onChangeMonth={setPickMonth}
      />
      <View style={styles.pickerFooter}>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.pickerBtn, styles.pickerCancel, pressed && styles.pickerPressed]}
        >
          <Text style={styles.pickerCancelText}>취소</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onConfirm(pickYear, pickMonth)}
          style={({ pressed }) => [styles.pickerBtn, styles.pickerConfirm, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.pickerConfirmText}>이동</Text>
        </Pressable>
      </View>
    </>
  );
}

function MonthPickerSheet({ visible, session, initialYear, initialMonth, todayYear, todayMonth, onClose, onConfirm }) {
  return (
    <SheetModal visible={visible} onClose={onClose} label="연도와 월 선택" style={styles.pickerSheet}>
      <MonthPickerBody
        key={session}
        initialYear={initialYear}
        initialMonth={initialMonth}
        todayYear={todayYear}
        todayMonth={todayMonth}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    </SheetModal>
  );
}

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
  actions = null,
  search,
  scrollEnabled = true,
  detailed = false, // 칸을 키워 일정 제목을 보여 줌 // 달 이름 줄 오른쪽에 함께 둘 버튼 (탭 안 캘린더: 오늘, 검색)
  children,
}) {
  // 이 달의 달력 표(주 단위 배열)를 계산
  const weeks = monthMatrix(year, month);
  // 연·월 2열 스크롤 휠 바텀시트 (상태를 MonthPickerSheet로 격리해 휠 스크롤 중 달력 리렌더 방지)
  const [picking, setPicking] = useState(false);
  const [pickerSession, setPickerSession] = useState(0);
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth();
  const openPicker = () => {
    setPickerSession((n) => n + 1);
    setPicking(true);
  };

  return (
    <ScrollView scrollEnabled={scrollEnabled} showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.grid}>
        {/* ---------- 1) 맨 위: 2026년 11월,  ‹ › ---------- */}
        <View style={styles.head}>
          {/* 달 이름을 누르면 연·월을 골라서 이동. month 는 0~11 이라서 +1 */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="연도와 월 선택"
            onPress={openPicker}
            hitSlop={6}
            style={styles.monthBtnRow}
          >
            <Text style={styles.month} accessibilityRole="header">{year}년 {month + 1}월</Text>
            <Icon name="chevronDown" size={16} color={colors.muted} />
          </Pressable>
          <View style={styles.monthNav}>
            {actions}
            <CircleButton icon="chevronLeft" label="이전 달" onPress={onPrev} size={40} iconSize={18} />
            <CircleButton icon="chevronRight" label="다음 달" onPress={onNext} size={40} iconSize={18} />
          </View>
        </View>

        {search ? <View style={styles.search}>{search}</View> : null}

        {/* ---------- 2) 요일 줄 (일요일만 코랄) ---------- */}
        <View style={[styles.weekRow, styles.weekHead]}>
          {WEEKDAYS.map((w, i) => (
            <Text key={w} style={[styles.weekday, i === 0 && { color: WEEKEND }]}>
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
                  <View key={di} style={[styles.cell, detailed && styles.cellDetailed]} importantForAccessibility="no" accessibilityElementsHidden>
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
                  style={[styles.cell, detailed && styles.cellDetailed]}
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
                        (di === 0 || holiday) && { color: WEEKEND }, // 일요일·공휴일
                        isToday && styles.todayText,
                        isSelected && styles.selectedText,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </View>
                  {/* 일정 점: 최대 3개. 일정 = 민트, 할 일 = 진녹색, 기한 초과 = 코랄, 완료 = 회색 */}
                  {detailed ? <View style={styles.titles}>
                    {(mark?.titles || []).map((x, i) => <Text key={i} numberOfLines={1} style={[styles.titleText, x.done && { color: colors.muted, textDecorationLine: 'line-through' }]}>{x.title}</Text>)}
                    {mark && mark.n > 3 && <Text style={[styles.titleText, { color: colors.muted }]}>+{mark.n - 3}</Text>}
                  </View> : <View style={styles.dots}>
                    {mark &&
                      (mark.dots || []).map((c, i) => <View key={i} style={[styles.dot, { backgroundColor: c }]} />)}
                  </View>}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      {/* ---------- 4) 아래: 선택한 날의 일정 목록 등 ---------- */}
      {children}

      {/* ---------- 연·월 2열 스크롤 휠 바텀시트 ---------- */}
      <MonthPickerSheet
        visible={picking}
        session={pickerSession}
        initialYear={year}
        initialMonth={month}
        todayYear={todayYear}
        todayMonth={todayMonth}
        onClose={() => setPicking(false)}
        onConfirm={(y, m) => {
          setPicking(false);
          onPickMonth(y, m);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // flexGrow: 1 → 아래 일정 시트가 화면 맨 아래까지 늘어날 수 있게
  content: { flexGrow: 1 },
  grid: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  // 맨 위 줄: 왼쪽 달 이름, 오른쪽 ‹ › 버튼
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: spacing.sm, paddingLeft: spacing.xs },
  monthBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 },
  month: { fontSize: 18, fontWeight: '600', letterSpacing: -0.3, color: colors.ink },
  monthNav: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  search: { marginBottom: spacing.md },
  // 한 주(7칸)를 가로로 나란히
  weekRow: { flexDirection: 'row' },
  weekHead: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, marginBottom: 6 },
  // flex: 1 → 7칸이 폭을 똑같이 나눠 가짐
  // 요일 줄: 작고 흐리게, 아래 옅은 선으로 날짜와 구분
  weekday: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '500', letterSpacing: 0.4, color: '#878b8e', paddingTop: 2, paddingBottom: 10 },
  cell: { flex: 1, height: 48, alignItems: 'center', justifyContent: 'center' },
  // 날짜: 얇은 글자, 선택은 낮은 대비의 채운 원, 오늘은 강조색 글자만(테두리 없음)
  // Android: 나중에 배경이 생기면 둥근 모서리가 빠지므로 처음부터 투명 배경과 잘라내기를 둔다.
  dayCircle: { width: 34, height: 34, borderRadius: 17, overflow: 'hidden', backgroundColor: 'rgba(58,61,64,0)', alignItems: 'center', justifyContent: 'center' },
  hitCircle: { backgroundColor: '#26292b' },
  todayRing: {},
  selectedCircle: { backgroundColor: '#3a3d40' },
  dayText: { fontSize: 14, fontWeight: '400', color: colors.ink, fontVariant: ['tabular-nums'] },
  todayText: { color: TODAY, fontWeight: '500' },
  selectedText: { color: colors.ink, fontWeight: '600' },
  outsideText: { color: OUTSIDE, fontWeight: '400' },
  dots: { flexDirection: 'row', gap: 3, height: 4, marginTop: 2, alignItems: 'center' },
  dot: { width: 4, height: 4, borderRadius: 2 },
  cellDetailed: { height: 96, justifyContent: 'flex-start', paddingTop: 2 },
  titles: { alignSelf: 'stretch', paddingHorizontal: 2, gap: 1, marginTop: 2 },
  titleText: { fontSize: 10, lineHeight: 13, color: colors.ink, backgroundColor: colors.raised, borderRadius: 3, paddingHorizontal: 2, overflow: 'hidden' },

  // 연·월 2열 스크롤 휠 바텀시트 (Stella/Notion 절제된 무채색 · 4~6px 모서리 톤 통일)
  pickerSheet: { paddingTop: 12, gap: 0 },
  pickerHandle: { alignSelf: 'center', width: 32, height: 4, borderRadius: 3, backgroundColor: '#666', marginBottom: 12 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: 6 },
  pickYear: { fontSize: 16, fontWeight: '600', letterSpacing: -0.3, color: colors.ink, fontVariant: ['tabular-nums'] },
  thisMonthBtn: { minHeight: 44, paddingHorizontal: 10, marginRight: -10, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  thisMonthText: { fontSize: 13, fontWeight: '500', color: colors.muted },
  pickerDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginBottom: 10 },
  pickerFooter: { flexDirection: 'row', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pickerBtn: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  pickerCancel: { backgroundColor: 'transparent' },
  pickerCancelText: { fontSize: 14, fontWeight: '500', color: colors.muted },
  pickerConfirm: { backgroundColor: colors.action },
  pickerConfirmText: { fontSize: 14, fontWeight: '600', color: colors.onPrimary },
  pickerPressed: { backgroundColor: colors.raised },
});
