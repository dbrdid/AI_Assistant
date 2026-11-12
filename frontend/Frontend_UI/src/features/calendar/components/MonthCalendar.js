// ============================================================
// MonthCalendar.js — "한 달 달력" 화면 조각 (그리기만 담당)
// ============================================================
// 이 컴포넌트는 데이터를 스스로 들고 있지 않습니다.
// 부모(CalendarSheet)가 "지금 몇 년 몇 월인지, 어떤 날짜가 선택됐는지"를 props 로 알려주고,
// 사용자가 뭔가 누르면 onSelect / onPrev / onNext / onToday 등으로 부모에게 알려줍니다.
//
// 스토리보드 "캘린더" (44~47장)
//   - 위쪽: ‹ 2026년 10월 › (달 이름을 누르면 연·월 고르기), 왼쪽 🔍 일정 검색, 오른쪽 [오늘]
//   - 날짜 칸: 일정이 있는 날은 아래에 점, 공휴일·일요일은 빨간색, 토요일은 녹색
//   - 달력 아래(children): 선택한 날의 일정 목록 등 (CalendarSheet 가 채워 넣음)
//
// props
//   year, month : 보여줄 연도와 월(월은 0~11)
//   selected    : 선택된 날짜(Date)
//   today       : 오늘 날짜(Date)
//   marks       : { '2026-10-15': { n: 일정 수, overdue: 기한 초과 있음, allDone: 전부 완료 } }  (점 표시용)
//   holidays    : { '2026-10-03': '개천절', ... }  (공휴일은 빨간색)
//   highlight   : Set<'2026-10-15'>  검색에 걸린 날짜들 (연한 민트 배경)
//   searching   : 검색 중이면 true (🔍 버튼이 눌린 모양)
//   onSelect(d) / onPrev() / onNext() / onToday() / onSearch() / onPickMonth(year, month)
//   children    : 달력 아래에 이어 붙일 내용

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { WEEKDAYS, isSameDay, monthMatrix, toKey } from '../utils/DateUtils';

export default function MonthCalendar({
  year,
  month,
  selected,
  today,
  marks = {},
  holidays = {},
  highlight,
  searching,
  onSelect,
  onPrev,
  onNext,
  onToday,
  onSearch,
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
      {/* ---------- 1) 맨 위: 🔍 · ‹ 2026년 10월 › · [오늘] ---------- */}
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="일정 검색"
          accessibilityState={{ selected: !!searching }}
          onPress={onSearch}
          hitSlop={8}
          style={[styles.searchBtn, searching && styles.searchBtnOn]}
        >
          <Text style={styles.searchIcon}>🔍</Text>
        </Pressable>

        <View style={styles.monthNav}>
          <Pressable accessibilityRole="button" accessibilityLabel="이전 달" onPress={onPrev} hitSlop={10} style={styles.navBtn}>
            <Text style={styles.navText}>‹</Text>
          </Pressable>
          {/* 달 이름을 누르면 연·월을 골라서 이동. month 는 0~11 이라서 +1 */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="연도와 월 선택"
            onPress={() => {
              setPickYear(year);
              setPicking(true);
            }}
          >
            <Text style={styles.month} accessibilityRole="header">{year}년 {month + 1}월 ▾</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="다음 달" onPress={onNext} hitSlop={10} style={styles.navBtn}>
            <Text style={styles.navText}>›</Text>
          </Pressable>
        </View>

        <Pressable accessibilityRole="button" accessibilityLabel="오늘로 이동" onPress={onToday} style={styles.todayBtn}>
          <Text style={styles.todayText}>오늘</Text>
        </Pressable>
      </View>

      {/* ---------- 2) 요일 줄 ---------- */}
      <View style={styles.weekRow}>
        {WEEKDAYS.map((w, i) => (
          <Text
            key={w}
            style={[styles.weekday, i === 0 && { color: colors.coral }, i === 6 && { color: colors.mintDark }]}
          >
            {w}
          </Text>
        ))}
      </View>

      {/* ---------- 3) 날짜 칸들: 주(줄) 단위로 반복 ---------- */}
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.weekRow}>
          {week.map((d, di) => {
            // 빈 칸(그 달이 아닌 칸)은 아무것도 안 그리고 자리만 차지
            if (!d) return <View key={di} style={styles.cell} />;

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
                {/* 동그라미: 오늘이면 테두리, 선택됐으면 진녹색으로 채움, 검색에 걸렸으면 연한 민트 */}
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
                      (di === 0 || holiday) && { color: colors.coral }, // 일요일·공휴일은 코랄(빨강 계열)
                      di === 6 && !holiday && { color: colors.mintDark },
                      isSelected && { color: colors.white, fontWeight: '800' }, // 선택되면 흰 글씨
                    ]}
                  >
                    {d.getDate()}
                  </Text>
                </View>
                {/* 일정 점: 최대 3개. 기한 초과가 있으면 코랄, 전부 완료면 회색, 아니면 민트 */}
                <View style={styles.dots}>
                  {mark &&
                    Array.from({ length: Math.min(mark.n, 3) }).map((_, i) => (
                      <View
                        key={i}
                        style={[
                          styles.dot,
                          { backgroundColor: mark.overdue ? colors.coral : mark.allDone ? colors.line : colors.mint },
                        ]}
                      />
                    ))}
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}

      {/* ---------- 4) 아래: 선택한 날의 일정 목록 등 ---------- */}
      <View style={styles.divider} />
      {children}

      {/* ---------- 연·월 고르기 창 ---------- */}
      <Modal transparent visible={picking} animationType="fade" onRequestClose={() => setPicking(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <View style={styles.yearRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="이전 해" onPress={() => setPickYear((y) => Math.max(1900, y - 1))} hitSlop={10}>
                <Text style={styles.navText}>‹</Text>
              </Pressable>
              <Text style={styles.pickYear}>{pickYear}년</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="다음 해" onPress={() => setPickYear((y) => Math.min(2100, y + 1))} hitSlop={10}>
                <Text style={styles.navText}>›</Text>
              </Pressable>
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
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  // 맨 위 줄: 가운데 월 이동 + 왼쪽 검색 + 오른쪽 오늘 (양끝은 absolute 로 띄워서 월 표시 위치에 영향 없음)
  head: { height: 40, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  monthNav: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  navBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 28, color: colors.ink },
  month: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  searchBtn: {
    position: 'absolute',
    left: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnOn: { backgroundColor: colors.mintSoft },
  searchIcon: { fontSize: 18 },
  todayBtn: {
    position: 'absolute',
    right: 0,
    paddingHorizontal: spacing.md,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 999, // 아주 큰 값 = 알약 모양
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
  },
  todayText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  // 한 주(7칸)를 가로로 나란히
  weekRow: { flexDirection: 'row' },
  // flex: 1 → 7칸이 폭을 똑같이 나눠 가짐
  weekday: { flex: 1, textAlign: 'center', fontSize: font.caption, fontWeight: '700', color: colors.muted, paddingVertical: spacing.sm },
  cell: { flex: 1, height: 52, alignItems: 'center', justifyContent: 'center' },
  dayCircle: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  hitCircle: { backgroundColor: colors.mintSoft },
  todayRing: { borderWidth: 1.5, borderColor: colors.mint },
  selectedCircle: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  dayText: { fontSize: font.body, color: colors.ink },
  dots: { flexDirection: 'row', gap: 3, height: 6, marginTop: 2, alignItems: 'center' },
  dot: { width: 5, height: 5, borderRadius: 3 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: spacing.lg },

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
  closeBtn: { minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
