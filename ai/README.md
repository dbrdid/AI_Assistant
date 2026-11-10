# 문서 AI

문서 요약과 핵심 내용 추출을 위한 독립 Node.js 모듈입니다. 초기 후보는 Gemma 4 E2B 4비트이며 모델 이름은 실행 환경에서 지정합니다. 실제 모델 채택과 성능 검증은 아직 수행하지 않았습니다.

## 사용

Node.js 24 이상, Ollama와 설치된 모델이 필요합니다. 추가 npm 의존성은 없습니다.

```js
import { createOllamaDocumentProvider, summarizeDocument } from './src/documents.js';

const provider = createOllamaDocumentProvider({
  baseUrl: process.env.OLLAMA_BASE_URL,
  model: process.env.OLLAMA_MODEL,
});
const result = await summarizeDocument({
  documentId: 'note-1', revision: 3,
  text: '회의는 금요일입니다. 예산은 아직 미정입니다.',
}, { provider, timeoutMs: 30000 });
console.log(result);
```

루트에서 시험: `npm --prefix ai test`.

- [설계와 책임](DESIGN.md)
- [평가 계획·검증 범위](EVALUATION.md)

이 모듈은 HTTP API를 노출하거나 DB를 수정하지 않습니다. 로컬 또는 클라우드의 한 Ollama 런타임에서 모델 전체를 실행합니다. 기존 backend/cloud API에 신규 요약 엔드포인트를 연결하는 작업은 팀 계약 합의 후 별도 진행합니다. 기존 organize 어댑터는 일정·할 일 후보 추출용으로 유지하며 문서 요약 계약을 대체하지 않습니다.
