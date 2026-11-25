// Atria 브리지 플러그인 예시. 이 파일을 플러그인 폴더(atria-bridge plugins로 확인)에 복사하고
// `atria-bridge enable-plugin echo` 후 서버를 다시 시작하면 앱의 모델 목록에 echo/default가 생깁니다.
// 실제 플러그인은 chat()에서 원하는 AI(로컬 프로그램, 사내 서버, 다른 API)를 부르고 답의 글자만 돌려주면 됩니다.
export default {
  id: 'echo',
  label: 'Echo 예시',
  // ctx.settings: 설정 파일 plugins.echo.settings 값 (API 주소, 모델 이름 등)
  async models(ctx) {
    return ['default'];
  },
  // request.messages: [{ role: 'system' | 'user' | 'assistant', content }], request.maxTokens, request.temperature
  // ctx.signal: 시간 초과 시 취소되는 AbortSignal (fetch에 그대로 넘기면 됨)
  async chat(model, request, ctx) {
    const last = request.messages.filter(m => m.role === 'user').at(-1)?.content ?? '';
    return `[${model}] ${last}`;
  },
};
