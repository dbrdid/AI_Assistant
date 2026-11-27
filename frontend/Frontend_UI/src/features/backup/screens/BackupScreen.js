// ============================================================
// BackupScreen.js — 백업 및 복원
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WorkspaceHeader } from '../../stella/WorkspaceScreen';
import { palette as c, styles as s } from '../../stella/theme';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import Icon from '../../../shared/components/Icon';
import { MAX_BACKUPS, createBackup, deleteBackup, restoreBackup, useBackups } from '../../../data/backup/BackupStore';
import { switchWorkspace, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function BackupScreen({ navigation }) {
  const { current } = useWorkspaces();
  const [order, setOrder] = useState('new'); // 'new' 최신순 | 'old' 오래된순
  const list = useBackups(order);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'restore' | 'delete' | null
  const [delId, setDelId] = useState(null);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const activeAction = useRef(false);
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

  const runAction = async (action) => {
    if (activeAction.current) return;
    activeAction.current = true;
    clearTimeout(timer.current);
    setNotice('');
    setErrorMessage('');
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.warn('[backup] 작업 중 오류', error);
      setErrorMessage('백업 작업을 완료하지 못했어요. 다시 시도해 주세요.');
    } finally {
      activeAction.current = false;
      setBusy(false);
    }
  };
  const doBackup = () => runAction(async () => {
    const r = await createBackup(false);
    if (!r.ok) return setErrorMessage(r.reason === 'not-personal' ? '개인 공간에서만 백업할 수 있어요' : r.message || '백업하지 못했어요. 다시 시도해 주세요.');
    showNotice(r.dropped > 0 ? `백업했어요. 가장 오래된 백업 ${r.dropped}개는 지워졌어요` : '백업했어요');
  });

  const doRestore = () => {
    setConfirm(null);
    if (!selected) return;
    return runAction(async () => {
      const r = await restoreBackup(selected.id);
      if (!r.ok) return setErrorMessage(r.reason === 'not-personal' ? '개인 공간에서만 복원할 수 있어요' : r.message || '복원하지 못했어요');
      setSelectedId(null);
      showNotice(r.safety ? '복원했어요. 복원 전 상태는 "자동" 백업으로 남겨 뒀어요' : '복원했어요');
    });
  };

  // 메뉴 행: 공간 메뉴·AI 연결과 같은 평평한 행 (아이콘, 글자, 오른쪽 표시)
  const row = (icon, label, onPress, { disabled = false, right = null, a11y } = {}) => (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y ?? label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.menuRow, (disabled || pressed) && { opacity: disabled ? 0.4 : 0.6 }]}>
      <Icon name={icon} size={18} color={c.muted} /><Text style={[s.menuLabel, { flex: 1 }]}>{label}</Text>{right}
    </Pressable>
  );
  return (
    <View style={s.root}>
      <WorkspaceHeader title="백업 및 복원" onBack={navigation.goBack} />
      {!current.personal ? (
        // 팀(공유) 공간에서는 백업·복원을 쓸 수 없음 → 개인 공간으로
        <ScrollView contentContainerStyle={s.page}>
          <Text style={[s.meta, styles.line]}>백업과 복원은 개인 공간에서만 할 수 있어요</Text>
          {row('home', '개인 공간으로 전환', () => switchWorkspace('personal'))}
        </ScrollView>
      ) : (
      <ScrollView contentContainerStyle={s.page}>
        {row('cloud', busy ? '처리 중…' : '지금 백업하기', doBackup, { disabled: busy })}
        <Text style={[s.meta, styles.line]}>개인 공간의 프로젝트, 메모, 할 일만 저장돼요</Text>
        {!!errorMessage && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[s.error, styles.line]}>{errorMessage}</Text>}

        <View style={styles.sectionHead}>
          <Text style={s.homeSectionLabel}>백업 {list.length}/{MAX_BACKUPS}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`정렬 ${order === 'new' ? '최신순' : '오래된순'}`} onPress={() => setOrder((o) => (o === 'new' ? 'old' : 'new'))} hitSlop={8} style={styles.sort}>
            <Text style={s.meta}>{order === 'new' ? '최신순' : '오래된순'}</Text>
          </Pressable>
        </View>
        {list.length === 0 ? (
          <Text style={[s.meta, styles.line]}>백업이 없어요</Text>
        ) : (
          list.map((b) => {
            const on = b.id === selectedId;
            return (
              <View key={b.id} style={styles.item}>
                <Pressable accessibilityRole="radio" accessibilityState={{ checked: on, disabled: busy }} disabled={busy}
                  accessibilityLabel={`${fmt(b.createdAt)} 백업${b.auto ? ', 자동' : ''}`} onPress={() => setSelectedId(on ? null : b.id)}
                  style={({ pressed }) => [styles.itemMain, pressed && { opacity: 0.6 }]}>
                  <Icon name="file" size={18} color={c.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.date, on && { fontWeight: '700' }]}>{fmt(b.createdAt)}{b.auto ? ', 자동' : ''}</Text>
                    <Text style={s.meta}>메모 {b.counts.memos}, 할 일 {b.counts.tasks}, 프로젝트 {b.counts.projects}</Text>
                  </View>
                  {on && <Icon name="check" size={16} color={c.text} />}
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`${fmt(b.createdAt)} 백업 삭제`} disabled={busy} onPress={() => setDelId(b.id)} hitSlop={8} style={styles.trash}>
                  <Icon name="trash" size={18} color={c.muted} />
                </Pressable>
              </View>
            );
          })
        )}
        {/* 백업을 고르면 그 아래에 복원 */}
        {selected && row('refresh', '이 백업으로 복원', () => setConfirm('restore'), { disabled: busy, a11y: `${fmt(selected.createdAt)} 백업으로 복원` })}
      </ScrollView>
      )}

      {!!notice && (
        <View pointerEvents="none" style={styles.notice}>
          <Text accessibilityLiveRegion="polite" style={styles.noticeText}>{notice}</Text>
        </View>
      )}

      <ConfirmDialog
        visible={confirm === 'restore'}
        title="이 백업으로 복원할까요?"
        sub={selected ? `${fmt(selected.createdAt)} 시점으로 메모, 할 일, 프로젝트가 바뀌어요. 지금 상태는 "자동" 백업으로 남겨 두니 필요하면 다시 되돌릴 수 있어요.` : ''}
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
        onConfirm={() => {
          const id = delId;
          setDelId(null);
          if (id === null) return;
          return runAction(async () => {
            if (await deleteBackup(id)) showNotice('백업을 삭제했어요');
            else setErrorMessage('백업을 삭제하지 못했어요. 다시 시도해 주세요.');
          });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  line: { paddingVertical: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xl },
  sort: { minHeight: 44, justifyContent: 'center' },
  item: { flexDirection: 'row', alignItems: 'center' },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 },
  date: { color: c.text, fontSize: 13 },   // 공용 menuLabel은 flex:1이라 두 줄 사이가 벌어짐
  trash: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.action, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body, textAlign: 'center' },
});
