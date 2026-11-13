# 백엔드 구성과 계약

2026-11-14: 별도 Fastify 서버를 제거하고 [로컬 백엔드](../backend/local/README.md)만 유지합니다. HTTP 리스너·모델 추론 서버·Docker 배포를 새로 구현한 변경이 아닙니다.

## 코드 책임

| 위치 | 역할 |
| --- | --- |
| backend/local/db/ | SQLite 스키마·연결·동기 트랜잭션 |
| backend/local/rpc/ | 입력·역할·ACL·버전 검증과 업무 쓰기 |
| backend/local/gateway/ | 주입된 JWT 검증을 통한 동의·작업 접수·조회·취소 핸들러 |
| backend/local/worker/ | 작업 확보·실행 전 검사·제공자 호출·결과 정산 |
| backend/local/adapters/ | SQLite RPC 브리지와 암호화 파일 보관 |
| backend/local/contracts/errors.js | 오류 계약 |

Gateway는 Request → Response 핸들러이며 그 자체로 HTTP 서버를 시작하지 않습니다. 자동 토큰 라우팅도 아직 없습니다. 사용자 신원·운영 키·실제 제공자는 호스트에서 구성해야 합니다.

## 계약과 실행

로컬 업무 RPC와 역할 허용 목록은 [rpc/index.js](../backend/local/rpc/index.js), AI 요청은 [Gateway 안내](../backend/local/gateway/README.md), 동의·예산·큐는 [AI DB 설명](../backend/local/AI-DATABASE.md)을 따릅니다. 삭제된 이전 서버의 organize/conditions/answer JSON Schema를 현재 계약으로 가져오지 않습니다.

문서 AI 기능은 별도 AI 작업 브랜치에서 관리하며 Worker와의 입력·결과·실행 제한 어댑터는 통합해야 합니다. 실제 SQLite 데이터는 보존하며 이번 변경으로 스키마·RPC·권한 로직을 수정하지 않습니다.

루트 실행: `npm --prefix backend/local ci --ignore-scripts`, `npm --prefix backend/local test`.

기존 Fastify API의 소스와 명세는 [삭제 전 커밋](https://github.com/dbrdid/AI_Assistant/tree/3f695dfba46067c8a05073636afa2ebc5eafe988/backend/cloud)에서 열람할 수 있습니다. 과거 서버의 24개 시험은 현재 로컬 백엔드 검증과 구분합니다.
