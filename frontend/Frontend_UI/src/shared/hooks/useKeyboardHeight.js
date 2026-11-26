// 키보드 높이 (내려가 있으면 0). 화면 전체를 쓰는(edge-to-edge) 안드로이드에서는 키보드가 떠도 창이 줄지 않아
// 아래 입력줄을 이 높이만큼 직접 올려야 한다.
import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

export function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const up = Keyboard.addListener('keyboardDidShow', e => setHeight(e.endCoordinates?.height ?? 0));
    const down = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => { up.remove(); down.remove(); };
  }, []);
  return height;
}
