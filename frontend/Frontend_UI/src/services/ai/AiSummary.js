// ============================================================
// AiSummary.js — AI 요약 (★ 임시 버전. 서버가 준비되면 이 파일 안쪽만 바꾸면 됩니다)
// ============================================================
// summarizeText(text) : 메모 글자를 받아 짧은 요약 글자를 돌려줍니다. (실패하면 throw)
//
// 지금은 AI 가 없어서 "앞의 두 문장을 잘라 보여주는" 흉내만 냅니다. (0.9초 기다렸다가 답이 오는 것처럼)
//
// TODO(백엔드 연결 후): 아래 mock 부분을 서버 호출로 교체
//   const res = await fetch(`${API_URL}/ai/summarize`, {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
//     body: JSON.stringify({ text }),
//   });
//   if (!res.ok) throw new Error('summarize failed');   // → 화면에서 "AI 분석 실패" 안내(스토리보드 108장)
//   return (await res.json()).summary;
// 화면(MemoEditScreen.js) 쪽 코드는 그대로 둬도 됩니다.

export async function summarizeText(text) {
  await new Promise((resolve) => setTimeout(resolve, 900)); // 서버 응답을 기다리는 척

  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty');
  const sentences = (clean.match(/[^.!?。]+[.!?。]?/g) || [clean]).map((t) => t.trim()).filter(Boolean);
  const out = sentences.slice(0, 2).join(' ');
  return out.length > 120 ? `${out.slice(0, 120)}…` : out;
}
