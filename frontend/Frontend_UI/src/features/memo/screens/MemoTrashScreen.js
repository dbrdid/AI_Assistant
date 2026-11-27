// ============================================================
// MemoTrashScreen.js — 휴지통 화면
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { SheetModal } from '../../../shared/components/Motion';
import { deleteMemosForever, formatMD, memoTitle, restoreMemos, useTrashedMemos } from '../../../data/memos/MemoStore';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { linkItems, projectOf, useProjects } from '../../../data/projects/ProjectStore';
import Icon from '../../../shared/components/Icon';
import { CircleButton, InlineDeletePrompt } from '../../../shared/components/Ui';

export default function TrashScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const memos = useTrashedMemos();

  const [selecting, setSelecting] = useState(false); // 선택 모드인가
  const [selected, setSelected] = useState([]);      // 선택한 메모 번호들
  const [confirmRestore, setConfirmRestore] = useState(false);
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
  // 휴지통에 둔 채로 프로젝트만 바꿈: 복구하면 그 프로젝트로 돌아옴
  const projects = useProjects();
  const [moving, setMoving] = useState(false);
  const moveToProject = (projectId) => {
    if (!linkItems(projectId, 'memos', ids)) return;
    setMoving(false);
    showNotice(`메모 ${ids.length}개를 프로젝트로 옮겼어요`);
    exitSelect();
  };
  const exitSelect = () => {
    setSelecting(false);
    setSelected([]);
  };
  useEffect(() => {
    if (!selecting) return undefined;
    return navigation.registerHardwareBackGuard?.(() => {
      exitSelect();
      return false;
    });
  }, [navigation, selecting]);

  const restoreSelected = () => {
    setConfirmRestore(false);
    if (!ids.length) return;
    try {
      restoreMemos(ids);
      showNotice(`메모 ${ids.length}개를 복구했어요`);
      exitSelect();
    } catch (error) {
      showNotice(error.message || '메모를 복구하지 못했어요.');
    }
  };
  const deleteSelected = () => {
    if (!ids.length) return;
    try {
      deleteMemosForever(ids);
      showNotice(`메모 ${ids.length}개를 삭제했어요`);
      exitSelect();
    } catch (error) {
      showNotice(error.message || '메모를 삭제하지 못했어요.');
    }
  };

  const none = ids.length === 0;
  // 복구 안내: 프로젝트에 속해 있던 메모는 그 프로젝트로 자동 복구됨 (스토리보드 64장)
  const projectNames = [...new Set(ids.map((id) => projectOf('memos', id)?.title).filter(Boolean))];
  const restoreSub =
    projectNames.length > 0
      ? `복구한 메모는 이전 프로젝트(${projectNames.join(', ')})로 자동 복구됩니다. 프로젝트가 없는 메모는 모든 메모로 돌아갑니다`
      : '복구한 메모는 모든 메모로 돌아갑니다';

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="휴지통"
        onBack={selecting ? exitSelect : navigation.goBack}
        right={
          !selecting && memos.length > 0 ? (
            <CircleButton icon="checkSquare" label="메모 선택" onPress={() => setSelecting(true)} />
          ) : null
        }
      />

      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}>
        {selecting && <Text accessibilityLiveRegion="polite" style={styles.count}>{ids.length}개 선택</Text>}

        {memos.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>휴지통이 비어 있어요</Text>
          </View>
        ) : (
          memos.map((m) => {
            const on = ids.includes(m.id);
            const project = projectOf('memos', m.id);
            return (
              <Pressable
                key={m.id}
                accessibilityRole={selecting ? 'checkbox' : 'button'}
                accessibilityState={selecting ? { checked: on } : undefined}
                accessibilityLabel={`메모 ${memoTitle(m)}`}
                onPress={() => {
                  if (selecting) toggle(m.id);
                  else { setSelecting(true); setSelected([m.id]); }
                }}
                onLongPress={() => {
                  if (!selecting) {
                    setSelecting(true);
                    setSelected([m.id]);
                  }
                }}
                style={[styles.row, on && styles.rowSelected]}
              >
                <Icon name={selecting ? (on ? 'checkSquare' : 'square') : 'file'} size={18} color={on ? colors.ink : colors.muted} />
                <View style={styles.info}>
                  <Text style={styles.title} numberOfLines={1}>{memoTitle(m)}</Text>
                  <Text style={styles.date}>삭제 {formatMD(m.deletedAt)}, 수정 {formatMD(m.updatedAt)}</Text>
                  {project && <Text style={styles.date} numberOfLines={1}>{project.title}</Text>}
                  {m.body.trim().length > 0 && <Text style={styles.body} numberOfLines={2}>{m.body}</Text>}
                  {m.strokes && m.strokes.length > 0 && (
                    <View style={styles.inkRow}>
                      <Icon name="pencil" size={13} color={colors.muted} />
                      <Text style={styles.ink}>손글씨 포함</Text>
                    </View>
                  )}
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

      {/* 선택 모드 아래 줄: 취소, 전체, 이동, 복구, 삭제 */}
      {selecting && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <View style={styles.barRow}>
          <Pressable accessibilityRole="button" onPress={exitSelect} style={styles.barBtn}>
            <Text style={styles.barText}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setSelected(allSelected ? [] : memos.map((m) => m.id))} style={styles.barBtn}>
            <Text style={styles.barText}>{allSelected ? '해제' : '전체'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={none}
            onPress={() => { if (ids.length) setMoving(true); }}
            style={[styles.barBtn, none && styles.off]}
          >
            <Text style={styles.barText}>이동</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={none} onPress={() => setConfirmRestore(true)} style={[styles.barBtn, none && styles.off]}>
            <Text style={styles.barText}>복구</Text>
          </Pressable>
          </View>
          {!none && <InlineDeletePrompt question={`메모 ${ids.length}개를 영구 삭제할까요?`} onDelete={deleteSelected} />}
        </View>
      )}

      <SheetModal visible={moving} onClose={() => setMoving(false)} label="옮길 프로젝트">
        <Text style={styles.dialogTitle}>옮길 프로젝트</Text>
        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 300 }}>
          {projects.length === 0 && <Text style={styles.dialogSub}>이 공간에 프로젝트가 없어요.</Text>}
          {projects.map((project) => (
            <Pressable key={project.id} accessibilityRole="button" onPress={() => moveToProject(project.id)} style={styles.dialogOption}>
              <Text style={styles.dialogOptionText} numberOfLines={1}>{project.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={() => setMoving(false)} style={styles.dialogOption}>
          <Text style={[styles.dialogOptionText, { textAlign: 'center' }]}>취소</Text>
        </Pressable>
      </SheetModal>

      <ConfirmDialog
        visible={confirmRestore}
        title="메모를 복구하시겠습니까?"
        sub={restoreSub}
        onCancel={() => setConfirmRestore(false)}
        onConfirm={restoreSelected}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dialogTitle: { fontSize: font.header, fontWeight: '600', color: colors.ink, marginBottom: spacing.sm },
  dialogSub: { fontSize: font.body, color: colors.muted },
  dialogOption: { minHeight: 46, justifyContent: 'center', paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  dialogOptionText: { fontSize: font.bodyLg, color: colors.ink },
  root: { flex: 1, backgroundColor: colors.cream },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: 2 },
  count: { fontSize: font.caption, color: colors.muted },

  empty: { alignItems: 'center', paddingTop: 80, gap: spacing.sm },
  emptyTitle: { fontSize: 13, fontWeight: '400', color: colors.subtle },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
    minHeight: 52,
    paddingVertical: spacing.sm,
    paddingHorizontal: 6,
  },
  rowSelected: { borderColor: colors.ink },
  info: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '500', color: colors.ink },
  date: { fontSize: font.caption, color: colors.muted },
  body: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  inkRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ink: { fontSize: font.caption, color: colors.muted },

  notice: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  noticeText: {
    backgroundColor: colors.action,
    color: colors.onPrimary,
    fontSize: font.body,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: 4,
    overflow: 'hidden',
  },

  bar: { paddingHorizontal: 16, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  barRow: { flexDirection: 'row', gap: 4 },
  barBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: 15, fontWeight: '500', color: colors.ink },
  off: { opacity: 0.35 },
});
