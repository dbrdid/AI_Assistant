# shared/contracts

공유 계약의 진입점입니다. 로컬 백엔드 RPC는 [rpc/index.js](../../backend/local/rpc/index.js), 오류는 [contracts/errors.js](../../backend/local/contracts/errors.js), AI 요청은 [Gateway 명세](../../backend/local/gateway/README.md)를 참조합니다. 실제 계약 파일을 복제하지 않습니다.

아직 프론트·로컬·문서 AI를 아우르는 독립 계약 패키지는 없습니다. 계약 변경 시 관련 소비자의 버전·ID·결과 형식과 오류를 검토하고 예시·시험을 함께 갱신합니다. 삭제된 서버의 JSON Schema는 더 이상 정본이 아닙니다.
