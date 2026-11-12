// ============================================================
// FilesScreen.js — 파일 보관함 화면 (사이드 메뉴의 "파일 보관함" / 검색·AI 결과에서 이동하는 곳)
// ============================================================
// 파일을 "저장 위치"별로 나눠서 보여줍니다. (지금은 MemoStore.js 의 샘플 파일. 파일 추가/열기는 아직 없음)
//   📱 로컬   : 사용자가 만들거나 업로드한 파일. 기본 저장 위치이고 이 기기에 저장됩니다.
//   ☁️ 클라우드 : 나중에 프로젝트에 팀원을 초대해 만든 공유 공간의 파일이 저장되는 곳.
//               (프로젝트/팀 기능이 아직 없어서 지금은 "준비 중" 안내만 보임)
// 검색 결과나 AI 출처를 눌러 이동해 오면 route.params.focusId 로 전달된 파일로 자동 스크롤 + 2.5초 강조합니다.
// (동작 방식은 MemoListScreen.js 와 같습니다)
//
// props (AppNavigator 가 넣어줌)
//   navigation : 화면 이동 도구
//   route      : { name, params: { focusId } }

import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { STORAGE_INFO } from '../../../data/memos/MemoStore';
import { deleteFile, getFiles, pickAndAddFiles, useFiles } from '../../../data/files/FileStore';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

// 파일 종류별 아이콘
const KIND_ICON = { 슬라이드: '📊', PDF: '📕', 문서: '📄', 이미지: '🖼️', 표: '📈', 녹음: '🎙️' };

export default function FilesScreen({ navigation, route }) {
  const menuSwipe = useSwipeToOpenMenu();

  useFiles(); // 파일이 추가/삭제되면 화면 다시 그리기
  const [busy, setBusy] = useState(false);
  const [delId, setDelId] = useState(null);
  const focusId = route.params?.focusId; // 강조하고 이동할 파일 번호 (없을 수 있음)

  // 지금 보고 있는 탭 ('local' | 'cloud'). 검색/AI 에서 이동해 온 파일이 클라우드에 있으면 그 탭부터 열기
  const [tab, setTab] = useState(() => {
    const cloudHit = focusId && getFiles('cloud').some((f) => f.id === focusId);
    return cloudHit ? 'cloud' : 'local';
  });
  const files = getFiles(tab); // 선택한 탭의 파일들
  const addFiles = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await pickAndAddFiles();
    } catch (e) {
      Alert.alert('파일을 추가하지 못했어요', '다시 시도해 주세요.');
    }
    setBusy(false);
  };
  const [highlightId, setHighlightId] = useState(focusId || null);
  const scrollRef = useRef(null);

  // 2.5초 뒤에 강조를 해제
  useEffect(() => {
    if (!focusId) return undefined;
    const id = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(id);
  }, [focusId]);

  // 강조할 카드의 위치로 스크롤
  const onCardLayout = (id, e) => {
    if (id === focusId && scrollRef.current) {
      scrollRef.current.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - spacing.lg), animated: true });
    }
  };

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader title="파일 보관함" onBack={navigation.goBack} />
      <ScrollView ref={scrollRef} contentContainerStyle={styles.list}>
        {/* 로컬 / 클라우드 탭 (칩 안의 숫자 = 그 위치의 파일 개수) */}
        <View style={styles.tabs}>
          {['local', 'cloud'].map((key) => {
            const on = tab === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setTab(key)}
                style={[styles.tab, on && styles.tabOn]}
              >
                <Text style={[styles.tabText, on && styles.tabTextOn]}>
                  {STORAGE_INFO[key].icon} {STORAGE_INFO[key].label} {getFiles(key).length}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.count}>{STORAGE_INFO[tab].desc}</Text>

        {tab === 'local' && (
          <Pressable accessibilityRole="button" disabled={busy} onPress={addFiles} style={[styles.add, busy && { opacity: 0.5 }]}>
            <Text style={styles.addText}>{busy ? '추가하는 중…' : '＋ 파일 추가'}</Text>
          </Pressable>
        )}

        {/* 클라우드 탭인데 파일이 없을 때: 아직 팀 공유 기능이 없다는 안내 */}
        {files.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {tab === 'cloud' ? '클라우드에 저장된 파일이 없어요' : '로컬에 저장된 파일이 없어요'}
            </Text>
            <Text style={styles.emptySub}>
              {tab === 'cloud'
                ? '프로젝트에 팀원을 초대하면 함께 쓰는 공간의 파일이 여기에 저장돼요. (준비 중)'
                : '직접 만들거나 업로드한 파일이 여기에 저장돼요.'}
            </Text>
          </View>
        )}

        {files.map((f) => (
          <View
            key={f.id}
            onLayout={(e) => onCardLayout(f.id, e)}
            style={[styles.card, highlightId === f.id && styles.cardFocus]}
          >
            <View style={styles.icon}>
              <Text style={styles.iconText}>{KIND_ICON[f.kind] || '📄'}</Text>
            </View>
            <View style={styles.info}>
              <Text style={styles.name}>{f.name}</Text>
              <Text style={styles.meta}>
                {f.kind} · {f.size} · {f.date}
              </Text>
              {f.text ? (
                <Text style={styles.desc} numberOfLines={3}>{f.text.slice(0, 120)}</Text>
              ) : (
                <Text style={styles.note}>내용 인식은 준비 중이에요 · 파일 이름으로 검색돼요</Text>
              )}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`${f.name} 삭제`} onPress={() => setDelId(f.id)} hitSlop={10}>
              <Text style={styles.del}>🗑</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      <ConfirmDialog
        visible={delId !== null}
        title="파일을 삭제할까요?"
        sub="이 기기에 저장된 파일이 지워지고 복구할 수 없어요."
        confirmText="삭제"
        danger
        onCancel={() => setDelId(null)}
        onConfirm={() => {
          deleteFile(delId);
          setDelId(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  count: { fontSize: font.body, color: colors.muted },
  // 탭
  tabs: { flexDirection: 'row', gap: spacing.sm },
  tab: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  tabOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  tabText: { fontSize: font.body, color: colors.ink },
  tabTextOn: { color: colors.white, fontWeight: '700' },
  // 파일이 없을 때 안내
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
  },
  cardFocus: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.mintSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontSize: 22 },
  info: { flex: 1, gap: 4 },
  name: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  meta: { fontSize: font.caption, color: colors.muted },
  add: { minHeight: 46, borderRadius: 23, borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  addText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  note: { fontSize: font.caption, color: colors.muted, marginTop: 2 },
  del: { fontSize: 18 },
  desc: { fontSize: font.body, color: colors.ink, lineHeight: 20, marginTop: 2 },
});
