// ============================================================
// MemoListScreen.js — 메모 화면 (메모 목록)
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { memoTitle, restoreMemos, setFavorites, trashMemos, useMemos } from '../../../data/memos/MemoStore';
import { useFiles } from '../../../data/files/FileStore';
import MemoCard from '../components/MemoCard';
import { ROUTES } from '../../../navigation/routes';
import { linkItems, projectOf, unlinkItems, useProjects } from '../../../data/projects/ProjectStore';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

// ⋮ 메뉴 항목 (스토리보드: 모든 메모 · 휴지통 · 프로젝트 + 즐겨찾기)
const MENU = [
  { route: ROUTES.Memos, label: '모든 메모' },
  { route: ROUTES.Favorites, label: '즐겨찾기' },
  { route: ROUTES.Trash, label: '휴지통' },
  { route: ROUTES.Projects, label: '프로젝트' },
];

const VIEW_KEY = 'myapp.memoview.v1';
const SORTS = [
  { id: 'recent', label: '최근 수정순' },
  { id: 'created', label: '작성순' },
  { id: 'title', label: '제목순' },
];

export default function MemosScreen({ navigation, route, favoritesOnly = false }) {
  const menuSwipe = useSwipeToOpenMenu(); // "오른쪽으로 밀면 메뉴" 제스처
  const insets = useSafeAreaInsets();
  const allMemos = useMemos(); // 메모 목록 (휴지통 제외. 바뀌면 자동으로 다시 그려짐)
  const files = useFiles();
  const base = favoritesOnly ? allMemos.filter((m) => m.favorite) : allMemos;

  // ---- 보기 설정 (삼성 메모처럼): 목록/격자, 정렬, 검색, 걸러보기 ----
  const [view, setView] = useState('grid');      // 'grid' | 'list'
  const [sort, setSort] = useState('recent');    // 'recent' 수정순 | 'created' 작성순 | 'title' 제목순
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');   // 'all' | 'ink' | 'photo' | 'proj:<id>'
  useEffect(() => {
    AsyncStorage.getItem(VIEW_KEY).then((raw) => {
      if (!raw) return;
      try {
        const v = JSON.parse(raw);
        if (v.view === 'grid' || v.view === 'list') setView(v.view);
        if (SORTS.some((x) => x.id === v.sort)) setSort(v.sort);
      } catch (e) { /* 무시 */ }
    }).catch(() => {});
  }, []);
  const saveView = (nextView, nextSort) => AsyncStorage.setItem(VIEW_KEY, JSON.stringify({ view: nextView, sort: nextSort })).catch(() => {});
  const projectsAll = useProjects();
  const photoOf = (m) => {
    const id = (m.photos || [])[0];
    const f = id ? files.find((x) => x.id === id) : null;
    return f ? f.uri : '';
  };
  const projTitleOf = (m) => {
    const p = projectOf('memos', m.id);
    return p ? p.title : '';
  };
  const q = query.trim().toLowerCase();
  const sorters = {
    recent: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => memoTitle(a).localeCompare(memoTitle(b), 'ko'),
  };
  const memos = base
    .filter((m) => {
      if (filter === 'ink' && !(m.strokes && m.strokes.length)) return false;
      if (filter === 'photo' && !(m.photos && m.photos.length)) return false;
      if (filter.startsWith('proj:') && (projectOf('memos', m.id) || {}).id !== filter.slice(5)) return false;
      if (!q) return true;
      return `${memoTitle(m)} ${m.body || ''} ${projTitleOf(m)}`.toLowerCase().includes(q);
    })
    .sort(sorters[sort]);
  // 걸러보기 칩에 보여줄 프로젝트 (메모가 들어 있는 것만)
  const projChips = projectsAll.filter((p) => base.some((m) => (projectOf('memos', m.id) || {}).id === p.id));
  const hasInk = base.some((m) => m.strokes && m.strokes.length);
  const hasPhoto = base.some((m) => m.photos && m.photos.length);
  // 같은 이름이 여러 곳에서 쓰이므로 목록 구역(오늘/어제/…) 나누기
  const sections = [];
  const pushTo = (label, m) => {
    let sec = sections.find((x) => x.label === label);
    if (!sec) {
      sec = { label, items: [] };
      sections.push(sec);
    }
    sec.items.push(m);
  };
  const nowMs = Date.now();
  memos.forEach((m) => {
    if (sort === 'title' || filter !== 'all' || q) return pushTo('', m);
    if (m.favorite && !favoritesOnly) return pushTo('★ 즐겨찾기', m);
    const t = sort === 'created' ? m.createdAt : m.updatedAt;
    const d0 = new Date(nowMs);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d0) - day(new Date(t))) / 86400000);
    return pushTo(diff <= 0 ? '오늘' : diff === 1 ? '어제' : diff <= 7 ? '지난 7일' : diff <= 30 ? '지난 30일' : '이전', m);
  });
  const searching = !!q || filter !== 'all';

  const [menuOpen, setMenuOpen] = useState(false);   // ⋮ 메뉴가 열려 있나
  const projects = useProjects();
  const [pickingProject, setPickingProject] = useState(false); // 선택한 메모의 프로젝트 고르기 창
  const [selecting, setSelecting] = useState(false); // 선택 모드인가
  const [selected, setSelected] = useState([]);      // 선택한 메모 번호들
  const [undoIds, setUndoIds] = useState([]);        // 방금 휴지통으로 보낸 메모들 (되돌리기용)
  const undoTimer = useRef(null);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const focusId = route.params?.focusId; // 강조하고 이동할 메모 번호 (없을 수 있음)
  const [highlightId, setHighlightId] = useState(focusId || null);
  const scrollRef = useRef(null);

  // 2.5초 뒤에 강조를 해제
  useEffect(() => {
    if (!focusId) return undefined;
    const id = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(id);
  }, [focusId]);

  // 각 카드의 위치가 정해지면 호출됨. 강조할 카드라면 그 위치로 스크롤.
  const onCardLayout = (id, e) => {
    if (id === focusId && scrollRef.current) {
      scrollRef.current.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - spacing.lg), animated: true });
    }
  };

  // ---------- 선택 ----------
  // 목록에 아직 있는 선택만 유효 (다른 곳에서 바뀌었을 수 있어서)
  const ids = selected.filter((id) => memos.some((m) => m.id === id));
  const allSelected = memos.length > 0 && ids.length === memos.length;
  const selectedMemos = memos.filter((m) => ids.includes(m.id));
  // 선택한 메모가 전부 즐겨찾기면 "즐겨찾기 해제", 하나라도 아니면 "즐겨찾기" (전부 켬)
  const allFavorite = selectedMemos.length > 0 && selectedMemos.every((m) => m.favorite);

  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const exitSelect = () => {
    setSelecting(false);
    setSelected([]);
  };

  const doFavorite = () => {
    setFavorites(ids, !allFavorite);
    exitSelect();
  };

  // 삭제 = 휴지통으로 이동. 4초 동안 "되돌리기" 안내
  const doTrash = () => {
    const moved = ids;
    trashMemos(moved);
    exitSelect();
    setUndoIds(moved);
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoIds([]), 4000);
  };
  const undo = () => {
    if (undoIds.length) restoreMemos(undoIds);
    setUndoIds([]);
  };

  const title = favoritesOnly ? '즐겨찾기' : '모든 메모';
  const currentRoute = favoritesOnly ? ROUTES.Favorites : ROUTES.Memos;
  const none = ids.length === 0;

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader
        title={selecting ? `${ids.length}개 선택` : title}
        onBack={selecting ? exitSelect : navigation.goBack}
        right={
          selecting ? (
            <Pressable accessibilityRole="button" accessibilityLabel="선택 취소" onPress={exitSelect} hitSlop={10}>
              <Text style={styles.headerBtn}>취소</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel="메모 메뉴 열기" onPress={() => setMenuOpen(true)} hitSlop={10}>
              <Text style={styles.more}>⋮</Text>
            </Pressable>
          )
        }
      />

      <ScrollView ref={scrollRef} contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}>
        {/* 검색창: 이 화면의 메모만 바로 걸러 줘요 (앱 전체 검색은 오른쪽 링크) */}
        {!selecting && (
          <View style={styles.searchBar}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="메모 검색"
              placeholderTextColor={colors.muted}
              returnKeyType="search"
              accessibilityLabel="메모 검색어"
            />
            {query.length > 0 && (
              <Pressable accessibilityRole="button" accessibilityLabel="검색어 지우기" onPress={() => setQuery('')} hitSlop={8}>
                <Text style={styles.searchClear}>✕</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* 걸러보기 칩 */}
        {!selecting && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {[{ id: 'all', label: '전체' }, ...(hasInk ? [{ id: 'ink', label: '✎ 손글씨' }] : []), ...(hasPhoto ? [{ id: 'photo', label: '📷 사진' }] : []), ...projChips.map((p) => ({ id: `proj:${p.id}`, label: p.title || '(제목 없음)' }))].map((c) => (
              <Pressable key={c.id} accessibilityRole="button" accessibilityState={{ selected: filter === c.id }} onPress={() => setFilter(c.id)} style={[styles.chip, filter === c.id && styles.chipOn]}>
                <Text style={[styles.chipText, filter === c.id && { color: colors.white }]} numberOfLines={1}>{c.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        <View style={styles.countRow}>
          <Text style={styles.count}>
            {searching ? `검색 결과 ${memos.length}개` : `메모 ${memos.length}개`}{!selecting && memos.length > 0 && !searching ? ' · 꾹 눌러 선택' : ''}
          </Text>
          {!selecting && (
            <View style={styles.tools}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`정렬 ${SORTS.find((x) => x.id === sort).label}, 눌러서 바꾸기`}
                onPress={() => {
                  const next = SORTS[(SORTS.findIndex((x) => x.id === sort) + 1) % SORTS.length].id;
                  setSort(next);
                  saveView(view, next);
                }}
                hitSlop={8}
              >
                <Text style={styles.toolText}>⇅ {SORTS.find((x) => x.id === sort).label}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={view === 'grid' ? '목록으로 보기' : '격자로 보기'}
                onPress={() => {
                  const next = view === 'grid' ? 'list' : 'grid';
                  setView(next);
                  saveView(next, sort);
                }}
                hitSlop={8}
              >
                <Text style={styles.toolIcon}>{view === 'grid' ? '☰' : '▦'}</Text>
              </Pressable>
            </View>
          )}
        </View>

        {memos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {searching ? '일치하는 메모가 없어요' : favoritesOnly ? '즐겨찾기한 메모가 없어요' : '아직 메모가 없어요'}
            </Text>
            <Text style={styles.emptySub}>
              {searching ? '다른 검색어를 입력하거나 걸러보기를 바꿔 보세요' : favoritesOnly ? '메모를 꾹 눌러 선택한 뒤 즐겨찾기를 눌러 보세요' : '오른쪽 아래 ＋ 를 눌러 첫 메모를 남겨 보세요'}
            </Text>
            {searching && !!q && (
              <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.Search)} style={styles.emptyBtn}>
                <Text style={styles.emptyBtnText}>앱 전체에서 검색하기</Text>
              </Pressable>
            )}
          </View>
        ) : (
          sections.map((sec) => (
            <View key={sec.label || 'all'} style={{ gap: spacing.sm }}>
              {!!sec.label && <Text style={styles.sectionTitle}>{sec.label}</Text>}
              <View style={view === 'grid' ? styles.grid : styles.listCol}>
                {sec.items.map((m) => (
                  <MemoCard
                    key={m.id}
                    memo={m}
                    mode={view}
                    selecting={selecting}
                    selected={ids.includes(m.id)}
                    highlighted={highlightId === m.id}
                    projectTitle={projTitleOf(m)}
                    photoUri={photoOf(m)}
                    onLayout={(e) => onCardLayout(m.id, e)}
                    // 짧게 누르기: 선택 모드면 선택/해제, 아니면 열기
                    onPress={() => (selecting ? toggle(m.id) : navigation.navigate(ROUTES.MemoEdit, { memoId: m.id }))}
                    // 꾹 누르기: 선택 모드 시작 (이 메모가 첫 선택)
                    onLongPress={() => {
                      if (!selecting) {
                        setSelecting(true);
                        setSelected([m.id]);
                      }
                    }}
                  />
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* 삭제 직후 "되돌리기" 안내 */}
      {undoIds.length > 0 && !selecting && (
        <View style={[styles.snack, { bottom: insets.bottom + spacing.xl }]}>
          <Text style={styles.snackText}>
            {undoIds.length > 1 ? `메모 ${undoIds.length}개를 휴지통으로 이동했어요` : '휴지통으로 이동했어요'}
          </Text>
          <Pressable accessibilityRole="button" onPress={undo} hitSlop={8}>
            <Text style={styles.snackAction}>되돌리기</Text>
          </Pressable>
        </View>
      )}

      {/* 새 메모 버튼: 오른쪽 아래에 떠 있음 (선택 모드에서는 숨김) */}
      {!selecting && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="새 메모 쓰기"
          onPress={() => navigation.navigate(ROUTES.MemoEdit)}
          style={({ pressed }) => [styles.fab, { bottom: insets.bottom + spacing.xl }, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.fabIcon}>＋</Text>
        </Pressable>
      )}

      {/* 선택 모드 아래 줄: 취소 · 전체 · 즐겨찾기 · 삭제 */}
      {selecting && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <Pressable accessibilityRole="button" onPress={() => setSelected(allSelected ? [] : memos.map((m) => m.id))} style={styles.barBtn}>
            <Text style={styles.barText}>{allSelected ? '해제' : '전체'}</Text>
          </Pressable>
          {/* 편집: 1개 선택 → 메모 편집 화면(거기서 프로젝트도 고름), 여러 개 선택 → 한꺼번에 프로젝트 지정 창 */}
          <Pressable
            accessibilityRole="button"
            disabled={none}
            onPress={() => {
              if (ids.length === 1) {
                const id = ids[0];
                exitSelect();
                navigation.navigate(ROUTES.MemoEdit, { memoId: id });
              } else {
                setPickingProject(true);
              }
            }}
            style={[styles.barBtn, none && styles.off]}
          >
            <Text style={styles.barText}>편집</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={none} onPress={doFavorite} style={[styles.barBtn, none && styles.off]}>
            <Text style={[styles.barText, { color: colors.mintDark }]}>{allFavorite ? '★ 해제' : '★ 즐겨찾기'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={none} onPress={doTrash} style={[styles.barBtn, none && styles.off]}>
            <Text style={[styles.barText, { color: colors.coral }]}>삭제</Text>
          </Pressable>
        </View>
      )}

      {/* 선택한 메모들의 프로젝트 고르기 */}
      <Modal transparent visible={pickingProject} animationType="fade" onRequestClose={() => setPickingProject(false)}>
        <View style={styles.dialogBackdrop}>
          <View style={styles.dialogBox} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>메모 {ids.length}개를 어느 프로젝트에 넣을까요?</Text>
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: spacing.sm }}>
              {[{ id: null, title: '프로젝트 없음 (연결 해제)' }, ...projects].map((p) => (
                <Pressable
                  key={p.id ?? 'none'}
                  accessibilityRole="button"
                  onPress={() => {
                    if (p.id) linkItems(p.id, 'memos', ids);
                    else unlinkItems('memos', ids);
                    setPickingProject(false);
                    exitSelect();
                  }}
                  style={styles.projOpt}
                >
                  <Text style={styles.projOptText} numberOfLines={1}>{p.title}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {projects.length === 0 && <Text style={styles.date}>아직 프로젝트가 없어요. 프로젝트 화면에서 먼저 만들어 주세요.</Text>}
            <Pressable accessibilityRole="button" onPress={() => setPickingProject(false)} style={styles.projClose}>
              <Text style={styles.barText}>취소</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ⋮ 메뉴: 오른쪽 위에 뜨는 작은 패널 */}
      <Modal transparent visible={menuOpen} animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)} accessibilityLabel="메뉴 닫기">
          <View style={[styles.menu, { top: insets.top + 56 }]}>
            {MENU.map((it) => {
              const active = it.route === currentRoute;
              return (
                <Pressable
                  key={it.route}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    setMenuOpen(false);
                    if (!active) navigation.navigate(it.route);
                  }}
                  style={({ pressed }) => [styles.menuItem, (active || pressed) && { backgroundColor: colors.mintSoft }]}
                >
                  <Text style={[styles.menuText, active && { color: colors.mintDark, fontWeight: '800' }]}>{it.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  more: { fontSize: 26, color: colors.ink, textAlign: 'right', fontWeight: '800' },
  headerBtn: { fontSize: font.bodyLg, fontWeight: '700', color: colors.mintDark, textAlign: 'right' },
  list: { padding: spacing.lg, gap: spacing.md },
  countRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { fontSize: font.body, color: colors.muted },
  searchBtn: { fontSize: font.body, color: colors.mintDark, fontWeight: '700' },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, minHeight: 46, borderRadius: 23, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  searchIcon: { fontSize: 16 },
  searchInput: { flex: 1, fontSize: font.bodyLg, color: colors.ink, paddingVertical: 8 },
  searchClear: { fontSize: 16, color: colors.muted },
  chips: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: { maxWidth: 180, minHeight: 36, paddingHorizontal: spacing.lg, borderRadius: 18, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  tools: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  toolText: { fontSize: font.body, color: colors.mintDark, fontWeight: '700' },
  toolIcon: { fontSize: 22, color: colors.ink },
  sectionTitle: { fontSize: font.caption, fontWeight: '800', color: colors.muted, marginTop: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'space-between' },
  listCol: { gap: spacing.sm },
  emptyBtn: { marginTop: spacing.md, minHeight: 44, paddingHorizontal: spacing.xl, borderRadius: radius.md, borderWidth: 1, borderColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  emptyBtnText: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },

  empty: { alignItems: 'center', paddingTop: 80, gap: spacing.sm },
  emptyTitle: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center' },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
  },
  // 검색/AI 에서 이동해 왔을 때 강조된 카드
  cardFocus: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  // 선택된 카드
  cardOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  check: { fontSize: 22, color: colors.muted },
  checkOn: { color: colors.mintDark },
  info: { flex: 1, gap: 6 },
  title: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  date: { fontSize: font.caption, color: colors.muted },
  body: { fontSize: font.body, color: colors.ink, lineHeight: 21, marginTop: 2 },
  ink: { fontSize: font.caption, color: colors.mintDark, fontWeight: '700', marginTop: 2 },

  // 되돌리기 안내 (＋ 버튼 왼쪽에 놓음)
  snack: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.xl + 56 + spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    minHeight: 48,
  },
  snackText: { flex: 1, fontSize: font.body, color: colors.white, paddingRight: spacing.sm },
  snackAction: { fontSize: font.body, fontWeight: '800', color: colors.mint },

  // 새 메모 버튼 (동그란 ＋)
  fab: {
    position: 'absolute',
    right: spacing.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.mintDark,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabIcon: { fontSize: 28, color: colors.white, lineHeight: 32 },

  // 선택 모드 아래 줄
  bar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.cream,
  },
  proj: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
  dialogBackdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialogBox: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  dialogTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  projOpt: { minHeight: 44, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  projOptText: { fontSize: font.bodyLg, color: colors.ink },
  projClose: { minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  barBtn: { flex: 1, minHeight: 44, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  off: { opacity: 0.35 },

  // ⋮ 메뉴
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.2)' },
  menu: {
    position: 'absolute',
    right: spacing.lg,
    minWidth: 170,
    backgroundColor: colors.cream,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  menuItem: { minHeight: 46, justifyContent: 'center', paddingHorizontal: spacing.lg },
  menuText: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
});
