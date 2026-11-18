import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ScreenHeader from './ScreenHeader';
import { colors, font } from '../theme/theme';
import { IconTile } from './Ui';
import { ROUTE_LABELS } from '../../navigation/routes';

export default function PlaceholderScreen({ navigation, route }) {
  // 화면 이름(route.name)으로 탭·더보기 목록에서 한글 제목을 얻습니다. 못 찾으면 영문 이름 그대로
  const title = ROUTE_LABELS[route.name] || route.name;

  return (
    <View style={styles.root}>
      <ScreenHeader title={title} onBack={navigation.goBack} />
      <View style={styles.body}>
        <IconTile icon="clock" size={56} iconSize={28} />
        <Text style={styles.text}>{title}</Text>
        <Text style={styles.sub}>준비 중인 화면입니다</Text>
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
