// ============================================================
// MemoTrashScreen.js — 휴지통 화면
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { deleteMemosForever, formatMD, memoTitle, restoreMemos, useTrashedMemos } from '../../../data/memos/MemoStore';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { projectOf } from '../../../data/projects/ProjectStore';

export default function TrashScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu();
  const insets = useSafeAreaInsets();
  const memos = useTrashedMemos();

  const [selecting, setSelecting] = useState(false); // 선택 모드인가
  const [selected, setSelected] = useState([]);      // 선택한 메모 번호들
  const [confirm, setConfirm] = useState(null);      // 'restore' | 'delete' | null (확인 창)
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef(null);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const showNotice = (msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 2000);
  };

  // 목록에 아직 있는 선택만 유효 (다른 곳에서 바뀌었을 수 있어서)
  const ids = selected.filter((id) => memos.some((m) => m.id === id));
  const allSelected = memos.length > 0 && ids.length === memos.length;

  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const exitSelect = () => {
    setSelecting(false);
    setSelected([]);
  };

  const doConfirm = () => {
    if (confirm === 'restore') {
      restoreMemos(ids);
      showNotice(`메모 ${ids.length}개를 복구했어요`);
    } else if (confirm === 'delete') {
      deleteMemosForever(ids);
      showNotice(`메모 ${ids.length}개를 삭제했어요`);
    }
    setConfirm(null);
    exitSelect();
  };

  const none = ids.length === 0;
  // 복구 안내: 프로젝트에 속해 있던 메모는 그 프로젝트로 자동 복구됨 (스토리보드 64장)
  const projectNames = [...new Set(ids.map((id) => projectOf('memos', id)?.title).filter(Boolean))];
  const restoreSub =
    projectNames.length > 0
      ? `복구한 메모는 이전 프로젝트(${projectNames.join(', ')})로 자동 복구됩니다. 프로젝트가 없는 메모는 모든 메모로 돌아갑니다`
      : '복구한 메모는 모든 메모로 돌아갑니다';

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader
        title="휴지통"
        onBack={navigation.goBack}
        right={
          !selecting && memos.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel="메모 선택" onPress={() => setSelecting(true)} hitSlop={10}>
              <Text style={styles.headerBtn}>선택</Text>
            </Pressable>
          ) : null
        }
      />

      <ScrollView contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}>
        <Text style={styles.count}>
          메모 {memos.length}개{selecting ? ` · ${ids.length}개 선택` : ' · 복구하거나 완전히 삭제할 수 있어요'}
        </Text>

        {memos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>휴지통이 비어 있어요</Text>
            <Text style={styles.emptySub}>삭제한 메모가 여기에 모여요</Text>
          </View>
        ) : (
          memos.map((m) => {
            const on = ids.includes(m.id);
            return (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`메모 ${memoTitle(m)}`}
                onPress={() => selecting && toggle(m.id)}
                onLongPress={() => {
                  if (!selecting) {
                    setSelecting(true);
                    setSelected([m.id]);
                  }
                }}
                style={[styles.card, on && styles.cardOn]}
              >
                {selecting && <Text style={[styles.check, on && styles.checkOn]}>{on ? '☑' : '☐'}</Text>}
                <View style={styles.info}>
                  <Text style={styles.title} numberOfLines={1}>{memoTitle(m)}</Text>
                  <Text style={styles.date}>삭제 {formatMD(m.deletedAt)} · 수정 {formatMD(m.updatedAt)}</Text>
                  {projectOf('memos', m.id) && <Text style={styles.proj}>{projectOf('memos', m.id).title}</Text>}
                  {m.body.trim().length > 0 && <Text style={styles.body} numberOfLines={2}>{m.body}</Text>}
                  {m.strokes && m.strokes.length > 0 && <Text style={styles.ink}>✎ 손글씨 포함</Text>}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {!!notice && (
        <View pointerEvents="none" style={[styles.notice, { bottom: insets.bottom + (selecting ? 84 : spacing.xl) }]}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}

      {/* 선택 모드 아래 줄: 취소 · 전체 · 이동 · 복구 · 삭제 */}
      {selecting && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <Pressable accessibilityRole="button" onPress={exitSelect} style={styles.barBtn}>
            <Text style={styles.barText}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setSelected(allSelected ? [] : memos.map((m) => m.id))} style={styles.barBtn}>
            <Text style={styles.barText}>{allSelected ? '해제' : '전체'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={none}
            onPress={() => showNotice('프로젝트로 이동은 준비 중이에요')}
            style={[styles.barBtn, none && styles.off]}
          >
            <Text style={styles.barText}>이동</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={none} onPress={() => setConfirm('restore')} style={[styles.barBtn, none && styles.off]}>
            <Text style={[styles.barText, { color: colors.mintDark }]}>복구</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={none} onPress={() => setConfirm('delete')} style={[styles.barBtn, none && styles.off]}>
            <Text style={[styles.barText, { color: colors.coral }]}>삭제</Text>
          </Pressable>
        </View>
      )}

      {/* 복구 / 삭제 확인 창 (스토리보드 63·64장) */}
      <ConfirmDialog
        visible={confirm === 'restore'}
        title="메모를 복구하시겠습니까?"
        sub={restoreSub}
        onCancel={() => setConfirm(null)}
        onConfirm={doConfirm}
      />
      <ConfirmDialog
        visible={confirm === 'delete'}
        title="메모를 삭제하시겠습니까?"
        sub="삭제한 메모는 복구할 수 없습니다"
        confirmText="삭제"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={doConfirm}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  headerBtn: { fontSize: font.bodyLg, fontWeight: '700', color: colors.mintDark, textAlign: 'right' },
  list: { padding: spacing.lg, gap: spacing.md },
  count: { fontSize: font.body, color: colors.muted },

  empty: { alignItems: 'center', paddingTop: 80, gap: spacing.sm },
  emptyTitle: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted },

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
  cardOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  check: { fontSize: 22, color: colors.muted },
  checkOn: { color: colors.mintDark },
  info: { flex: 1, gap: 4 },
  title: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  date: { fontSize: font.caption, color: colors.muted },
  body: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  proj: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
  ink: { fontSize: font.caption, color: colors.mintDark, fontWeight: '700' },

  notice: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  noticeText: {
    backgroundColor: colors.ink,
    color: colors.white,
    fontSize: font.body,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: 999,
    overflow: 'hidden',
  },

  bar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.cream,
  },
  barBtn: { flex: 1, minHeight: 44, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  off: { opacity: 0.35 },
});
