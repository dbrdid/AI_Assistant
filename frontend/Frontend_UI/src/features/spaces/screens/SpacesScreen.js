// ============================================================
// SpacesScreen.js — 하단 탭 '공간': 개인 공간 + 팀 공간 목록 (노션의 워크스페이스 목록처럼)
// ============================================================
// 공간을 누르면 그 공간의 홈(SpaceHomeScreen)으로 갑니다. 오늘·캘린더·할 일·메모 탭은 모든 공간을 합쳐 보여 주므로
// 여기서 "전환"하지 않아도 됩니다.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import Icon from '../../../shared/components/Icon';
import { CircleButton } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { useSpaceInfo, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
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
  const { list } = useWorkspaces();
  const spaces = useSpaceInfo();
  const tasks = useAllTasks();
  const memos = useAllMemos();
  const today = toKey(new Date());

  const statsOf = (id) => {
    const mine = tasks.filter((t) => t.workspaceId === id);
    const left = mine.filter((t) => t.status !== '완료').length;
    const todayN = mine.filter((t) => t.status !== '완료' && occursOn(t, today)).length;
    const memoN = memos.filter((m) => m.workspaceId === id).length;
    return [`메모 ${memoN}`, `남은 할 일 ${left}`, todayN ? `오늘 ${todayN}` : ''].filter(Boolean).join(' · ');
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="공간" onBack={navigation.goBack} right={<CircleButton icon="plus" label="새 공간 만들기" onPress={() => navigation.navigate(ROUTES.WorkspaceCreate)} />} />
      <ScrollView contentContainerStyle={styles.content}>
        {list.map((w) => {
          const space = spaces[w.id];
          return (
            <Pressable
              key={w.id}
              accessibilityRole="button"
              accessibilityLabel={`${w.name} 공간 열기`}
              onPress={() => navigation.navigate(ROUTES.SpaceHome, { workspaceId: w.id })}
              style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.mintSoft }]}
            >
              <SpaceTile space={space} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.name} numberOfLines={1}>{w.name}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {w.personal ? '나만 보는 메모 · 일정 · 이 기기에만 저장' : `${w.role} · 멤버 ${w.members}명${w.serverId ? '' : ' · 서버 연결 전'}`}
                </Text>
                <Text style={styles.stats} numberOfLines={1}>{statsOf(w.id)}</Text>
              </View>
              <Icon name="chevronRight" size={18} color={colors.muted} />
            </Pressable>
          );
        })}

        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.WorkspaceCreate)} style={({ pressed }) => [styles.action, styles.actionNew, pressed && { opacity: 0.7 }]}>
            <Icon name="plus" size={16} color={colors.mintDark} strokeWidth={2.4} />
            <Text style={styles.actionNewText}>새 공간 만들기</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.WorkspaceInvite)} style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}>
            <Icon name="userPlus" size={16} color={colors.ink} />
            <Text style={styles.actionText}>초대 코드로 참여</Text>
          </Pressable>
        </View>

        <Text style={styles.hint}>
          개인 공간은 나만 봐요. 팀 공간의 메모·일정·프로젝트는 멤버 모두가 함께 보고 고쳐요. 오늘·캘린더·할 일·메모 탭에는 모든 공간이 색으로 구분되어 함께 보여요. 공간 삭제·나가기는 각 공간 홈 맨 아래에 있어요.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
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
});
