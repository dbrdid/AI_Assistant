// ============================================================
// CalendarScreen.js — 캘린더 화면 (= 홈의 캘린더 시트를 "끝까지 올린 모양" 그대로)
// ============================================================
// 이 화면은 새로 그린 화면이 아니라, 홈에서 끌어올리는 캘린더 시트(CalendarSheet.js)를
// "처음부터 끝까지 올라온 상태(startFull)"로 보여주는 것뿐입니다. 그래서 홈에서 시트를 끝까지 올렸을 때 보이는 화면과 완전히 같습니다.
//
// 이 화면으로 오는 길
//   1) 홈에서 시트를 끝까지 올린다
//   2) 사이드 메뉴에서 "캘린더" 를 누른다
// 이 화면에서 나가는 길
//   - 손잡이/바깥을 누르거나 아래로 밀어 닫는다, 안드로이드 뒤로가기  → 이전 화면으로
//   - 왼쪽 → 오른쪽으로 밀면 사이드 메뉴 열기 (다른 화면과 동일)
//
// props (AppNavigator 가 넣어줌)
//   navigation : 화면 이동 도구 { navigate, goBack }
//   calendar   : 달력 상태 묶음 (홈 시트와 같은 것을 공유 → 보던 달/날짜가 그대로 이어짐)

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
