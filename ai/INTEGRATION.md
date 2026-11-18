# 문서 AI 모듈 통합 경계

`src/`, `test/`, `package.json`은 AI 작업 브랜치 `c8ddc0b036413a03c47d96f7b77ad3062cc8e931`에서 가져온 문서 요약·근거 Q&A 라이브러리다. `npm test`는 모의 provider로 실행하며 모델을 다운로드하거나 외부 API를 사용하지 않는다.

현재 앱 연결은 클라우드 팀의 기존 `analyze`, `query/plan`, `query/answer` Gateway DTO를 우선한다. 기기 정책과 원본 버전 검사는 `frontend/Frontend_UI/src/integration/ai-service.js`, 실제 자체 모델 연결은 `backend/supabase/functions/ai-gateway/providers.ts`와 `backend/cloud/src/internal.js`가 담당한다. 이 폴더의 모든 청킹/병합 기능이 현재 앱의 요약 버튼에 연결됐다고 해석하지 않는다. 긴 문서 자동 처리와 독립 라이브러리의 UI 노출은 후속 작업이며 현재 자체 호스트의 입력 제한을 우회하지 않는다.

전체 적용 범위와 수용 조건은 `docs/INTEGRATION-2026-11-16.md`, `docs/validation/PLAN-v2.md`를 따른다. 실제 모델 성능·메모리·한국어 품질은 미측정이다.
