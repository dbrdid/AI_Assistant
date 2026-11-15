// 녹음 파일을 다시 인코딩하지 않고 구간 파일(m4a)로 자르는 Expo 로컬 모듈 (iOS·Android)
//   앱 루트의 modules/stella-audio-split 에 두면 자동 연결(autolinking)돼요. 개발 빌드 필요(Expo Go 안 됨)
//   ⚠️ 연결·검증 필요: 실제 iPhone·Android 기기에서 확인 전
//
//   const total = await getAudioDuration(recorder.uri);
//   const plan = planSegments(total);                       // @/lib/stella (약 2분씩)
//   const segs = await splitAudio(recorder.uri, plan.map((p) => ({ start: p.startSeconds, duration: p.durationSeconds })));
//   → createRecording(supabase, { recordingId, segments: segs.map((s) => ({ seq: s.seq, durationSeconds: s.durationSeconds, sizeBytes: s.sizeBytes })) })
import { requireNativeModule } from 'expo-modules-core';

export interface SplitRange { start: number; duration: number }          // 초
export interface SplitSegment { seq: number; uri: string; startSeconds: number; durationSeconds: number; sizeBytes: number }

const Native = requireNativeModule<{
  getAudioDuration(uri: string): Promise<number>;
  splitAudio(uri: string, ranges: SplitRange[], outputDir: string | null): Promise<SplitSegment[]>;
}>('StellaAudioSplit');

/** 녹음 길이(초) */
export function getAudioDuration(uri: string): Promise<number> {
  return Native.getAudioDuration(uri);
}

/**
 * 원본은 그대로 두고 구간 파일을 새로 만듦 (기본: 앱 캐시 폴더/stella-split/<무작위>/000.m4a …)
 *   구간 파일은 업로드가 확인되면(onSegmentConfirmed) 지우고, 전체가 확인되면 원본도 지우세요
 */
export async function splitAudio(uri: string, ranges: SplitRange[], outputDir?: string): Promise<SplitSegment[]> {
  if (ranges.length === 0) return [];
  return Native.splitAudio(uri, ranges, outputDir ?? null);
}
