// ============================================================
// SearchScreen.js — 검색 화면 (사이드 메뉴의 "검색")
// ============================================================
// 하는 일
//   1) 키워드를 입력하면 앱 안의 메모/파일에서 해당하는 내용을 바로 보여줌 (입력하는 즉시 결과가 바뀜)
//   2) 결과를 누르면 그 내용이 있는 화면으로 자동 이동 (메모 → 메모 화면, 파일 → 파일 보관함)
//        이동한 화면에서는 눌렀던 항목이 잠깐 강조되고 그 위치로 스크롤됩니다.
//   3) 위쪽 칩(전체 / 메모 / 파일)으로 종류별로 걸러 볼 수 있음
//   4) 입력창이 비어 있을 때는 "최근 검색어"와 "추천 키워드"를 보여줌
//
// 데이터와 검색 규칙은 MemoStore.js 에 있습니다. (AI 채팅도 같은 데이터를 사용)
//
// props (AppNavigator 가 넣어줌)
//   navigation : 화면 이동 도구 { navigate, goBack }

import React, { useMemo, useState } from 'react';
import { FlatList, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import {
  TYPE_INFO,
  addRecentSearch,
  openParams,
  clearRecentSearches,
  getRecentSearches,
  highlightParts,
  searchApp,
  searchTerms,
} from '../../../data/memos/MemoStore';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { useTasks } from '../../../data/tasks/TaskStore';
import { useProjects } from '../../../data/projects/ProjectStore';

// 입력창이 비어 있을 때 보여줄 추천 키워드 (샘플 데이터에 맞춘 것)
const SUGGESTED_KEYWORDS = ['회의', '중간고사', '발표', '장보기'];

// 종류 걸러보기 칩 목록
const FILTERS = [
  { key: 'all', label: '전체' },
  { key: 'memo', label: '메모' },
  { key: 'task', label: '일정' },
  { key: 'project', label: '프로젝트' },
  { key: 'file', label: '파일' },
];

// ------------------------------------------------------------
// 글자 안의 검색어 부분만 굵게/색을 다르게 보여주는 작은 컴포넌트
// ------------------------------------------------------------
function HighlightText({ text, terms, style, numberOfLines }) {
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {highlightParts(text, terms).map((p, i) => (
        <Text key={i} style={p.hit ? styles.hit : null}>
          {p.text}
        </Text>
      ))}
    </Text>
  );
}

