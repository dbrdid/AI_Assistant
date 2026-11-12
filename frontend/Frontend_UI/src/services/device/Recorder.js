// ============================================================
// Recorder.js — 소리 녹음 (expo-audio)
// ============================================================

import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';

export function useRecorder() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

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
      await setAudioModeAsync({ allowsRecording: false });
      return recorder.uri || null;
    } catch (e) {
      return null;
    }
  };

  return { start, stop };
}
