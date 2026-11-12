// ============================================================
// Transcribe.js — 녹음을 글자로 바꾸기 (★ 지금은 임시: 서버가 없어서 못 함)
// ============================================================
// 서버(음성 인식 AI)가 연결되면 이 함수만 채우면 돼요.
//   입력: uri (녹음 파일 위치)
//   출력: { ok:true, text:'…받아 적은 글…' } | { ok:false, reason:'backend' }
// 글자로 바뀌면 AI 제안(일정·할 일 후보 추출)이 이어서 동작해요 (services/Aianalyze.js).
export async function transcribeRecording(uri) {
  // TODO(백엔드): 녹음 파일을 서버로 보내 받아 적은 글을 돌려받으세요.
  return { ok: false, reason: 'backend' };
}