export default function SearchScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu(); // "오른쪽으로 밀면 메뉴" 제스처

  // ---------- 상태 ----------
  const [query, setQuery] = useState('');                    // 입력창에 적힌 검색어
  const [filter, setFilter] = useState('all');                // 선택한 종류 칩
  const [recent, setRecent] = useState(getRecentSearches()); // 최근 검색어 목록

  // ---------- 검색 결과 계산 ----------
  // query 가 바뀔 때만 다시 계산 (useMemo)
  const terms = useMemo(() => searchTerms(query), [query]);
  const tasks = useTasks(); // 일정이 추가/수정/불러오기 되면 다시 검색
  const projects = useProjects();
  const allResults = useMemo(() => searchApp(query), [query, tasks, projects]);
  // 칩에 따라 종류별로 거르기
  const results = useMemo(
    () => (filter === 'all' ? allResults : allResults.filter((r) => r.type === filter)),
    [allResults, filter],
  );
  // 칩에 표시할 개수: 전체 N / 메모 N / 파일 N
  const counts = {
    all: allResults.length,
    memo: allResults.filter((r) => r.type === 'memo').length,
    task: allResults.filter((r) => r.type === 'task').length,
    project: allResults.filter((r) => r.type === 'project').length,
    file: allResults.filter((r) => r.type === 'file').length,
  };

  // ---------- 동작 ----------
  // 검색어를 최근 검색어에 기록
  const remember = (q) => {
    addRecentSearch(q);
    setRecent(getRecentSearches());
  };

  // 결과를 눌렀을 때: 그 내용이 있는 화면으로 이동 (focusId = "이 항목을 보여줘" 라는 전달값)
  const openResult = (item) => {
    Keyboard.dismiss();
    remember(query);
    navigation.navigate(TYPE_INFO[item.type].route, openParams(item.type, item.id));
  };

  const hasQuery = query.trim().length > 0;

  return (
    <View style={styles.root}>
      {/* 헤더 (여기에 밀기 제스처 연결) */}
      <View {...menuSwipe}>
        <ScreenHeader title="검색" onBack={navigation.goBack} />
      </View>

      {/* ---------- 검색창 ---------- */}
      <View style={styles.searchBar}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          accessibilityLabel="검색어 입력"
          style={styles.input}
          value={query}
          onChangeText={(t) => {
            setQuery(t);
            setFilter('all'); // 검색어가 바뀌면 칩은 "전체"로
          }}
          placeholder="메모, 파일에서 검색"
          placeholderTextColor={colors.muted}
          autoFocus // 화면이 열리면 바로 키보드가 올라옴
          returnKeyType="search"
          onSubmitEditing={() => hasQuery && remember(query)} // 키보드의 검색 키 → 최근 검색어에 저장
          accessibilityLabel="검색어 입력"
        />
        {/* 지우기(✕): 글자가 있을 때만 */}
        {hasQuery && (
          <Pressable accessibilityRole="button" accessibilityLabel="검색어 지우기" onPress={() => setQuery('')} hitSlop={10}>
            <Text style={styles.clear}>✕</Text>
          </Pressable>
        )}
      </View>

      {/* ---------- 종류 칩 (검색어가 있을 때만) ---------- */}
      {hasQuery && (
        <View style={styles.filters}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <Pressable
                key={f.key}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setFilter(f.key)}
                style={[styles.filterChip, on && styles.filterChipOn]}
              >
                <Text style={[styles.filterText, on && styles.filterTextOn]}>
                  {f.label} {counts[f.key]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* ---------- 본문: 상태에 따라 3가지 중 하나 ---------- */}
      <View style={styles.flex} {...menuSwipe}>
        {!hasQuery ? (
          // (1) 검색어 없음 → 최근 검색어 + 추천 키워드
          <View style={styles.idle}>
            {recent.length > 0 && (
              <View style={styles.block}>
                <View style={styles.blockHead}>
                  <Text style={styles.blockTitle}>최근 검색어</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      clearRecentSearches();
                      setRecent([]);
                    }}
                    hitSlop={8}
                  >
                    <Text style={styles.blockAction}>모두 지우기</Text>
                  </Pressable>
                </View>
                <View style={styles.tags}>
                  {recent.map((r) => (
                    <Pressable key={r} accessibilityRole="button" onPress={() => setQuery(r)} style={styles.tag}>
                      <Text style={styles.tagText}>🕘 {r}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}
            <View style={styles.block}>
              <Text style={styles.blockTitle}>이런 키워드는 어때요?</Text>
              <View style={styles.tags}>
                {SUGGESTED_KEYWORDS.map((k) => (
                  <Pressable key={k} accessibilityRole="button" onPress={() => setQuery(k)} style={styles.tag}>
                    <Text style={styles.tagText}>{k}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.hint}>메모와 파일에서 키워드가 들어 있는 내용을 찾아 드려요. 결과를 누르면 그 내용이 있는 곳으로 이동해요.</Text>
            </View>
          </View>
        ) : results.length === 0 ? (
          // (2) 검색어는 있는데 결과 없음
          <View style={styles.noResult}>
            <Text style={styles.noResultTitle}>검색 결과가 없어요</Text>
            <Text style={styles.noResultSub}>"{query.trim()}"에 해당하는 내용이 없어요. 다른 키워드로 찾아보세요.</Text>
          </View>
        ) : (
          // (3) 결과 목록
          <FlatList
            data={results}
            keyExtractor={(r) => r.id}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${TYPE_INFO[item.type].label}: ${item.title}`}
                onPress={() => openResult(item)}
                style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.mintSoft }]}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.badge}>
                    {TYPE_INFO[item.type].icon ? `${TYPE_INFO[item.type].icon} ` : ''}{TYPE_INFO[item.type].label}
                  </Text>
                  <Text style={styles.date}>{item.date}</Text>
                </View>
                <HighlightText text={item.title} terms={terms} style={styles.cardTitle} numberOfLines={1} />
                <HighlightText text={item.snippet} terms={terms} style={styles.cardSnippet} numberOfLines={2} />
                <Text style={styles.cardGo}>{item.type === 'task' ? '일정 열기 ›' : `${TYPE_INFO[item.type].label} 화면에서 보기 ›`}</Text>
              </Pressable>
            )}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },

  // 검색창
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 48,
    borderRadius: 24,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  searchIcon: { fontSize: 16 },
  input: { flex: 1, fontSize: font.bodyLg, color: colors.ink, paddingVertical: 10 },
  clear: { fontSize: 16, color: colors.muted },

  // 종류 칩
  filters: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  filterChip: {
    paddingHorizontal: spacing.md + 2,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  filterChipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  filterText: { fontSize: font.body, color: colors.ink },
  filterTextOn: { color: colors.white, fontWeight: '700' },

  // 검색어 없을 때
  idle: { paddingHorizontal: spacing.lg, gap: spacing.xl },
  block: { gap: spacing.sm },
  blockHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  blockTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  blockAction: { fontSize: font.body, color: colors.muted },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tag: {
    paddingHorizontal: spacing.md + 2,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  tagText: { fontSize: font.body, color: colors.ink },
  hint: { fontSize: font.body, color: colors.muted, lineHeight: 20, marginTop: spacing.xs },

  // 결과 없음
  noResult: { alignItems: 'center', paddingTop: 80, paddingHorizontal: spacing.xl, gap: spacing.sm },
  noResultTitle: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  noResultSub: { fontSize: font.body, color: colors.muted, textAlign: 'center' },

  // 결과 목록
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
    gap: 6,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between' },
  badge: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
  date: { fontSize: font.caption, color: colors.muted },
  cardTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  cardSnippet: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  cardGo: { fontSize: font.caption, color: colors.mintDark, marginTop: 2 },
  // 검색어와 일치하는 글자: 진한 녹색 + 굵게 + 연한 민트 배경
  hit: { color: colors.mintDark, fontWeight: '800', backgroundColor: colors.mintSoft },
});
