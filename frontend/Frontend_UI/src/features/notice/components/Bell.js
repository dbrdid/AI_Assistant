// 홈 위쪽 오른쪽의 알림(종) 버튼 — 이모지 대신 선으로 그린 아이콘 (안 읽은 알림 개수를 빨간 점으로 표시)
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../../../shared/theme/theme';
import { useNotices } from '../../../data/notices/NoticeStore';

export default function Bell({ onPress }) {
  const unread = useNotices().filter((n) => !n.read).length;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={unread ? `알림 ${unread}개 안 읽음` : '알림'} onPress={onPress} hitSlop={10}>
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <Path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </Svg>
      {unread > 0 && (
        <View style={styles.badge}><Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text></View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: -4, right: -6, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.coral, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeText: { fontSize: 10, fontWeight: '800', color: colors.white },
});
