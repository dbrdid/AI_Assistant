// AI 채팅 아이콘 (react-native-svg로 그려서 기기·웹에서 모양이 같음). 지금은 고정(압정)만 쓴다
import Svg, { Path } from 'react-native-svg';
import { colors } from '../../../shared/theme/theme';

// 고정: 압정
export function PinIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M14.5 3.5l6 6-2.6 1-3.3 3.3.4 4.2-1.5 1.5-4.6-4.6-4.6-4.6L5.8 8.8l4.2.4 3.3-3.3 1.2-2.4z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Path d="M8.4 15.6L3.5 20.5" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}
