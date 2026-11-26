// 키보드 높이 (내려가 있으면 0). 화면 전체를 쓰는(edge-to-edge) 안드로이드에서는 키보드가 떠도 창이 줄지 않아
// 아래 입력줄을 이 높이만큼 직접 올려야 한다.
import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

export function useKeyboardHeight() {
  // 이미 떠 있는 키보드 위에 새로 열린 화면·시트도 바로 올라가게 지금 높이로 시작
  const [height, setHeight] = useState(() => (Keyboard.isVisible?.() ? Keyboard.metrics?.()?.height ?? 0 : 0));
  useEffect(() => {
    const up = Keyboard.addListener('keyboardDidShow', e => setHeight(e.endCoordinates?.height ?? 0));
    const down = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => { up.remove(); down.remove(); };
  }, []);
  return height;
}
