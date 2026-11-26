// ============================================================
// Recorder.js — 소리 녹음 (expo-audio)
// ============================================================

import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { RECORDING_AUDIO } from '../../lib/stella/recordings';

// 음성용 녹음 설정: 모노 22kHz 64kbps AAC(m4a). 음악용 HIGH_QUALITY(스테레오 128kbps)의 1/4 크기라
//   분당 약 0.48MB → 서버 한도 25MB 안에 약 52분이 들어감 (받아쓰기 모델은 어차피 16kHz 모노로 처리)
//   2분 구간 나누기(stella-audio-split)도 이 AAC m4a를 다시 인코딩 없이 자름
export const SPEECH_RECORDING = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: RECORDING_AUDIO.sampleRate,
  numberOfChannels: RECORDING_AUDIO.numberOfChannels,
  bitRate: RECORDING_AUDIO.bitRate,
  ios: { ...RecordingPresets.HIGH_QUALITY.ios, audioQuality: 64 },
  web: { ...RecordingPresets.HIGH_QUALITY.web, bitsPerSecond: RECORDING_AUDIO.bitRate },
};

export function useRecorder() {
  const recorder = useAudioRecorder(SPEECH_RECORDING);

  const start = async () => {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return { ok: false, reason: 'denied' };
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
  };

  const stop = async () => {
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }); // 무음 모드에서도 '듣기'는 들리게
      return recorder.uri || null;
    } catch (e) {
      return null;
    }
  };

  return { start, stop };
}
