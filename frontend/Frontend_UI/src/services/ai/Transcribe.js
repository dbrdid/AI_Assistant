// ============================================================
// Transcribe.js — 녹음을 글자로 바꾸기 (서버 AI 게이트웨이 /transcribe, 클라우드 AI)
// ============================================================
//   1) 녹음을 서버 임시 보관함에 올림  2) 서버가 글자로 바꿈  3) 성공하면 서버가 녹음을 바로 지움
//   실패하면 녹음은 서버에 3일 남아서, 다시 시도할 때 올리지 않고 바로 변환합니다.
//
//   const job = newTranscribeJob(uri, seconds);          // 녹음 하나에 하나. 다시 시도할 때 r.job 을 넘김
//   const r = await transcribeRecording(job);
//   r.ok ? r.text : r.message   (r.code: CONSENT_REQUIRED 면 [허용하기]로 동의 받기)
import { newTranscribeJob, transcribeForDevice } from '../../integration/runtime';

export { newTranscribeJob };

export async function transcribeRecording(job) {
  try {
    const r = await transcribeForDevice(job);
    return { ok: true, text: r.text, remainingMinutes: r.remainingMinutes, job: r.job };
  } catch (e) {
    const code = e?.code ?? 'UNKNOWN';
    const consent = code === 'CONSENT_REQUIRED' || code === 'TRANSMISSION_DENIED';
    return {
      ok: false, code, job: e?.job ?? job,
      message: consent ? '녹음을 글자로 바꾸려면 외부 AI로 보내기를 허용해 주세요' : (e?.message || '녹음을 글자로 바꾸지 못했어요'),
    };
  }
}
