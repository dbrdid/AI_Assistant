import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createAudioPlayer } from 'expo-audio';
import Svg, { Path, Rect } from 'react-native-svg';
import { withRecordingUri } from '../../../data/files/FileStore';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { createRecordingPlayback, formatRecordingTime } from './recordingPlayback.mjs';

export default function RecordingPlayer({ fileId, uri, seconds, name = '녹음', autoPlay = false }) {
  const [status, setStatus] = useState({ state: 'idle' });
  const playback = useMemo(() => createRecordingPlayback(
    callback => withRecordingUri(fileId, uri, callback),
    source => createAudioPlayer({ uri: source }, { updateInterval: 250 }),
    setStatus,
  ), [fileId, uri]);
  useEffect(() => {
    setStatus({ state: 'idle' });
    if (autoPlay) void playback.toggle();
    return () => playback.stop();
  }, [playback, autoPlay]);

  const playing = status.state === 'playing';
  const label = { playing: '일시정지', paused: '이어서 듣기', finished: '다시 듣기', loading: '불러오는 중…', error: '다시 시도' }[status.state] || '듣기';
  const duration = status.duration > 0 ? status.duration : seconds;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={`${name} ${label}`}
        disabled={status.state === 'loading'} onPress={playback.toggle} style={styles.button}>
        <Svg width={18} height={18} viewBox="0 0 24 24" fill={colors.ink}>
          {playing ? <><Rect x="6" y="4" width="4" height="16" rx="1" /><Rect x="14" y="4" width="4" height="16" rx="1" /></>
            : <Path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />}
        </Svg>
        <Text style={styles.label}>{label}</Text>
        {duration > 0 && <Text style={styles.time}>{formatRecordingTime(status.position || 0)} / {formatRecordingTime(duration)}</Text>}
      </Pressable>
      {duration > 0 && duration < 0.1 && <Text style={styles.time}>목소리를 듣기에는 너무 짧은 녹음이에요.</Text>}
      {status.state === 'error' && <Text accessibilityLiveRegion="polite" style={styles.error}>녹음을 재생하지 못했어요. {status.message}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 44, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  label: { color: colors.ink, fontSize: font.body, fontWeight: '500' },
  time: { color: colors.muted, fontSize: font.caption, fontVariant: ['tabular-nums'] },
  error: { color: colors.coral, fontSize: font.caption },
});
