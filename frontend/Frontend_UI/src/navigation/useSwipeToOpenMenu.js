// ============================================================
// useSwipeToOpenMenu.js — "왼쪽 → 오른쪽으로 밀면 사이드 메뉴 열기" 를 모아 둔 공용 도구
// ============================================================
// 원래는 HomeScreen 안에 직접 들어 있던 코드입니다. 모든 화면에서 똑같이 쓰려고
// 따로 빼서 "훅(use 로 시작하는 재사용 도구)"으로 만들었습니다.
//
// 사용법 (화면 파일에서):
//   const menuSwipe = useSwipeToOpenMenu();
//   <View style={{ flex: 1 }} {...menuSwipe}>  ...화면 내용...  </View>
//
//   → 중괄호 안의 {...menuSwipe} 는 "이 View 에서 손가락 움직임을 감지해라" 라는 연결 부분입니다.
//   → 새 화면을 만들 때도 이 두 줄만 붙이면 같은 제스처가 적용됩니다.

import { useMemo } from 'react';
import { PanResponder } from 'react-native';
import { useMenu } from './MenuContext';

export default function useSwipeToOpenMenu() {
  const { open } = useMenu(); // 메뉴 열기 함수

  // PanResponder: 손가락이 "눌리고, 움직이고, 떼어지는" 과정을 감지하는 도구.
  // useMemo 로 한 번만 만들어 두고, open 이 바뀔 때만 다시 만듭니다.
  return useMemo(
    () =>
      PanResponder.create({
        // 손가락이 움직일 때, 이 제스처를 이 화면이 가져갈지 결정.
        //   g.dx : 가로로 움직인 거리 (오른쪽으로 가면 양수)
        //   g.dy : 세로로 움직인 거리
        // 조건: 오른쪽으로 12px 넘게 움직였고, 세로보다 가로로 1.5배 이상 더 움직였을 때만.
        // → 위아래로 스크롤하거나 버튼을 "탭"하는 동작과는 충돌하지 않습니다.
        onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,

        // 손가락을 뗐을 때: 50px 이상 밀었거나(g.dx), 빠르게 휙 밀었으면(g.vx) 메뉴 열기
        onPanResponderRelease: (_, g) => {
          if (g.dx > 50 || g.vx > 0.5) open();
        },
      }).panHandlers, // 화면 View 에 펼쳐서({...}) 연결할 수 있는 이벤트 모음
    [open],
  );
}