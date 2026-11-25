// ============================================================
// Transcribe.js — 녹음을 글자로 바꾸기 (클라우드 AI)
// ============================================================
//   짧은 녹음(10분 미만) 또는 웹: 녹음 파일 하나를 서버 임시 보관함에 올리고 /transcribe로 바로 받아씀 (30분, 25MB까지)
//     실패하면 녹음은 서버에 3일 남아서, 다시 시도할 때 올리지 않고 바로 변환합니다.
//   긴 녹음(10분 이상, 휴대폰 앱): 약 2분 구간으로 나눠 올리고 서버 stt-worker가 구간별로 받아씀 (3시간까지)
//     끊기면 다시 시도할 때 남은 구간부터 이어서 올리고, 받아 적은 구간은 다시 보내지 않습니다.
//
//   const job = newTranscribeJob(uri, seconds);          // 녹음 하나에 하나. 다시 시도할 때 r.job 을 넘김
//   const r = await transcribeRecording(job, { onProgress: p => p.text });
//   r.ok ? r.text : r.message   (r.code: CONSENT_REQUIRED 면 [허용하기]로 동의 받기)
//   글을 저장한 뒤 finishTranscription(r.job) → 서버 임시 전사문 정리 (긴 녹음만)
import {
  canSplitRecording, finishLongRecording, newLongRecordingJob, newTranscribeJob as newSingleJob,
  transcribeForDevice, transcribeLongRecording,
} from '../../integration/runtime';
import { STT_MAX_SECONDS } from '../../lib/stella/transcribe';

export function newTranscribeJob(uri, seconds) {
  return canSplitRecording(seconds)
    ? { kind: 'long', ...newLongRecordingJob(uri, seconds) }
    : { kind: 'single', ...newSingleJob(uri, seconds) };
}

export async function transcribeRecording(job, { onProgress } = {}) {
  try {
    if (job.kind === 'long') {
      try {
        const r = await transcribeLongRecording(job, { onProgress });
        return { ok: true, text: r.text, complete: r.complete, missing: r.missing, remainingMinutes: r.remainingMinutes, job: { kind: 'long', ...r.job } };
      } catch (e) {
        // 분할 모듈을 쓸 수 없으면(개발용 앱 등) 30분 이하 녹음은 한 번에 보내는 방식으로
        if (e?.code === 'SPLIT_UNAVAILABLE' && (job.seconds ?? 0) <= STT_MAX_SECONDS) {
          return transcribeRecording({ kind: 'single', ...newSingleJob(job.uri, job.seconds) }, { onProgress });
        }
        throw e;
      }
    }
    onProgress?.({ phase: 'upload', text: '녹음을 받아 적는 중…' });
    const r = await transcribeForDevice(job);
    return { ok: true, text: r.text, complete: true, missing: 0, remainingMinutes: r.remainingMinutes, job: { kind: 'single', ...r.job } };
  } catch (e) {
    const code = e?.code ?? 'UNKNOWN';
    const consent = code === 'CONSENT_REQUIRED' || code === 'TRANSMISSION_DENIED';
    return {
      ok: false, code, job: e?.job ? { kind: job.kind, ...e.job } : job,
      message: consent ? '녹음을 글자로 바꾸려면 외부 AI로 보내기를 허용해 주세요' : (e?.message || '녹음을 글자로 바꾸지 못했어요'),
    };
  }
}

/** 받아 적은 글을 저장한 뒤 부름. 긴 녹음이면 서버의 임시 전사문을 바로 지움 */
export async function finishTranscription(job) {
  if (job?.kind === 'long') await finishLongRecording(job);
}
