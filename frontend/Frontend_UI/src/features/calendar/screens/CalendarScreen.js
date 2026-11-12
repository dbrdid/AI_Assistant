// ============================================================
// CalendarScreen.js — 캘린더 화면
// ============================================================

import React from 'react';
import { StyleSheet, View } from 'react-native';
import CalendarSheet from '../components/CalendarSheet';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { colors } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';

export default function CalendarScreen({ navigation, calendar }) {
  // "오른쪽으로 밀면 메뉴" 제스처
  const menuSwipe = useSwipeToOpenMenu();

  return (
    // 화면 전체. 시트가 이 안을 꽉 채우며 올라와 있는 상태로 보입니다.
    <View style={styles.root} {...menuSwipe}>
      <CalendarSheet
        calendar={calendar}
        startFull // 처음부터 끝까지 올라온 상태
        onAddTask={(date) => navigation.navigate(ROUTES.TaskEdit, { date })}
        onEditTask={(taskId) => navigation.navigate(ROUTES.TaskEdit, { taskId })}
        onClose={navigation.goBack} // 아래로 밀어 닫으면 이전 화면으로
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
});
