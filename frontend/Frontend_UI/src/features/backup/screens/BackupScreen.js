// ============================================================
// BackupScreen.js — 백업 및 복원
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { MAX_BACKUPS, createBackup, deleteBackup, restoreBackup, useBackups } from '../../../data/backup/BackupStore';
import { switchWorkspace, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function BackupScreen() {
  const menuSwipe = useSwipeToOpenMenu();
  const { current } = useWorkspaces();
  const [order, setOrder] = useState('new'); // 'new' 최신순 | 'old' 오래된순
  const list = useBackups(order);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'restore' | 'delete' | null
  const [delId, setDelId] = useState(null);
  const [notice, setNotice] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const showNotice = (t) => {
    setNotice(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(''), 2600);
  };
  const selected = list.find((b) => b.id === selectedId) || null;
  useEffect(() => {
    if (selectedId && !list.some((b) => b.id === selectedId)) setSelectedId(null); // 삭제된 항목 선택 해제
  }, [list, selectedId]);

  const doBackup = async () => {
    if (busy) return;
    setBusy(true);
    const r = await createBackup(false);
    setBusy(false);
    if (!r.ok) return showNotice(r.reason === 'not-personal' ? '개인 공간에서만 백업할 수 있어요' : '백업하지 못했어요. 저장 공간이 부족할 수 있어요. 오래된 백업을 지우고 다시 시도해 주세요.');
    showNotice(r.dropped > 0 ? `백업했어요 · 가장 오래된 백업 ${r.dropped}개는 지워졌어요` : '백업했어요');
  };

  const doRestore = async () => {
    setConfirm(null);
    if (!selected || busy) return;
    setBusy(true);
    const r = await restoreBackup(selected.id);
    setBusy(false);
    if (!r.ok) return showNotice(r.reason === 'not-personal' ? '개인 공간에서만 복원할 수 있어요' : '복원하지 못했어요');
    setSelectedId(null);
    showNotice(r.safety ? '복원했어요 · 복원 전 상태는 "자동" 백업으로 남겨 뒀어요' : '복원했어요');
  };

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader title="백업 및 복원" />
      {!current.personal ? (
        // 조직(공유) 공간에서는 백업·복원을 쓸 수 없음 → 개인 공간으로 안내
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>개인 공간에서만 백업·복원할 수 있어요</Text>
            <Text style={styles.cardSub}>
              지금은 「{current.name}」 공간을 보고 있어요. 팀과 함께 쓰는 공간의 기록은 백업·복원 대상이 아니에요.
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => switchWorkspace('personal')} style={[styles.btn, styles.primary]}>
            <Text style={styles.primaryText}>개인 공간으로 전환</Text>
          </Pressable>
        </ScrollView>
      ) : (
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>프로젝트, 메모, 할 일을 임시 저장합니다</Text>
          <Text style={styles.cardSub}>
            개인 공간의 기록만 저장돼요. 파일 보관함의 파일과 팀 공간의 기록은 포함되지 않아요.
          </Text>
        </View>

        <View style={styles.row}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={doBackup} style={[styles.btn, styles.primary, busy && { opacity: 0.5 }]}>
            <Text style={styles.primaryText}>{busy ? '처리 중…' : '백업하기'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !selected }}
            disabled={!selected || busy}
            onPress={() => setConfirm('restore')}
            style={[styles.btn, styles.ghost, (!selected || busy) && { opacity: 0.4 }]}
          >
            <Text style={styles.ghostText}>복원하기</Text>
          </Pressable>
        </View>
        {!selected && list.length > 0 && <Text style={styles.hint}>복원할 백업을 아래에서 선택해 주세요</Text>}

        <View style={styles.listHead}>
          <Text style={styles.listTitle}>백업 목록 {list.length}/{MAX_BACKUPS}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`정렬 ${order === 'new' ? '최신순' : '오래된순'}`} onPress={() => setOrder((o) => (o === 'new' ? 'old' : 'new'))} hitSlop={8}>
            <Text style={styles.sort}>정렬 · {order === 'new' ? '최신순' : '오래된순'} ⇅</Text>
          </Pressable>
        </View>

        {list.length === 0 ? (
          <Text style={styles.empty}>아직 백업이 없어요. "백업하기"를 눌러 지금 상태를 저장해 보세요.</Text>
        ) : (
          list.map((b) => {
            const on = b.id === selectedId;
            return (
              <Pressable
                key={b.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${fmt(b.createdAt)} 백업${b.auto ? ', 자동' : ''}`}
                onPress={() => setSelectedId(on ? null : b.id)}
                style={[styles.item, on && styles.itemOn]}
              >
                <Text style={[styles.radio, on && { color: colors.mintDark }]}>{on ? '◉' : '○'}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.dateRow}>
                    <Text style={styles.date}>{fmt(b.createdAt)}</Text>
                    {b.auto && (
                      <View style={styles.autoTag}>
                        <Text style={styles.autoText}>자동</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.counts}>메모 {b.counts.memos} · 할 일 {b.counts.tasks} · 프로젝트 {b.counts.projects}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="백업 삭제" onPress={() => setDelId(b.id)} hitSlop={10}>
                  <Text style={styles.del}>🗑</Text>
                </Pressable>
              </Pressable>
            );
          })
        )}
      </ScrollView>
      )}

      {!!notice && (
        <View pointerEvents="none" style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}

      <ConfirmDialog
        visible={confirm === 'restore'}
        title="이 백업으로 복원할까요?"
        sub={selected ? `${fmt(selected.createdAt)} 시점으로 메모·할 일·프로젝트가 바뀌어요. 지금 상태는 "자동" 백업으로 남겨 두니 필요하면 다시 되돌릴 수 있어요.` : ''}
        confirmText="복원"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={doRestore}
      />
      <ConfirmDialog
        visible={delId !== null}
        title="백업을 삭제할까요?"
        sub="삭제한 백업은 되돌릴 수 없어요."
        confirmText="삭제"
        danger
        onCancel={() => setDelId(null)}
        onConfirm={async () => {
          const id = delId;
          setDelId(null);
          const ok = await deleteBackup(id);
          showNotice(ok ? '백업을 삭제했어요' : '삭제하지 못했어요');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.mintSoft, gap: spacing.sm },
  cardTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  cardSub: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  row: { flexDirection: 'row', gap: spacing.md },
  btn: { flex: 1, minHeight: 52, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: colors.mintDark },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.mint },
  ghostText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  hint: { fontSize: font.caption, color: colors.muted },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  listTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  sort: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  empty: { fontSize: font.body, color: colors.muted, lineHeight: 20, paddingVertical: spacing.lg },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 64, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  itemOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  radio: { fontSize: 22, color: colors.muted },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  date: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  counts: { fontSize: font.caption, color: colors.muted },
  autoTag: { paddingHorizontal: spacing.sm, minHeight: 20, borderRadius: 10, backgroundColor: colors.line, justifyContent: 'center' },
  autoText: { fontSize: 11, fontWeight: '800', color: colors.ink },
  del: { fontSize: 18 },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.ink, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body, textAlign: 'center' },
});
