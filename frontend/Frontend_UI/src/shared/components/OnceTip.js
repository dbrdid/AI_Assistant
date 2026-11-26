// 한 번만 보이는 사용법 안내 (Notion 페이지 안 콜아웃처럼 조용한 한 줄 상자).
// "확인"을 누르면 이 기기에서 다시 보이지 않는다. 같은 화면에 안내가 여러 개면 순서대로 하나씩.
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from './Icon';
import { readPreference, writePreference } from '../../integration/runtime';
import { colors, font } from '../theme/theme';

const KEY = 'tips.seen';
const seen = () => { try { return readPreference(KEY, []); } catch { return []; } };

/** tips: [{ id, text }] — 아직 안 본 첫 안내만 보여 준다 */
export default function OnceTip({ tips, style }) {
  const [, rerender] = useState(0);
  const done = seen();
  const tip = tips.find((t) => !done.includes(t.id));
  if (!tip) return null;
  const dismiss = () => {
    try { writePreference(KEY, [...seen(), tip.id]); } catch { /* 저장 못 해도 이번엔 닫음 */ }
    rerender((n) => n + 1);
  };
  return (
    <View style={[styles.box, style]} accessibilityRole="summary">
      <Icon name="sparkles" size={16} color={colors.muted} />
      <Text style={styles.text}>{tip.text}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="안내 확인, 다시 보지 않기" onPress={dismiss} hitSlop={8} style={styles.ok}>
        <Text style={styles.okText}>확인</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.card },
  text: { flex: 1, fontSize: font.body, lineHeight: 20, color: colors.ink },
  ok: { minHeight: 24, justifyContent: 'center' },
  okText: { fontSize: font.body, fontWeight: '600', color: colors.muted },
});
