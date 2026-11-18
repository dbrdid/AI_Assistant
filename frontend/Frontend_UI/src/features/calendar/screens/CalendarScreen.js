// ============================================================
// CalendarScreen.js — 캘린더 화면 (하단 탭 '캘린더')
// ============================================================

import React from 'react';
import { StyleSheet, View } from 'react-native';
import CalendarSheet from '../components/CalendarSheet';
import { useLeadAction } from '../../../navigation/ScreenEntry';
import { CircleButton } from '../../../shared/components/Ui';
import { colors } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { enterSpace } from '../../../data/workspaces/WorkspaceStore';

export default function CalendarScreen({ navigation, calendar }) {
  // 왼쪽 위: 탭으로 열었으면 버튼 없음, 다른 화면에서 왔으면 ‹
  const lead = useLeadAction(navigation.goBack);

  return (
    // 화면 전체. 시트가 이 안을 꽉 채우며 올라와 있는 상태로 보입니다.
    <View style={styles.root}>
      <CalendarSheet
        calendar={calendar}
        startFull // 처음부터 끝까지 올라온 상태
        onAddTask={(date) => navigation.navigate(ROUTES.TaskEdit, { date, kind: 'event' })}
        onEditTask={(t) => {
          enterSpace(t.workspaceId); // 그 항목의 공간에서 편집 (프로젝트 등이 그 공간 것)
          navigation.navigate(ROUTES.TaskEdit, { taskId: t.id });
        }}
        // 아래로 밀어 닫기: 다른 화면에서 들어왔을 때만 (탭 화면은 닫을 곳이 없음)
        onClose={lead.hidden ? undefined : navigation.goBack}
        lead={lead.hidden ? null : <CircleButton icon="chevronLeft" label="뒤로 가기" onPress={lead.onPress} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
});
