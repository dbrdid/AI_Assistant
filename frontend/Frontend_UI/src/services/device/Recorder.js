// ============================================================
// Recorder.js — 소리 녹음 (expo-audio)
// ============================================================
// const rec = useRecorder();
//   await rec.start()  → { ok:true } | { ok:false, reason:'denied' | 'error' }   (마이크 권한 요청 포함)
//   await rec.stop()   → 녹음 파일 위치(uri) 또는 null
// ※ 필요한 패키지: expo-audio  (Snack 의 package.json dependencies 에 추가: "expo-audio": "~1.0.x")
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
