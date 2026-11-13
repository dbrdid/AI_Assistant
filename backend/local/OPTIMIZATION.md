# SQLite 조회 최적화 — 근거와 검증

작성일: 2026-11-14. 기준 커밋: 63f9788 (클라우드 서버 제거 작업 브랜치). 운영 DB나 실제 사용자 데이터에는 접속하지 않았다.

## 적용 범위

1. 스키마 v2 번호 마이그레이션으로 인덱스만 변경한다. v1 schema.sql은 보존한다.
2. queued 작업 인덱스를 (workspace_id, created_at) 부분 인덱스로 교체한다. 같은 시각의 순서는 rowid로 유지한다.
3. 사용자별 멤버십·초대 인덱스를 (user_id, workspace_id)로 교체해 공간 ID 정렬을 지원한다. 중복 접두사 인덱스를 추가하지 않는다.
4. AI 요청 제한 집계용 (workspace_id, actor_id, created_at)을 추가한다. actor_id 단독 인덱스는 계정 전체 정리에 필요하므로 유지한다.
5. 폴더·접근 가능한 문서·휴지통 목록은 all() 대신 iterate()로 읽고 권한 있는 limit+1개가 모이면 중단한다. 첫 페이지와 다음 페이지 SQL을 구분해 id>? 범위 탐색이 가능하게 한다. 권한 검사를 없애거나 SQL LIMIT만 붙여 숨겨진 행 때문에 페이지가 비게 만들지 않는다.
6. DB를 열고 마이그레이션을 완료한 뒤 PRAGMA optimize=0x10002를 실행한다. 장기 실행 호스트의 주기적 유지보수 스케줄은 이번 범위에 포함하지 않는다.

명시적 인덱스는 21개에서 22개로 증가하며 PK/UNIQUE 자동 인덱스는 유지된다. BEGIN IMMEDIATE, WAL, 외래키, 동의·예산·멱등성·권한 규칙과 동기화 커서는 그대로다. durability를 낮추는 synchronous=OFF, journal_mode=OFF 같은 변경은 하지 않았다.

## 참조 자료와 적용 근거

