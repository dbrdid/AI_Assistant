// AI 채팅 머리글 아이콘 (react-native-svg로 그려서 기기·웹에서 모양이 같음)
import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from '../../../shared/theme/theme';

// 뒤로 가기: 왼쪽 꺾쇠
export function BackIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15 5l-7 7 7 7" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// 메뉴 열기: 같은 길이 줄 세 개 (사이드 메뉴로 연 화면의 왼쪽 위)
export function MenuIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 6.5h16M4 12h16M4 17.5h16" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}

// 이전 대화: 긴 줄 위, 짧은 줄 아래
export function HistoryIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 9h16M4 15h10" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}

// 새 채팅: 둥근 사각형 위 연필
export function NewChatIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M11 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M18.4 3.6a2 2 0 0 1 2.8 2.8L13 14.6l-3.6.8.8-3.6 8.2-8.2z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

// 이전 대화: 말풍선
export function MessageIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.2c-.5.4-1.3 0-1.3-.6V17A2.5 2.5 0 0 1 4 14.5v-8z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Path d="M8.5 10.5h7" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

// 제목 수정: 연필
export function EditIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L15.5 4.5z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Path d="M13.5 6.5l3 3" stroke={color} strokeWidth={2} />
    </Svg>
  );
}

// 고정: 압정
export function PinIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M14.5 3.5l6 6-2.6 1-3.3 3.3.4 4.2-1.5 1.5-4.6-4.6-4.6-4.6L5.8 8.8l4.2.4 3.3-3.3 1.2-2.4z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Path d="M8.4 15.6L3.5 20.5" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

// 업로드된 파일: 클립
export function ClipIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M16.5 7.5v8a4.5 4.5 0 0 1-9 0V6.5a3 3 0 0 1 6 0V15a1.5 1.5 0 0 1-3 0V7.5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// 삭제: 휴지통
export function TrashIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 6.5h16M9.5 6.5V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8v1.7M6 6.5l.9 12.2A2 2 0 0 0 8.9 20.5h6.2a2 2 0 0 0 2-1.8L18 6.5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M10 10.5v6M14 10.5v6" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

// 더보기: 가로 점 세 개
export function MoreIcon({ size = 24, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Circle cx={5} cy={12} r={2} />
      <Circle cx={12} cy={12} r={2} />
      <Circle cx={19} cy={12} r={2} />
    </Svg>
  );
}
