// ============================================================
// SpacesScreen.js — 워크스페이스 전환 및 공간 목록
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import Icon from '../../../shared/components/Icon';
import { CircleButton } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { switchWorkspace, useSpaceInfo, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { occursOn, useAllTasks } from '../../../data/tasks/TaskStore';
import { useAllMemos } from '../../../data/memos/MemoStore';
import { toKey } from '../../calendar/utils/DateUtils';

export function SpaceTile({ space, size = 40 }) {
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: `${space.color}26` }]}>
      {space.personal ? (
        <Icon name="lock" size={Math.round(size * 0.45)} color={colors.mintDark} />
      ) : (
        <Text style={[styles.tileText, { color: space.color, fontSize: Math.round(size * 0.42) }]}>{space.fullName.trim().charAt(0) || '?'}</Text>
      )}
    </View>
  );
}

export default function SpacesScreen({ navigation }) {
  const { list, current } = useWorkspaces();
  const spaces = useSpaceInfo();
  const tasks = useAllTasks();
  const memos = useAllMemos();
  const today = toKey(new Date());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const statsOf = (id) => {
    const mine = tasks.filter((t) => t.workspaceId === id);
    const left = mine.filter((t) => t.status !== '완료').length;
    const todayN = mine.filter((t) => t.status !== '완료' && occursOn(t, today)).length;
    const memoN = memos.filter((m) => m.workspaceId === id).length;
    return [`메모 ${memoN}`, `남은 할 일 ${left}`, todayN ? `오늘 ${todayN}` : ''].filter(Boolean).join(' · ');
  };
  const showNotice = (message) => {
    setNotice(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(''), 2200);
  };
  const pickWorkspace = async (workspace) => {
    if (busy || workspace.id === current.id) return;
    setBusy(true);
    try {
      await switchWorkspace(workspace.id);
      showNotice(`「${workspace.name}」로 전환했어요`);
    } catch (error) {
      showNotice(error.message || '워크스페이스를 전환하지 못했어요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="워크스페이스 전환" onBack={navigation.goBack} right={<CircleButton icon="plus" label="새 워크스페이스 만들기" onPress={() => navigation.navigate(ROUTES.WorkspaceCreate)} />} />
      <ScrollView contentContainerStyle={styles.content}>
        {list.map((w) => {
          const space = spaces[w.id];
          const active = w.id === current.id;
          return (
            <View key={w.id} style={[styles.card, active && styles.cardOn]}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: busy }}
                accessibilityLabel={`${w.name} 워크스페이스 선택${active ? ', 현재 워크스페이스' : ''}`}
                disabled={busy}
                onPress={() => pickWorkspace(w)}
                style={({ pressed }) => [styles.workspacePick, pressed && !active && { backgroundColor: colors.mintSoft }]}
              >
                <SpaceTile space={space} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.name} numberOfLines={1}>{w.name}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {w.personal ? '나만 보는 메모 · 일정 · 이 기기에만 저장' : `${w.role} · 멤버 ${w.members}명${w.serverId ? '' : ' · 서버 연결 전'}`}
                  </Text>
                  <Text style={styles.stats} numberOfLines={1}>{statsOf(w.id)}</Text>
                </View>
                {active && <View style={styles.badge}><Text style={styles.badgeText}>현재</Text></View>}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${w.name} 공간 홈 열기`}
                onPress={() => navigation.navigate(ROUTES.SpaceHome, { workspaceId: w.id })}
                hitSlop={6}
                style={({ pressed }) => [styles.openButton, pressed && { backgroundColor: colors.mintSoft }]}
              >
                <Icon name="chevronRight" size={18} color={colors.muted} />
              </Pressable>
            </View>
          );
        })}

        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.WorkspaceCreate)} style={({ pressed }) => [styles.action, styles.actionNew, pressed && { opacity: 0.7 }]}>
            <Icon name="plus" size={16} color={colors.mintDark} strokeWidth={2.4} />
            <Text style={styles.actionNewText}>새 워크스페이스 만들기</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.WorkspaceInvite)} style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}>
            <Icon name="userPlus" size={16} color={colors.ink} />
            <Text style={styles.actionText}>초대 코드로 참여</Text>
          </Pressable>
        </View>

        <Text style={styles.hint}>
          워크스페이스를 선택하면 현재 공간이 바뀝니다. 오른쪽 화살표로 각 공간 홈을 열 수 있어요. 개인 기록은 나만 볼 수 있고, 팀 기록은 멤버들과 함께 관리해요.
        </Text>
      </ScrollView>
      {!!notice && (
        <View pointerEvents="none" style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, padding: spacing.sm, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  cardOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  workspacePick: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 64, padding: spacing.sm, borderRadius: radius.md },
  openButton: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  tile: { alignItems: 'center', justifyContent: 'center' },
  tileText: { fontWeight: '800' },
  name: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.caption, color: colors.muted },
  stats: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1, flexDirection: 'row', gap: 6, minHeight: 48, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  actionNew: { borderStyle: 'dashed', borderWidth: 1.5, borderColor: colors.mint, backgroundColor: 'transparent' },
  actionNewText: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  actionText: { fontSize: font.body, fontWeight: '800', color: colors.ink },
  hint: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  badge: { paddingHorizontal: spacing.md, minHeight: 28, borderRadius: 14, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: font.caption, fontWeight: '800', color: colors.white },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.ink, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body },
});
