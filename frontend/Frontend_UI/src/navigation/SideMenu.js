// ============================================================
// SideMenu.js — 왼쪽에서 밀려 나오는 "사이드 메뉴 패널"
// ============================================================
// 하는 일
//   1) MenuContext 의 visible 이 true 가 되면 왼쪽에서 슬라이드해서 나타남
//   2) routes.js 의 MENU_ITEMS 를 목록으로 보여줌
//   3) 항목을 누르면 메뉴를 닫고 그 화면으로 이동
//   4) 지금 보고 있는 화면의 항목은 연한 민트색으로 강조
//
// props
//   onNavigate(route) : 화면 이동을 요청하는 함수 (AppNavigator 에서 전달)
//   currentRoute  : 지금 보고 있는 화면 이름 (강조 표시용)

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../shared/hooks/useInsets';
import { colors, font, radius, spacing, FILL } from '../shared/theme/theme';
import { useMenu } from './MenuContext';
import { MENU_ITEMS } from './routes';
import { useWorkspaces } from '../data/workspaces/WorkspaceStore';

// 패널 폭: 화면 폭의 80%, 단 최대 320
const WIDTH = Math.min(Dimensions.get('window').width * 0.8, 320);

export default function SideMenu({ onNavigate, currentRoute }) {
  const { visible, close } = useMenu(); // 열림 여부 / 닫기 함수
  const insets = useSafeAreaInsets();
  const { current } = useWorkspaces(); // 지금 보고 있는 공간 (메뉴 위에 항상 표시)

  // x: 패널의 가로 위치. -WIDTH 면 화면 왼쪽 밖(숨김), 0 이면 화면 안(보임)
  const x = useRef(new Animated.Value(-WIDTH)).current;
  // mounted: 패널을 화면에 "존재시킬지" 여부.
  //   닫힐 때 슬라이드 애니메이션이 끝날 때까지는 존재해야 해서 visible 과 따로 관리합니다.
  const [mounted, setMounted] = useState(false);

  // visible 이 바뀔 때마다 열기/닫기 애니메이션 실행
  useEffect(() => {
    if (visible) {
      setMounted(true); // 먼저 화면에 올리고
      Animated.timing(x, { toValue: 0, duration: 220, useNativeDriver: true }).start(); // 왼쪽에서 들어오기
    } else if (mounted) {
      // 왼쪽 밖으로 나간 뒤(애니메이션 종료 콜백) 화면에서 제거
      Animated.timing(x, { toValue: -WIDTH, duration: 180, useNativeDriver: true }).start(() => setMounted(false));
    }
  }, [visible, mounted, x]);

  // 열려 있지도, 닫히는 중도 아니면 아무것도 그리지 않음
  if (!mounted) return null;

  // 메뉴 항목을 눌렀을 때 실행
  const go = (route) => {
    close(); // 메뉴 닫기
    if (route === currentRoute) return; // 이미 그 화면이면 이동하지 않음
    onNavigate(route); // 해당 화면으로 이동 (실제 이동은 AppNavigator 가 처리)
  };

  return (
    // Modal: 모든 화면 위에 겹쳐서 띄우는 도구. 배경은 투명(transparent)
    <Modal transparent visible animationType="none" onRequestClose={close}>
      <View style={styles.root}>
        {/* 어두운 배경: 눌러서 메뉴 닫기 */}
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="메뉴 닫기" />

        {/* 메뉴 패널 본체. translateX: x 만큼 가로로 이동시켜 그림 */}
        <Animated.View
          accessibilityViewIsModal
          style={[styles.panel, { width: WIDTH, paddingTop: insets.top + spacing.lg, transform: [{ translateX: x }] }]}
        >
          <Text style={styles.heading}>메뉴</Text>
          <Text style={styles.space} numberOfLines={1}>현재 공간 · {current.name}</Text>

          {/* 항목이 많아도 스크롤로 볼 수 있게 ScrollView */}
          <ScrollView style={{ marginTop: spacing.lg }} contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}>
            {/* MENU_ITEMS 배열을 하나씩 꺼내서 버튼으로 만듦 */}
            {MENU_ITEMS.map((item) => {
              const active = item.route === currentRoute; // 지금 보는 화면인가?
              return (
                <Pressable
                  key={item.route} // 목록의 각 항목을 구분하는 고유 이름 (React 필수 규칙)
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => go(item.route)}
                  // pressed: 누르고 있는 동안 true → 눌렀을 때도 배경색 변경
                  style={({ pressed }) => [styles.item, (active || pressed) && { backgroundColor: colors.mintSoft }]}
                >
                  <Text style={[styles.itemText, active && { color: colors.mintDark, fontWeight: '800' }]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  // absoluteFillObject: 부모 전체를 덮는 위치/크기. 반투명 어두운색
  backdrop: { ...FILL, backgroundColor: 'rgba(38,57,53,0.4)' },
  space: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark, marginTop: 4 },
  panel: { backgroundColor: colors.cream, paddingHorizontal: spacing.lg, height: '100%' },
  heading: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  item: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.md },
  itemText: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
});