| 자료 | 사용한 근거 | 적용 |
| --- | --- | --- |
| [SQLite Query Planning](https://sqlite.org/queryplanner.html) | 복합 인덱스의 선두 열·covering·정렬·중복 접두사 비용 | 작업 큐·사용량·멤버십 인덱스 |
| [SQLite Partial Indexes](https://sqlite.org/partialindex.html) | 조건에 해당하는 행만 인덱스에 포함 | queued 부분 인덱스 |
| [SQLite Query Optimizer Overview](https://sqlite.org/optoverview.html) | AND 조건의 복합 범위 탐색과 정렬 계획 | nullable OR를 첫/다음 페이지 SQL로 분리 |
| [SQLite Row Values, scrolling window](https://sqlite.org/rowvalue.html) | OFFSET보다 커서 기준 범위 조회를 사용하는 접근 | 기존 ID 커서 유지·실행 계획 개선. row-value 문법 자체는 필요하지 않아 도입하지 않음 |
| [SQLite ANALYZE](https://sqlite.org/lang_analyze.html) | 인덱스 변경·연결 시작 시 bounded 통계 관리 | PRAGMA optimize |
| [Node.js sqlite Statement.iterate](https://nodejs.org/api/sqlite.html#statementiterate) | 행을 배열 전체가 아닌 iterator로 소비, Node 22.13부터 지원 | 권한 필터링 목록의 조기 중단 |
| [Chaudhuri & Narasayya, AutoAdmin What-If Index Analysis Utility, SIGMOD 1998](https://www.microsoft.com/en-us/research/publication/autoadmin-what-if-index-analysis-utility/) | 연구기관 공개 초록의 workload·후보 인덱스 영향 정량 비교 접근 | 기존/후보 인덱스의 계획·지연·쓰기·공간 비교. 논문 전문을 검증하거나 SQL Server hypothetical-index 기능을 구현한 것은 아님 |

## 성능 비교 방법

`node backend/local/benchmarks/sqlite.mjs` 또는 `BENCH_ROWS=20000` 환경 변수로 실행한다. 기본값은 문서·폴더·동의·작업 각각 20000건, 공간 8개·사용자 16명인 합성 데이터다. 각 arm은 별도 인메모리 DB에 동일하게 적재한다. v1과 v2 모두 ANALYZE를 실행한 뒤 SQL별 워밍업 10회와 측정 60회를 수행하고 결과 일치를 assert한다.

페이지 비교는 ACL 검사와 네트워크를 제외한 SQL 결과 소비 microbenchmark이다. 기존 nullable OR+all()과 새 id>?+iterate()에서 21행을 소비한다. SQL 지연은 앱·모바일·모델 처리 시간이 아니다. 멤버십 분포, 요청 시각, 대기 상태 비율은 합성이며 운영 분포와 다를 수 있다. 단일 실행의 중앙값이므로 일반적인 배수 향상을 보장하지 않는다.

전체 원본 결과: [windows-node26.json](benchmarks/results/windows-node26.json).

| 측정, 중앙값 ms | v1 | v2 |
| --- | ---: | ---: |
| 대기 작업 선택 | 0.5509 | 0.0065 |
| 사용자 최근 요청 집계 | 0.3112 | 0.0032 |
| 멤버십 목록 | 0.0108 | 0.0076 |
| 문서 다음 페이지 소비 | 0.7143 | 0.0251 |
| 작업 시각 변경 후 복원, 하나의 트랜잭션 | 0.0072 | 0.0086 |

환경: Windows, Node.js 26.13.0, SQLite 3.54.0. queue에서 USE TEMP B-TREE FOR ORDER BY가 사라졌고 최근 집계는 COVERING INDEX ai_jobs_actor_recent를 사용한다. 다음 페이지는 workspace_id와 id 범위를 함께 탐색한다.

할당 페이지 수×페이지 크기는 38850560 → 40615936 bytes(약 +4.5%)였다. 이는 인메모리 DB의 할당 크기이며 실제 기기의 DB 파일·WAL·캐시 메모리 실측이 아니다. 쓰기 microbenchmark가 느려졌으므로 읽기 개선만 보고 모든 작업이 빨라졌다고 해석하지 않는다. 현재 쓰기 측정은 insert 전체 성능이나 fsync 비용을 평가하지 않는다.

## 회귀·마이그레이션 검증

신규 6개 시험은 v1 데이터 전체 스냅샷·rowid 보존, 마이그레이션 재실행, 실패 시 인덱스·버전 롤백, 새 파일 생성·재열기·미지원 버전 거절, foreign_key_check와 integrity_check, 인덱스 계획, ACL 필터링 페이지 순회와 iterator 조기 종료, 휴지통 페이지·보존 기간을 검증한다. 기존 FIFO·멱등성·예산·권한·충돌 시험도 실행한다.

Windows 전체 시험은 기존 vault의 POSIX 권한 검사 때문에 14개가 실패하는 제한이 있다. 이 검사를 완화하거나 건너뛰지 않고 Ubuntu CI에서 전체를 확인한다. 실제 모바일·다중 프로세스 경쟁·전원 차단·실제 데이터 규모와 AI 모델 성능은 미검증이다.

## 적용과 복구

파일 DB를 열면 v0→v1→v2 또는 v1→v2를 하나의 트랜잭션에서 적용한다. 인덱스 생성 오류 시 데이터·기존 인덱스·user_version을 롤백한다. 성공한 DB는 user_version=2가 되므로 이전 v1 실행 코드는 이를 거절한다. 운영 적용 전 DB 연결을 정상 종료한 상태에서 일관된 백업을 확보해야 한다. WAL을 사용하는 동안 .sqlite 파일 하나만 임의 복사하지 않는다. 적용한 v2를 파일 삭제나 user_version 숫자만 바꿔 되돌리지 않는다. 되돌리려면 검증된 백업 또는 별도 역마이그레이션이 필요하다.

권한 계산 캐시, 읽기 트랜잭션 분리, WITHOUT ROWID, UUID BLOB 변환, 전문검색, 데이터 정리 주기 변경은 이번 범위 밖이다. 운영 workload 측정 없이 구조를 확대하지 않는다.
