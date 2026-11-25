// ============================================================
// SpacesScreen.js — 하단 탭 '공간': 개인 공간 + 팀 공간 목록 (노션의 워크스페이스 목록처럼)
// ============================================================
// 공간을 누르면 그 공간의 홈(SpaceHomeScreen)으로 갑니다. 오늘·캘린더·할 일·메모 탭은 모든 공간을 합쳐 보여 주므로
// 여기서 "전환"하지 않아도 됩니다.

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { useSpaceInfo, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { occursOn, useAllTasks } from '../../../data/tasks/TaskStore';
import { useAllMemos } from '../../../data/memos/MemoStore';
import { toKey } from '../../calendar/utils/DateUtils';

// Notion 워크스페이스 아이콘처럼 무채색 작은 사각형 + 첫 글자 (색 배경 타일 대신)
export function SpaceTile({ space, size = 28 }) {
  return (
    <View style={[styles.tile, { width: size, height: size }]}>
      {space.personal ? (
        <Icon name="lock" size={Math.round(size * 0.5)} color={colors.ink} />
      ) : (
        <Text style={[styles.tileText, { fontSize: Math.round(size * 0.5) }]}>{space.fullName.trim().charAt(0) || '?'}</Text>
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
    // 디자인 지시: 화면에 건수 장식을 상시 노출하지 않는다. 오늘 할 일이 있을 때만 알려 준다.
    return todayN ? '오늘 할 일이 있어요' : '';
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="공간" onBack={navigation.goBack} />
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
        {list.map((w) => {
          const space = spaces[w.id];
          return (
            <Pressable
              key={w.id}
              accessibilityRole="button"
              accessibilityLabel={`${w.name} 공간 열기`}
              onPress={() => navigation.navigate(ROUTES.SpaceHome, { workspaceId: w.id })}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <SpaceTile space={space} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.name} numberOfLines={1}>{w.name}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {w.personal ? '이 기기에만 저장돼요' : `${w.role}, 멤버 ${w.members}명${w.serverId ? '' : ', 서버 연결 전'}`}
                </Text>
                {!!statsOf(w.id) && <Text style={styles.stats} numberOfLines={1}>{statsOf(w.id)}</Text>}
              </View>
              <Icon name="chevronRight" size={16} color={colors.muted} />
            </Pressable>
          );
        })}

        <View style={styles.divider} />
        {[['plus', '새 공간 만들기', ROUTES.WorkspaceCreate], ['userPlus', '초대 코드로 참여', ROUTES.WorkspaceInvite]].map(([icon, label, route]) => (
          <Pressable key={label} accessibilityRole="button" onPress={() => navigation.navigate(route)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <View style={styles.rowIcon}><Icon name={icon} size={16} color={colors.muted} /></View>
            <Text style={styles.actionText}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xxl },
  // 카드 대신 Notion 목록 행: 테두리 없음, 누를 때만 옅은 배경
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56, paddingHorizontal: spacing.sm, marginHorizontal: -spacing.sm, borderRadius: radius.sm },
  rowPressed: { backgroundColor: colors.mintSoft },
  rowIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  tile: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: colors.raised },
  tileText: { fontWeight: '500', color: colors.ink },
  name: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  sub: { fontSize: font.caption, color: colors.muted },
  stats: { fontSize: font.caption, color: colors.muted },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: spacing.sm },
  actionText: { fontSize: font.body, color: colors.ink },
});
