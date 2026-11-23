
/**
 * AI Assistant
 * 음성 변환 텍스트 기반 자동 제목 생성 기능
 *
 * 입력: 회의 또는 강의 텍스트
 * 출력: 내용을 대표하는 자동 생성 제목
 */

const OLLAMA_URL =
  process.env.OLLAMA_BASE_URL || "http://localhost:11434";

const MODEL =
  process.env.OLLAMA_MODEL || "llama3.2";

/**
 * 텍스트 내용을 분석하여 제목 생성
 */
export async function generateTitle(transcript) {

  // 1. 입력값 검사
  if (
    typeof transcript !== "string" ||
    transcript.trim().length === 0
  ) {
    throw new Error("분석할 텍스트가 없습니다.");
  }

  // 2. AI에게 전달할 프롬프트
  const prompt = `
너는 회의 및 강의 내용을 분석하는 AI 비서야.

아래 텍스트를 읽고 핵심 주제를 파악해.

요구사항:
1. 전체 내용을 종합해서 핵심 주제를 찾아.
2. 내용을 가장 잘 대표하는 제목을 만들어.
3. 한국어로 작성해.
4. 제목은 20자 내외로 작성해.
5. 불필요한 설명이나 따옴표는 제외해.
6. 반드시 제목 하나만 출력해.

[분석할 텍스트]
${transcript}
`;

  try {

    // 3. Ollama AI 모델에 요청
    const response = await fetch(
      `${OLLAMA_URL}/api/generate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.3
          }
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    // 4. 응답 오류 확인
    if (!response.ok) {
      throw new Error(
        `AI 서버 오류: ${response.status}`
      );
    }

    const result = await response.json();

    // 5. 생성된 제목 정리
    const title = result.response
      ?.trim()
      .replace(/^["'「『]|["'」』]$/g, "");

    if (!title) {
      throw new Error("AI가 제목을 생성하지 못했습니다.");
    }

    // 6. 제목 반환
    return {
      success: true,
      title: title
    };

  } catch (error) {

    console.error("제목 생성 오류:", error.message);

    throw new Error(
      "자동 제목 생성에 실패했습니다."
    );
  }
}
