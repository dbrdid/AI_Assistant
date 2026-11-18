// ============================================================
// SpaceTag.js — 어느 공간의 항목인지 보여 주는 작은 꼬리표 (색 점 + 공간 이름)
// ============================================================
//   <SpaceTag space={spaces[item.workspaceId]} />   space: useSpaceInfo() 의 한 항목. 없으면 아무것도 안 그림

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font } from '../theme/theme';

export function SpaceDot({ color, size = 8, style }) {
  return <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />;
}

export default function SpaceTag({ space, style }) {
  if (!space) return null;
  return (
    <View style={[styles.tag, style]} accessibilityLabel={space.personal ? '개인 공간' : `${space.fullName} 공간`}>
      <SpaceDot color={space.color} size={7} />
      <Text style={styles.text} numberOfLines={1}>{space.name}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 120, flexShrink: 1 },
  text: { flexShrink: 1, fontSize: font.caption, fontWeight: '700', color: colors.muted },
});
