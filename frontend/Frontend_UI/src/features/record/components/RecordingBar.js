// 녹음 중 입력줄 (Notion AI 회의록의 녹음 줄처럼): 실제 소리 크기를 따라 움직이는 막대 · 경과 시간 · 일시정지 · 끝내기
// 녹음 중에만 그려지므로 소리 크기 확인(useAudioRecorderState)도 그동안만 돈다.
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioRecorderState } from 'expo-audio';
import Icon from '../../../shared/components/Icon';
import { colors, font } from '../../../shared/theme/theme';

const BARS = 18;
const formatTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
// dB(-60 ~ 0) → 막대 높이 3 ~ 22
const heightOf = (db) => 3 + 19 * Math.min(1, Math.max(0, ((db ?? -60) + 60) / 60));

export default function RecordingBar({ recorder, seconds, paused, onPause, onResume, onStop }) {
  const state = useAudioRecorderState(recorder, 100);
  const [levels, setLevels] = useState(() => Array(BARS).fill(-60));
  useEffect(() => {
    setLevels((l) => [...l.slice(1), paused ? -60 : state.metering ?? -60]);
  }, [state.metering, state.durationMillis, paused]);

  return (
    <View style={styles.row}>
      <View style={styles.wave} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {levels.map((db, i) => <View key={i} style={[styles.bar, { height: heightOf(db) }]} />)}
      </View>
      <Text style={styles.time} accessibilityLiveRegion="polite" accessibilityLabel={`${paused ? '일시정지됨' : '녹음 중'} ${formatTime(seconds)}`}>
        {paused ? '일시정지 ' : ''}{formatTime(seconds)}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={paused ? '녹음 이어서 하기' : '녹음 일시정지'} onPress={paused ? onResume : onPause} hitSlop={6} style={[styles.btn, styles.pause]}>
        {paused ? <Icon name="mic" size={18} color={colors.ink} />
          : <View style={{ flexDirection: 'row', gap: 4 }}><View style={styles.pauseBar} /><View style={styles.pauseBar} /></View>}
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="녹음 끝내기" onPress={onStop} hitSlop={6} style={[styles.btn, styles.stop]}>
        <View style={styles.stopSquare} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  wave: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3, height: 24 },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.muted },
  time: { fontSize: font.bodyLg, fontVariant: ['tabular-nums'], color: colors.ink },
  btn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  pause: { backgroundColor: colors.card },
  stop: { backgroundColor: 'rgba(235,87,87,0.22)' },
  pauseBar: { width: 4, height: 15, borderRadius: 1.5, backgroundColor: colors.ink },
  stopSquare: { width: 16, height: 16, borderRadius: 3, backgroundColor: colors.coral },
});
