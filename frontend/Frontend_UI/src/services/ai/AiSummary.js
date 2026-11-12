// ============================================================
// AiSummary.js — AI 요약 
// ============================================================


export async function summarizeText(text) {
  await new Promise((resolve) => setTimeout(resolve, 900)); // 서버 응답을 기다리는 척

  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty');
  const sentences = (clean.match(/[^.!?。]+[.!?。]?/g) || [clean]).map((t) => t.trim()).filter(Boolean);
  const out = sentences.slice(0, 2).join(' ');
  return out.length > 120 ? `${out.slice(0, 120)}…` : out;
}
