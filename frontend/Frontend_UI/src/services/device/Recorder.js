// ============================================================
// Recorder.js — 소리 녹음 (expo-audio)
// ============================================================

import { Platform } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { loadAudioSplit } from '../../integration/runtime';
import { RECORDING_AUDIO } from '../../lib/stella/recordings';

// 음성용 녹음 설정: 모노 22kHz 64kbps AAC(m4a). 음악용 HIGH_QUALITY(스테레오 128kbps)의 1/4 크기라
//   분당 약 0.48MB → 서버 한도 25MB 안에 약 52분이 들어감 (받아쓰기 모델은 어차피 16kHz 모노로 처리)
//   2분 구간 나누기(stella-audio-split)도 이 AAC m4a를 다시 인코딩 없이 자름
export const SPEECH_RECORDING = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: Platform.OS === 'android',
  sampleRate: RECORDING_AUDIO.sampleRate,
  numberOfChannels: RECORDING_AUDIO.numberOfChannels,
  bitRate: RECORDING_AUDIO.bitRate,
  ios: { ...RecordingPresets.HIGH_QUALITY.ios, audioQuality: 64 },
  web: { ...RecordingPresets.HIGH_QUALITY.web, bitsPerSecond: RECORDING_AUDIO.bitRate },
};

// Loading the native module lazily keeps web and iOS recording independent of the Android decoder.
export const inspectFinishedAudio = Platform.OS === 'android'
  ? uri => loadAudioSplit().inspectRecording(uri)
  : null;

let owner = null; // AV mode is shared by overlapping screen instances.

export function useRecorder() {
  const recorder = useAudioRecorder(SPEECH_RECORDING);

  const start = async (stillVisible) => {
    if (owner) return { ok: false, reason: 'error', message: '앞선 녹음이 끝난 뒤 다시 눌러 주세요.' };
    const take = { recorder, uri: null };
    owner = take;
    let modeChanged = false;
    let prepared = false;
    let started = false;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!stillVisible()) return { ok: false, reason: 'cancelled' };
      if (!perm.granted) return { ok: false, reason: 'denied', canAskAgain: perm.canAskAgain };
      if (Platform.OS === 'android' && !loadAudioSplit()?.canInspectRecording?.()) {
        return { ok: false, reason: 'error', message: '녹음 파일을 확인하려면 Android 앱을 최신 빌드로 업데이트해 주세요.' };
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      modeChanged = true;
      if (!stillVisible()) return { ok: false, reason: 'cancelled' };
      await recorder.prepareToRecordAsync();
      prepared = true;
      take.uri = recorder.uri;
      if (!stillVisible()) return { ok: false, reason: 'cancelled' };
      recorder.record();
      started = true;
      return { ok: true };
    } catch {
      return { ok: false, reason: 'error' };
    } finally {
      if (!started) {
        try { if (prepared) await recorder.stop(); } catch { /* Native handle may already be released. */ }
        if (modeChanged) await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        owner = null;
      }
    }
  };

  const stop = async () => {
    const take = owner;
    if (take?.recorder !== recorder) return null;
    let status;
    try { status = recorder.getStatus(); } catch { /* Stop can still finalize an interrupted capture. */ }
    try {
      await recorder.stop();
      return { uri: recorder.uri || take.uri || status?.url, seconds: (status?.durationMillis || 0) / 1000 };
    } catch {
      // Android may already have finalized this take. Its post-prepare URL is unique to
      // this capture. Only the decoder can promote the partial file to a playable result.
      if (Platform.OS !== 'android' || !take.uri) return null;
      try { if (recorder.getStatus().isRecording) return null; } catch { /* Released native handle. */ }
      return { uri: take.uri, seconds: 0 };
    } finally {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      owner = null;
    }
  };

  return { start, stop, recorder };
}
