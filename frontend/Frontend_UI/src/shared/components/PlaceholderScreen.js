// ============================================================
// PlaceholderScreen.js — 아직 만들지 않은 화면들의 "임시 화면"
// ============================================================
// 메뉴/빠른 실행 화면은 아직 내용이 없습니다.
// 화면마다 파일을 따로 만들지 않고, 이 파일 하나를 재사용하면서 제목만 바꿔 보여줍니다.
// 나중에 어떤 화면을 진짜로 만들면 AppNavigator.js 에서 그 화면만 새 파일로 바꿔 끼우면 됩니다.
//
// 이 화면에서도 "왼쪽 → 오른쪽으로 밀기" 로 사이드 메뉴를 열 수 있습니다.
// (밀기 제스처는 useSwipeToOpenMenu.js 를 홈 화면과 같이 사용합니다)
//
// props (AppNavigator 가 넣어줌)
//   navigation : 화면 이동 도구 (뒤로가기에 사용)
//   route      : 지금 화면의 정보. route.name 은 이 화면의 이름(예: 'Memos')

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ScreenHeader from './ScreenHeader';
import useSwipeToOpenMenu from '../../navigation/useSwipeToOpenMenu';
import { colors, font } from '../theme/theme';
import { MENU_ITEMS, QUICK_ACTIONS } from '../../navigation/routes';

export default function PlaceholderScreen({ navigation, route }) {
  // "오른쪽으로 밀면 메뉴" 제스처
  const menuSwipe = useSwipeToOpenMenu();

  // 화면 이름(route.name)으로 "메뉴 항목 + 빠른 실행 항목" 목록에서 같은 항목을 찾아 한글 제목을 얻습니다.
  const item = [...MENU_ITEMS, ...QUICK_ACTIONS].find((m) => m.route === route.name);
  const title = item ? item.label : route.name; // 못 찾으면 영문 이름 그대로

  return (
    // 화면 전체를 감싸는 View 에 밀기 제스처를 연결 ({...menuSwipe})
    <View style={styles.root} {...menuSwipe}>
      {/* onBack 을 넘겼으므로 왼쪽에 ‹ 가 나오고, 누르면 이전 화면으로 돌아감 */}
      <ScreenHeader title={title} onBack={navigation.goBack} />
      <View style={styles.body}>
        <Text style={styles.text}>{title}</Text>
        <Text style={styles.sub}>준비 중인 화면입니다 · 오른쪽으로 밀면 메뉴</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  text: { fontSize: font.headline, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.body, color: colors.muted },
});
