# ai

모델 선택·프롬프트·문서 요약·질문 답변과 한국어 평가를 담당합니다. 기존 별도 Fastify 서버를 제거했으므로 그 서버의 Ollama 어댑터를 현재 정본으로 참조하지 않습니다.

문서 AI 구현은 [codex/ai-document-summary의 ai 폴더](https://github.com/dbrdid/AI_Assistant/tree/codex/ai-document-summary/ai)에 있으며 이번 백엔드 정리 작업에서 병합하지 않습니다. 로컬 Gateway·Worker와 실제 모델을 연결하는 어댑터 및 자동 라우팅은 후속 통합 대상입니다. 모델 실행 위치와 코드 담당 폴더는 별개입니다. 모델 파일·사용자 데이터·비밀 키는 커밋하지 않습니다.
