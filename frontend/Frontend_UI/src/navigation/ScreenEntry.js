// ============================================================
// ScreenEntry.js — 지금 화면을 "어떻게 들어왔는지"를 머리글에 알려 주는 도구
// ============================================================
// 규칙: 하단 탭으로 연 화면(탭 첫 화면)은 왼쪽 위 버튼이 없고,
//       다른 화면 안에서 들어온 화면은 ‹(이전 화면으로).
//   같은 메모 화면이라도 탭으로 왔으면 버튼 없음, 검색 결과에서 왔으면 ‹ 가 됩니다.

import { createContext, useContext } from 'react';

// tabRoot: 하단 탭으로 연 화면인지 · goBack: 내비게이터의 뒤로 가기 (화면이 넘긴 onBack 과 비교용)
const ScreenEntry = createContext({ tabRoot: false, goBack: null });
export const ScreenEntryProvider = ScreenEntry.Provider;
export const useScreenEntry = () => useContext(ScreenEntry);

/**
 * 머리글 왼쪽 버튼이 할 일.
 *   onBack 이 없으면 버튼 없음.
 *   onBack 이 내비게이터의 뒤로 가기이고 탭 첫 화면이면 버튼 없음.
 *   그 밖의 onBack(예: 선택 모드 끝내기)은 그대로 ‹.
 */
export function useLeadAction(onBack) {
  const { tabRoot, goBack } = useContext(ScreenEntry);
  const hidden = !onBack || (tabRoot && onBack === goBack);
  return { hidden, onPress: hidden ? null : onBack };
}
