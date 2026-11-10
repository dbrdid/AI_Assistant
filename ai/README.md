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

## 확장 기능

기존 `summarizeDocument()` 계약은 유지합니다. 긴 문서·길이 선택·키워드와 질문 답변은 다음 함수를 사용합니다.

```js
import { summarizeLongDocument, answerDocument } from './src/analysis.js';

// provider는 앞의 createOllamaDocumentProvider()로 생성합니다.
const document = { documentId: 'note-1', revision: 3, text: '회의는 금요일입니다. 예산은 아직 미정입니다.' };
const summary = await summarizeLongDocument(document, {
  provider, summaryLength: 'standard', timeoutMs: 120000,
});
// summary.result: { summary, keywords, keyPoints: [{ text, citation: { chunkId, quote } }] }
const answer = await answerDocument(document, '예산이 확정됐나요?', {
  provider, timeoutMs: 120000,
});
// answer.result: { answer, insufficientEvidence, citations: [{ chunkId, quote }] }
```

- 최대 입력: 80,000 UTF-16 코드 단위. 4,000 단위 구간에 약 200 단위 겹침을 둡니다.
- 요약 길이: `short` 최대 300, `standard` 최대 800, `detailed` 최대 1,600 단위. 정확한 글자 수 보장은 아닙니다.
- 키워드: 최대 8개. 핵심 내용 최대 5개, 인용 최대 300 단위.
- 질문: 최대 1,000 단위. 답변 최대 1,000 단위, 인용 최대 5개. 근거 부족 시 `insufficientEvidence: true`와 빈 인용을 반환합니다.
- 두 함수 모두 `chunks: [{chunkId,start,end}]`와 `inputRevision`을 반환합니다. start/end는 원문 UTF-16 인덱스이며 end는 제외합니다.
- 전체 작업 기본 제한 120초, 설정 최대 600초. 구간마다 제한 시간이 초기화되지 않습니다.

텍스트 분할은 모델을 여러 장치에 나누는 분산 추론이 아닙니다. 한 Ollama 런타임에 순차 요청합니다. PDF/Word 파일 읽기, 새 HTTP API, 임베딩 검색과 DB 저장은 포함하지 않습니다.
