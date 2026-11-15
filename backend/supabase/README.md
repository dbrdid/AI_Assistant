# Stella 백엔드 (Supabase) 현황

> 저장소 위치: `backend/supabase/`. 앱 모듈은 `frontend/Frontend_UI/src/lib/stella/`, 두 기기 검증 도구는 `tests/sync-verify/`, 서버에 맞춘 기기 저장소는 `backend/local/`에 있어요. 아래 글의 `supabase/`·`fe/stella`·`stella-sync-verify`는 이 위치들을 가리켜요.

> 담당: 유병욱 · 최종 업데이트: 2026-11-15 · 기능 동결 11/20 · 인수 11/30

## 구성

```
앱(React Native + Expo) ─┬─ Supabase Auth      로그인 (이메일 · Google · Kakao)
                         ├─ Postgres + RLS     공유 공간 데이터 · 동기화 RPC
                         ├─ Storage            첨부 · 백업 · 녹음 임시 보관함 (비공개 버킷)
                         ├─ Realtime           공유 공간 변경 신호 (비공개 채널)
                         └─ Edge Function      AI Gateway → OpenAI (Terra · 받아쓰기 gpt-transcribe) · 첨부 업로드(assets) · 긴 녹음 전사(stt-worker) · 녹음 정리(stt-cleanup) · 문서 글자 추출(doc-extract)
```

- **서버에는 공유 공간(SHARED)만 저장합니다.** 개인 데이터는 기기 SQLite가 정본이에요.
- **AI 결과는 초안입니다.** 사용자가 승인한 뒤에만 앱이 저장합니다.
- **OpenAI 키는 서버(Edge Function secret)에만 둡니다.** 앱에는 넣지 않아요.

## 폴더

| 경로 | 내용 |
|---|---|
| `migrations/` | DB 마이그레이션 37개 (서버에 적용 완료, 파일명 = 서버 버전, 내용도 서버 기록과 바이트 단위로 같음 — 11/15 md5 확인) |
| `functions/ai-gateway/` | AI Gateway (배포 완료, 서버 버전 14: 11/15 질문 한도 1,000 → 2,000자). `index.ts`가 정리·추출·사진 글자(/ocr)와 진입점, `transcribe.ts`가 짧은 녹음 올리기·변환, `assist.ts`가 AI 채팅(/query/plan·/query/answer)·안건 판단(/agenda/judge)의 요청 검사·지시문·출력 검사 |
| `functions/stt-worker/` | 긴 녹음 구간 전사 워커 (배포 완료, v1, `verify_jwt=false`). 업로드 확인·매분 cron이 깨움, 동시 2개 |
| `functions/stt-cleanup/` | 녹음 임시 보관함 정리 (배포 완료, v2, `verify_jwt=false`). 매시간 cron·녹음 취소 때 Vault 비밀값을 붙여 부름. 버킷 `stt-uploads`·`stt-recordings` |
| `functions/assets/` | 첨부·백업 업로드 API: 준비·확인·삭제 (배포 완료, v1). `handler.ts`가 로직, `index.ts`가 Supabase 연결 |
| `functions/account/` | 회원 탈퇴 (#33, 배포 완료, v1, `verify_jwt=true`). DB 정리 → Storage 파일 삭제 → 계정 삭제 → 로그인 계정 삭제, 실패하면 다시 불러 이어서 |
| `functions/push-send/` | 푸시 알림 발송 (#34, 배포 완료, v1, `verify_jwt=false`). 매분 cron(`push-tick`)이 Vault 비밀값을 붙여 부름, Expo Push API로 100개씩 |
| `functions/invite-mail/` | 초대 메일 (#35, 배포 완료, v1, `verify_jwt=true`). Gmail SMTP 465, Secrets `SMTP_PASSWORD`가 없으면 `MAIL_NOT_CONFIGURED` |
| `functions/doc-extract/` | 문서 글자 추출 PDF·DOCX·PPTX (배포 완료, v3, `verify_jwt=true`). `extract.ts`가 해석, `handler.ts`가 요청 처리. 사용자 토큰으로 첨부를 읽어 RLS가 권한 판단, 외부 AI로 안 보냄 |
| `tests/` | 로컬 Postgres 시나리오 테스트, 원격 확인용 SQL |

## 완료

**로그인**
- [x] 이메일, Google, Kakao 로그인 (메일 발송은 당분간 Supabase 기본 메일 사용)

**DB**
- [x] 테이블 34개 전부 RLS 적용. 공간 멤버만 읽을 수 있음 (즐겨찾기·백업 목록은 본인만)
- [x] 계정·프로필·설정, 공간·멤버·초대 (마지막 소유자 탈퇴 방지 포함)
- [x] 기록: 프로젝트, 메모, 할 일, 일정, 회의, 안건
- [x] 원문 추적: 원문(텍스트·음성·사진) → 확정 원문 버전 → 메모·할 일·일정
- [x] 첨부(assets)와 비공개 버킷 `attachments`, `backups` (각 50MB), 녹음 임시 보관함 `stt-uploads` (25MB)

**공간 초대·멤버 관리 RPC** (2026-11-10)
- [x] 초대는 이메일 대신 **초대 코드** `XXXXX-XXXXX` (헷갈리는 0·O·1·I·L 제외). 링크 `<scheme>://invite?code=...`로도 열 수 있음
- [x] 코드마다 역할(EDITOR·VIEWER), 유효 기간(1시간~30일, 기본 7일), 인원(1~50명, 기본 1명)을 정함. 공간당 사용 가능한 초대는 20개까지
- [x] 코드 원문은 만들 때 한 번만 돌려주고 DB에는 sha256 해시만 저장. 앱에서 초대 목록을 봐도 해시는 안 보임
- [x] 나가기, 역할 변경, 내보내기, 공간 삭제(휴지통). 마지막 OWNER는 나가거나 강등할 수 없음
- [x] 내보낸 사람은 내보낸 **뒤에** 새로 만든 초대로만 다시 들어올 수 있음. OWNER가 아니게 된 사람이 만든 초대는 자동 취소
- [x] 멤버 변화는 동기화 원장에 기록 → 다른 기기가 `sync_pull`에서 `entity = 'workspace_members'`로 받음

| 함수 | 누가 | 하는 일 |
|---|---|---|
| `create_invite(workspace_id, role, expires_in_hours, max_uses)` | OWNER | 코드 만들기 → `{ invite_id, code, role, expires_at, max_uses }` |
| `revoke_invite(invite_id)` | OWNER | 초대 취소 (여러 번 불러도 같은 결과) |
| `preview_invite(code)` | 코드를 가진 사람 | 수락 전 확인: 공간 이름·역할·초대한 사람·인원·이미 멤버인지 |
| `accept_invite(code)` | 코드를 가진 사람 | 참여. 이미 멤버면 `already_member: true` (인원 안 씀) |
| `leave_workspace(workspace_id)` | 본인 | 나가기 |
| `change_member_role(workspace_id, account_id, role)` | OWNER | 역할 변경 (OWNER 넘기기 포함) |
| `remove_member(workspace_id, account_id)` | OWNER | 내보내기 |
| `delete_workspace(workspace_id)` | OWNER | 공간 삭제 (`deleted_at`, 되살리기는 SQL Editor에서) |

오류 코드: `INVITE_INVALID`, `INVITE_EXPIRED`, `INVITE_REVOKED`, `INVITE_USED_UP`, `INVITE_BLOCKED`, `TOO_MANY_INVITES`, `LAST_OWNER`, `FORBIDDEN`, `NOT_FOUND`

**동기화 RPC**
- [x] `sync_push`: 모든 기록 종류 저장. 일부만 성공하는 일 없이 전부 성공하거나 전부 실패하고, 같은 요청이 두 번 와도 한 번만 처리하고, 동시에 고친 경우를 충돌로 알려줌
- [x] `sync_pull`: 마지막으로 받은 지점 이후의 변경분만 받기
- [x] `sync_snapshot`: 처음 설치할 때 전체 받기

**기기 동기화 + 두 기기 검증** (2026-11-14)
- [x] 기기 SQLite 동기화 기준 구현 (앱 연결 모듈 `local-sync.ts`): 보낼 목록, 받은 변경 반영, 전체 재동기화 때 안 보낸 수정 보존, 충돌 해결
- [x] 두 기기 검증 `stella-sync-verify`: 로그인 → 공간 생성·초대 → 저장·보내기 → 다른 기기 받기 → SQLite에 데이터·커서 저장, 끊김 후 재연결, 같은 요청 재전송, 두 기기 충돌, 재동기화 보존, 휴지통, 멤버 제외 — **로컬 DB 45개 통과**
- [x] 원격 Supabase에서 같은 검증 실행 — **45개 통과 (11/14)**. 가입 → 메일 코드 인증 → 로그인, 비밀번호 재설정도 `auth-test.js`로 통과
- [ ] 실제 앱(expo-sqlite)에서 연결 (**연결·검증 필요**: 프론트 연결 단계)

**실시간 변경 신호 (Realtime)** (2026-11-14, migration `20261114105741_realtime_change_signals`)
- [x] 공간에 저장·멤버 변경이 생기면 서버 트리거가 비공개 채널 `workspace:<공간 id>`로 `changed {workspace_id, last_seq}` 신호를 보냄. 공간 삭제는 `closed`
- [x] 신호에는 데이터가 없음. 앱은 신호를 받으면 `sync_pull`로 받아 옴 (권한은 sync_pull이 다시 확인)
- [x] 그 공간의 ACTIVE 멤버만 구독 가능 (`realtime.messages` RLS). 앱은 이 주제로 신호를 보낼 수 없음
- [x] 신호가 실패해도 저장(`sync_push`)은 막지 않음
- [x] 로컬 테스트 31개(`tests/test_realtime.sql`), 동시성 테스트에서 순번 41개 = 신호 41개, 일부러 망가뜨린 정책·트리거 4가지를 테스트가 잡아냄
- [x] 원격에서 실제 신호 전달 확인: `stella-sync-verify` 51개(실시간 6개 포함), `tests/remote_realtime_smoke.sql` 8개 통과 (11/14)
- 참고: 신호는 `realtime.messages`의 날짜별 저장 공간(partition)에 쓰이는데, 이건 Realtime 서비스가 처음 연결될 때 만들어요. 아무도 연결한 적 없으면 신호는 경고만 남기고 버려져요(듣는 사람도 없으니 문제없음). 원격 SQL 확인 `tests/remote_realtime_smoke.sql`은 앱·검증 도구가 한 번 연결한 뒤에 돌리세요.
- 참고(첫 연결 지연): 한동안 연결이 없으면 Realtime 서비스가 쉬다가, 첫 연결 때 DB 변경 읽기(replication slot)를 새로 시작해요. 11/14 로그 기준 채널은 "연결됨"이 됐는데 DB 읽기 시작까지 약 1~2초가 걸렸고, 그 사이 신호(순번 17)는 빠졌어요. 신호는 알림일 뿐이고 데이터는 `sync_pull`로 받으니 데이터 손실은 없어요. 앱 모듈 `watchWorkspace`가 연결 직후·5초 뒤 두 번 받아서 이 틈을 메워요.
- 알아둘 점: 채널 권한은 구독할 때 확인돼서, 연결 중에 내보내진 사람은 다시 연결하기 전까지 숫자 신호만 더 받을 수 있음 (데이터는 sync_pull이 막음)

**첨부 업로드 API** (2026-11-14, migration `20261114111849_asset_upload_rpc`, Edge Function `assets`)
- [x] `/assets/prepare` 준비: 형식(사진·녹음·PDF·문서)·크기(50MB)·권한(EDITOR 이상)·용량(공간 첨부: 공간 관리자 요금제 기준 FREE 500MB · PRO 2GB · TEAM 10GB, #28)·완료 안 된 업로드(20개) 확인 → 서명 업로드 URL
- [x] 앱은 Storage에 직접 쓸 수 없고 서명 URL로만 올림
- [x] `/assets/complete` 확인: 서버가 올라간 파일을 직접 받아 **크기·SHA-256·형식**을 재서 준비할 때 값과 비교. 같으면 AVAILABLE + 동기화 원장 기록(다른 기기에 전달·실시간 신호), 다르면 FAILED + 파일 삭제
- [x] `/assets/delete` 삭제: 올린 사람(EDITOR) 또는 OWNER. 원장에 삭제 표시가 가서 다른 기기에서도 숨김
- [x] 같은 asset_id 재요청: 같은 내용이면 이어서(이미 끝났으면 결과만), 다른 내용이면 거절
- [x] 다운로드는 앱이 Storage 서명 URL을 직접 받음 (멤버만, 기존 정책). 메모 연결은 `sync_push`의 `note_attachments`
- [x] 백업(BACKUP)도 같은 API (계정당 200MB, 본인만)
- [x] 테스트: DB 66개(`tests/test_assets.sql`, 일부러 망가뜨린 4가지 검출), 함수 12단계(`tests/assets_function.test.ts`, Deno), 앱 모듈↔함수 12개(`tests/attachments_lib.test.ts`), 원격 SQL 7개(`tests/remote_assets_smoke.sql`)
- [x] 실제 Storage 업로드·다운로드 확인: `stella-sync-verify` 원격 62개 통과(첨부 11개 포함, 11/14)
- 후속: 기한이 지난 PENDING은 30분마다 FAILED로 바꾸지만(pg_cron), 그때 Storage에 남은 파일 정리는 아직 없음

**AI Gateway** (`/functions/v1/ai-gateway/...`)
- [x] 글을 다루는 AI는 **Terra(`gpt-6.1-terra`) 하나** (11/14 결정. 그전엔 Luna + Terra 2단). 모델은 `OPENAI_MODEL`로 바꿀 수 있음
- [x] `/organize` 메모 정리: Terra가 처리하고, 일시·형식 오류면 한 번 다시 시도 (횟수는 1회)
- [x] `/analyze` 할 일·일정 추출: Terra가 처리. "다음 주 금요일" 같은 상대 날짜를 실제 날짜로 바꾸고, 근거가 된 원문 구절도 함께 돌려줌
- [x] 회의록(`kind: MEETING`)이면 **요약 3~6문장 + 안건별 정리**(`topics`: 제목·논의 내용·결정)까지 (11/14). 앱은 `meetingTopicsToAgendaOps`로 회의 안건에 저장
- [x] 강의(`kind: LECTURE`)면 요약 + 내용 흐름(`topics`) + **주요 개념**(`key_concepts`: 용어·설명), 과제는 `tasks`·시험·발표는 `events` (11/14). 받는 글은 **60,000자(약 3시간)**까지
- [x] 녹음 전사문의 `[구간 N … 변환 실패]` 표시는 빠진 부분으로 보고 추측하지 않음 (날짜·담당자가 불확실하면 `open_questions`)
- [x] `/ocr` 사진 → 글자 (11/14): **Terra가 사진을 직접 읽음**(이미지 입력, OCR 전용 모델 없음). 한 번에 1~5장(장 순서 = 쪽 순서), 한 장 5MB·합계 10MB, JPEG·PNG·WebP·GIF(형식은 파일 앞부분으로 다시 확인, HEIC는 JPEG로 바꿔서)
  - 결과 초안: 제목, 사진 속 글 그대로(`text`, 여러 장이면 `--- 2쪽 ---`), 요약, 종류(문서·필기·판서·슬라이드·화면·영수증), 흐린 부분(`unclear_parts`). 읽을 수 없는 곳은 `[읽을 수 없음]`
  - 사진·글은 DB에도 OpenAI에도 남기지 않음. 할 일·일정은 사용자가 글을 확인한 뒤 `/analyze`로. 한도는 횟수(FREE 30 / PRO 300)
- [x] 외부 AI 동의 확인, 월 사용 한도, 같은 요청 중복 처리 방지, 모델·토큰·비용 기록
- [x] 프롬프트와 응답 본문은 DB에도 OpenAI에도 저장하지 않음
- [x] 10분마다 결과를 받지 못한 요청을 자동 정리 (pg_cron)
- [x] **AI 채팅** (11/15, v12, migration #27 `20261115035346_ai_query_agenda`): 팀 서버(로컬 AI 모드)와 같은 2단계. 기록은 서버에 없으니 앱이 기기에서 찾음
  - `/query/plan` 질문(1,000자)·앞 대화(6개·4,000자) → 검색 조건 `{ intent: search|chitchat|unsupported, reply, keywords, types, date_from, date_to, status, people, project, sort, limit }`. 상대 날짜는 앱이 보낸 `today`(서버 날짜 ±2일) 기준. 횟수 `query_plan`(FREE 150 / PRO 1,500, 질문 횟수와 별도)
  - `/query/answer` 질문 + 발췌 `sources[{ id, type, title, date, text, workspace_id }]`(12개, 각 2,500자, 합계 24,000자) → `{ answer, insufficient, citations[{ source_id, quote }], follow_ups, used_source_ids, dropped_citations }`. 횟수 `query`(FREE 50 / PRO 500 = 질문 수)
  - 발췌는 모델에 `S1…`로만 보이고, **인용 구절이 그 발췌 원문에 실제로 있는지 서버가 확인**해서 없으면 버림. 발췌의 `workspace_id`마다 지금도 ACTIVE 멤버·삭제 안 된 공간인지 먼저 확인 → 아니면 `403 FORBIDDEN`(OpenAI로 안 보냄)
  - 질문은 2,000자까지 (11/15, 화면 입력 한도에 맞춰 1,000 → 2,000자, 서버 버전 14). 앞 대화는 한 턴 1,000자·합계 4,000자 그대로(앱이 잘라 보냄). 배포본이 로컬 파일과 글자 단위로 같은지 확인함
- [x] **안건 논의 판단** (11/15, v12, #27): `/agenda/judge` 달라진 항목 `items[{ key, kind, status: added|changed|removed, title, before, after, workspace_id }]`(50개) + 그날 회의 자료 `discussions[{ id, kind, title, text, workspace_id }]`(10개·합계 60,000자) → 항목마다 `{ key, status: discussed|open, reason, evidence, discussion_id, downgraded }`. 회의 요약(`/analyze`)과 별개
  - 확신 없으면 미논의. `discussed`인데 근거 구절이 회의 원문에 없으면 서버가 `open`으로 낮춤(`downgraded`). 항목이 빠지거나 겹치면 형식 오류로 한 번 다시 시도. 횟수 `agenda`(FREE 50 / PRO 500)
  - 테스트: `tests/gateway_e2e.test.ts` 10~12단계(가짜 OpenAI로 인용 확인·403·재시도·낮춤), 앱 모듈 `tests/ai_assist_lib.test.ts` 17단계, SQL 한도 4.1~4.7(#27 없으면 실패 확인). 일부러 망가뜨린 서버 12가지·앱 모듈 14가지 모두 검출

**녹음 → 글자** (2026-11-14, `/ai-gateway/transcribe`, migration `20261114115314_stt_minute_quota`, `20261114130026_stt_upload_inbox`)
- [x] **노션 모바일 방식**: 앱이 녹음을 비공개 버킷 `stt-uploads`에 올림 → 서버가 꺼내 OpenAI `gpt-transcribe`로 변환 → **성공하면 바로 삭제, 실패하면 3일 보관**(같은 `upload_id`로 다시 올리지 않고 재시도), 올리고 안 쓴 녹음도 3일 뒤 삭제
  - `/transcribe/prepare` → 서명 업로드 URL (m4a·mp3·wav·webm 등, 25MB까지, 동의 확인, 기다리는 녹음 10개까지) → `/transcribe` → 글자 초안
  - 앱은 버킷을 읽거나 지울 수 없음(정책 없음). 보관함 기록은 `private.stt_uploads`(경로·크기·상태만, 녹음 내용·전사 글은 없음)
  - 매시간 `stt-uploads-cleanup`(pg_cron → pg_net) → Edge Function `stt-cleanup`이 Storage API로 실제 파일 삭제. 호출 확인용 비밀값은 마이그레이션이 Vault에 만들어 둠(사람이 다룰 일 없음)
- [x] 한도는 **분 단위**: 앱이 보낸 길이로 예약하고, OpenAI가 알려 준 실제 길이로 차감(올림). 실패하면 차감 없음, 시간 초과(결과 불명)는 예약한 만큼 차감
- [x] `languages`(기본 ko·en), `keywords`(사람·프로젝트 이름), `prompt`(나눠 녹음한 앞 조각의 끝부분)로 정확도 보완
- [x] 일시 오류(429·5xx)는 시간이 넉넉하면 한 번 더 시도. 같은 `client_request_id` 재요청은 한 번만 처리
- [x] 테스트: 한도 예약·정산 38개(`tests/test_ai_quota.sql`), 보관함 29개(`tests/test_stt_uploads.sql`), 함수(`tests/transcribe_function.test.ts`, 가짜 OpenAI·Storage), 정리 함수(`tests/stt_cleanup.test.ts`), 진짜 `index.ts`를 띄운 연결 테스트(`tests/gateway_e2e.test.ts`), 앱 모듈↔함수(`tests/transcribe_lib.test.ts`), 원격 SQL 7개(`tests/remote_ai_quota_smoke.sql`)
- [x] 원격 확인(11/14): 보관함 RPC 11개(롤백), 정리 함수 호출 200 `{ok:true}`·틀린 비밀값 401, 버킷·cron·Vault 비밀값 확인
- [x] 실제 OpenAI 호출 확인 (11/14, `stella-sync-verify` 원격 74개 통과)
- 이 방식은 짧은 음성 메모(30분까지, 결과를 바로 받음)용이에요. 회의·강의 녹음은 아래 "긴 녹음"을 쓰세요

**긴 녹음 (최대 3시간)** (2026-11-14, migration `20261114133933_stt_recording_jobs`, Edge Function `stt-worker`)
- [x] 흐름: **연속 녹음 → 종료 후 약 2분 구간으로 분할 → 구간 업로드 → 서버가 구간별 전사 → 전사문 확인·수정 → Terra 정리 → 저장 후 서버 정리**. 실시간 전사는 후속
  - ① `stt_recording_create`(앱이 직접 RPC): 동의·공간 편집 권한·구간 1~200개(#26, 11/15)·구간 15분/25MB·전체 3시간 확인 → 구간별 업로드 경로 `{계정}/{녹음}/{구간}.m4a`, 필요한 분·남은 분
  - ② 앱이 비공개 버킷 `stt-recordings`에 직접 업로드. Storage 정책상 **내 계정의 업로드 대기 구간 경로에만** 올릴 수 있음(다시 올리기 가능, 읽기는 그 구간뿐, 삭제 불가)
  - ③ `stt_segment_confirm`: 서버가 Storage에 실제로 있는지·크기가 같은지·내 경로인지 확인 → 전사 작업 등록(QUEUED) → 앱은 그 구간 임시 파일 삭제, 전부 확인되면 원본 삭제. 끊기면 같은 녹음 id로 남은 구간만 이어 올림
  - ④ `stt-worker`: 업로드 확인 때 DB가 바로 깨우고(5초에 1번), 놓쳐도 매분 cron(`stt-worker-tick`)이 깨움. **전체 동시 2개**(`STT_WORKER_CONCURRENCY`), 앞 구간 끝부분을 `prompt`로 넘겨 이어지게, 구간마다 분 단위 한도 예약·차감
  - **전사문을 DB에 저장한 뒤에만 음성 삭제**. 일시 오류(429·5xx·시간 초과·Storage)는 30초·60초 뒤 자동 재시도(최대 2번 더), 그 뒤엔 FAILED → 앱에서 재시도. 4분 넘게 멈춘 처리는 다시 대기로(늦게 온 결과는 버림)
  - ⑤ `stt_recording_status`(진행률: 업로드·대기·처리 중·완료·실패 수, 재시도 기한), `stt_recording_transcript`(구간 순서대로), `stt_recording_ack`(앱이 저장함 → 서버 임시 전사문 삭제), `stt_recording_retry`, `stt_recording_cancel`
- [x] 보관 규칙: 처리 전·중 유지 / 전사 성공 → 즉시 삭제 / 실패 구간만 **최초 실패부터 3일**(재시도해도 연장 없음) → 지나면 삭제·최종 실패(GAVE_UP) / 취소 → 새 처리 중단·바로 정리 / 3일 안에 안 올라온 구간·처리 못 한 구간 → 최종 실패 / 임시 전사문은 ack 즉시, 안 해도 7일 뒤 기록째 삭제(`stt-recordings-purge`)
- [x] 요약은 음성 삭제와 분리: 전사문이 있으면 Terra 정리가 실패해도 전사문으로 다시 요청 (`/analyze`, `kind: LECTURE | MEETING`)
- [x] 한도는 그대로(FREE 60분 / PRO 600분, 11/14 결정): 남은 분을 넘는 구간은 `QUOTA_EXCEEDED`로 실패. 등록할 때 `minutes_needed`·`remaining_minutes`로 미리 안내
- [x] 테스트: SQL 79개(`tests/test_stt_recordings.sql`, 일부러 망가뜨린 6가지 모두 검출), 워커 8단계(`tests/stt_worker.test.ts`, 망가뜨린 4가지 중 3가지 검출·나머지 1가지는 DB 동시 처리 한도가 막음), 앱 모듈↔SQL↔워커(`tests/recordings_lib.test.ts`), 정리 함수(`tests/stt_cleanup.test.ts`)
- [x] 원격 확인(11/14): 등록·업로드 정책·확인·가져오기·저장·정리 대상·ack·취소 14개(롤백), 워커·정리 함수 호출 200·틀린 비밀값 401, cron 2개
- [x] 서버 구간별 전사 실제 확인 (11/14, 검증 14번 묶음: 업로드 → 워커 전사 → 음성 삭제 → ack)
- [ ] 기기 분할 모듈 실제 폰 확인 (**연결·검증 필요**)
- [x] **녹음 시각 보존 (11/15, migration #26 `20261114164150_stt_segment_limit`)**: `gpt-transcribe`는 문장별 시각을 주지 않음(`verbose_json`·`timestamp_granularities`는 whisper-1만, 2027-02-26 종료 예정) → 모델은 그대로 두고 구간을 2분으로 줄여(앱 설정 1~15분) 전사문에 구간 시작 시각 `[12:00]`을 붙임. 서버는 구간 한도만 60 → 200개(1분 구간 3시간 = 180개). 차감 방식(구간마다 분 단위 올림)은 그대로라 분 단위 구간이면 손해 없음. 테스트: SQL 82개(+3, #26 없으면 3개 실패 확인), 원격 확인 SQL `tests/remote_stt_segment_smoke.sql`(4개, 마지막 일괄 검증 때 실행)

**문서 글자 추출 (PDF · Word · PowerPoint)** (2026-11-15, Edge Function `doc-extract` v3)
- [x] PDF: 쪽마다 글자층을 읽음(`unpdf`=pdf.js). Edge Function CPU 2초 한도 때문에 한 번에 50쪽·시간 예산 1.2초 → `next_from_page`로 앱이 이어 부름(240쪽 PDF 50쪽에 약 0.2초). 스캔본은 `no_text` → 사진 OCR 안내. 암호 PDF는 `FILE_ENCRYPTED`
- [x] DOCX: 본문·표(` | `)·탭·줄바꿈. 머리글·각주·변경 추적으로 지운 글자·필드 코드·글상자 중복은 뺌. 쪽은 Word가 저장 때 남긴 표시가 있을 때만 "약 N쪽"
- [x] PPTX: 화면 표시 순서(`presentation.xml`)대로, 발표자 메모(메모 칸만), 숨긴 슬라이드 표시
- [x] 입력: 공유 첨부 `asset_id`(20MB, 사용자 토큰으로 읽어 기존 RLS가 권한 판단, 암호화된 백업은 거절) 또는 기기 파일 base64(10MB). zip 폭탄 한도(풀었을 때 40MB/80MB)
- [x] 문서는 저장하지 않고 외부 AI로도 보내지 않음 → 외부 AI 동의·AI 횟수와 무관. DB 변경 없음
- [x] PDF 글자에서 유니코드 대응이 없는 글리프(사용자 영역 U+E000~F8FF)는 뺌 (Chrome이 만든 PDF의 숫자 사이 `:` 대체 모양 등에서 확인)
- [x] 테스트: `tests/doc_extract.test.ts` 23단계(일부러 망가뜨린 8가지 모두 검출), 앱 모듈 `tests/documents_lib.test.ts` 8단계, 테스트 파일 `tests/fixtures/docs/`

**PDF 내보내기 (기기에서)** (2026-11-15, 앱 모듈 `pdf-export.ts`, 서버 변경 없음)
- [x] 메모(손글씨는 SVG)·할 일·일정·회의·전사문·문서 글자 → HTML(전부 이스케이프) → `expo-print`로 기기에서 PDF → 공유(`expo-sharing`) 또는 공유 공간 첨부로 보관(기존 `assets` 업로드, `application/pdf`). 개인 공간 PDF는 서버에 안 올림
- [x] 글자 대체 모양·합자를 꺼서 PDF에서 복사·검색한 글자가 정확함
- [x] 테스트: `tests/pdf_export_lib.test.ts` 7개 — 실제로 Chromium(안드로이드 WebView와 같은 엔진)으로 인쇄한 PDF를 `doc-extract`로 다시 읽어 내용 확인. 일부러 망가뜨린 9가지 모두 검출
- [ ] 실제 iPhone·Android에서 한글 글꼴·여백 확인 (**연결·검증 필요**)

**화면 칸 · 손글씨 · 메모 복구** (2026-11-15, migration `20261114150102_ui_fields_and_note_restore`, `20261114150513_note_strokes_validation`)
- [x] 공간 설명: `workspaces.description`(120자), `create_workspace(이름, 설명)`. 기존 `create_workspace(이름)`도 그대로
- [x] 프로젝트: 마감일 `due_date`, 중요도 `priority`(0~3), 진행 상태 `progress_status`(TODO·IN_PROGRESS·DONE·ON_HOLD·CANCELED), 알림 `reminder_minutes`(0~525600분), 담당자 이름 `assignee_name`(표시용 100자), 장소 `location`(200자). 기존 `status`는 보관 상태(ACTIVE·ARCHIVED)
- [x] 할 일: `reminder_minutes`·`assignee_name`·`location` 추가 (실제 배정은 그대로 `assignee_id`)
- [x] 일정: 상태 `status`(TODO·IN_PROGRESS·DONE·CANCELED, 기본 TODO), `priority`, `reminder_minutes`, `assignee_name`
- [x] 메모 손글씨 `notes.strokes`: 획 배열 `[{ id, c, w, p: [[x,y], ...] }]`, JSON 1MiB까지. 서버가 형식 검사(`private.valid_note_strokes`, 테이블 제약이라 SQL Editor에서 고쳐도 적용)
- [x] 메모 복구: `sync_push`의 `op: 'RESTORE'`(#32부터 휴지통 대상 7가지 모두, `data: {}`, `base_revision` 필요). 휴지통에 없으면 `NOT_DELETED` 충돌. 다른 기기에는 `deleted_at: null`인 UPSERT로 전달
- [x] 모두 `sync_push`·`sync_pull`·`sync_snapshot`에 반영. 알림 칸은 저장만 하고 발송은 아직 없음
- [x] 테스트: `tests/test_ui_fields.sql` 70개 (일부러 망가뜨린 8가지 모두 검출), 두 기기 검증 8-1번 묶음 5개 (로컬 50개 통과)
- 알아둘 점: 프로젝트·일정의 `priority`에 `null`을 보내면 `REQUIRED_FIELD`로 거절돼요 (할 일은 0으로 저장). 서버가 돌려주는 손글씨 객체는 키 순서가 바뀌어 있어요 (`{c,p,w,id}`, 값은 같음)

**가짜 결제 (구독 관리)** (2026-11-15, migration `20261114160026_fake_billing`, Team은 #28 `20261115043140_team_plan`)
- [x] 시연용 가짜 결제. 실제 결제사 연동 없음 (`payments.provider = 'FAKE'`). 월 PRO 4,900원 · **TEAM 9,900원** (`private.plan_price_krw`에서 바꿈)
- [x] `subscription_checkout('PRO', client_request_id, p_simulate)`: FREE면 가짜 결제(PAID) + 지금부터 1개월 PRO. 같은 요청 id는 처음 결과 그대로(두 번 눌러도 결제 1번). 이미 PRO면 `ALREADY_ACTIVE`, 해지 예약 중이면 결제 없이 해지 취소 `RESUMED`
  - `p_simulate = 'DECLINE'`: 결제 실패(FAILED) 기록만 남기고 FREE 그대로 → 앱의 결제 실패 화면 시연용
- [x] `subscription_cancel()`: 화면 문구대로 **다음 결제일까지 PRO, 그 뒤 FREE** (`cancel_at_period_end`). 여러 번 눌러도 같은 결과. FREE면 `NOT_SUBSCRIBED`
- [x] `get_my_subscription()`: `plan`, `state`(FREE·ACTIVE·CANCELING), `next_payment_at`(다음 결제일), `next_payment_krw`, `price_krw`. 기간이 지났으면 먼저 정리하고 돌려줌
- [x] 기간 끝: 매분 cron `subscription-tick` → 해지 예약이면 FREE, 아니면 가짜 자동 결제(RENEWAL)로 1개월 연장 (밀린 기간은 36번까지)
- [x] 결제 내역 `payments`: 본인 것만 조회(RLS), 앱은 쓰기 불가. 구독 행에 모양 검사(PRO는 기간 필수, FREE는 기간 없음)
- [x] AI 한도는 기존처럼 `subscriptions.plan`·`status='ACTIVE'`를 읽음. 결제하면 바로 그 요금제 한도, 해지 예약 중에도 그 요금제 한도 (TEAM은 #28에서 PRO와 같게)
- [x] **Team 요금제 (11/15, #28)**: 화면 PLAN_INFO "팀 공간 · 팀원 초대 확대" 기준. 혜택은 구독한 사람 + 그 사람이 관리자(OWNER)인 공간
  - AI 월 한도 = PRO, 이번 달 프로젝트 초대 FREE 10 · PRO 50 · **TEAM 200회**, 공간 첨부 용량 FREE 500MB · PRO 2GB · **TEAM 10GB**(공간 관리자 중 가장 높은 요금제), 백업 FREE 200MB · PRO·TEAM 1GB. 공간 인원 한도는 두지 않음(11/15 결정)
  - `subscription_checkout('TEAM', …)`: FREE → `SUBSCRIBED`, PRO ↔ TEAM → **바로 바뀌고 오늘부터 새 1개월 결제** `CHANGED`(+ `previous_plan`, 일할 계산 없음, 시연용). 같은 요금제 해지 예약 중이면 `RESUMED`. 해지·자동 결제·결제 실패 시연은 PRO와 같음(그 요금제 가격으로)
  - `get_my_subscription()`에 `price_krw.TEAM`과 요금제 표 `plans`(가격·초대 횟수·첨부/백업 용량·AI 한도) 추가 → 화면 요금제 선택 목록에 그대로
  - 요금제를 내려도 이미 올린 첨부는 그대로, 새 업로드만 용량 확인. 용량 초과 문구에 지금 기준 용량이 나옴(`이 공간의 첨부 용량(2GB)을 넘습니다`)
  - Supabase 무료 플랜은 프로젝트 전체 Storage가 1GB라 10GB는 요금제상 한도일 뿐이에요. 실제로 많이 올리면 Supabase 쪽에서 먼저 막혀요
  - 테스트: `tests/test_billing.sql` 70개(+26, 일부러 망가뜨린 16가지 모두 검출), 앱 모듈 `tests/billing_lib.test.ts` 3개, 원격 확인 SQL `tests/remote_billing_smoke.sql` 17개(B14~B17 추가, 마지막 일괄 검증 때), 두 기기 검증 16번에 TEAM 2개
- [x] 테스트: SQL 44개(`tests/test_billing.sql`, 일부러 망가뜨린 10가지 모두 검출), 동시에 10번 결제 → 1번만(`test_concurrency.sh` (c)), 앱 모듈(`tests/billing_lib.test.ts`), 원격 확인 13개 → #28에서 17개(`tests/remote_billing_smoke.sql`, 되돌림), 두 기기 검증 16번 묶음 5개 (로컬 55개 통과)

**프로젝트 팀원 · 프로젝트 초대** (2026-11-15, migration `20261114162335_project_team`, 프론트 화면 기준)
- [x] `project_members`: 프로젝트마다 팀원 목록. 이름 1~20자, 역할 1~12자(팀장·팀원·직접 입력, 기본 팀원), 순서. 권한은 아래 **팀장 권한**(#30)에서 '팀장'만 의미가 있고 나머지 역할은 표시용
  - 쓰기는 `sync_push`(엔티티 `project_members`): 만들기·이름/역할 수정·`project_id`를 바꿔 다른 프로젝트로 이동·삭제(휴지통). 계정 연결(`account_id`)은 공간 ACTIVE 멤버만, 한 프로젝트에 같은 계정은 한 번만
  - "팀장은 모두 삭제할 수 없어요"는 화면처럼 앱(`project-team.ts`)에서 검사, 서버는 막지 않음
- [x] `project_invites` + `create_project_invite(project_id, 'EMAIL'|'LINK', email)`: 공간 **EDITOR 이상 + 그 프로젝트를 관리할 수 있는 사람**(#30 팀장 권한)이면 프로젝트 초대 가능 (공간 초대 `create_invite`는 그대로 OWNER만). 공간 초대 코드(멤버, 1명)를 만들고 "초대 대기"를 원장에 기록
  - 이번 달 초대 횟수: FREE 10 / PRO 50 / TEAM 200 (`private.project_invite_monthly_limit`에서 바꿈, TEAM은 #28), `get_project_invite_quota()`. 같은 프로젝트·같은 이메일 대기 중이면 `ALREADY_INVITED`
  - 메일은 #35 `invite-mail`로 보냄 (Secrets `SMTP_PASSWORD` 등록 전에는 지금처럼 코드를 돌려주고 앱이 공유 문구로 보냄)
  - `revoke_project_invite`: 만든 사람, 관리자 또는 그 프로젝트 팀장(#30). 공간 초대가 다른 경로로 취소돼도 프로젝트 초대가 같이 취소 표시
- [x] `join_with_invite(code)`: 공간 참여(`accept_invite`) + 초대받은 프로젝트에 '팀원'(프로필 이름)으로 추가. 이미 공간 멤버여도 프로젝트에만 추가하고 코드는 사용 완료. 공간 초대 코드도 그대로 받음 → 앱의 `acceptInvite`가 이걸 부름
- [x] `sync_pull`·`sync_snapshot`에 `project_members`·`project_invites` 포함 (코드·해시는 없음)
- [x] `sync_push`·`sync_snapshot`은 서버에 있던 함수에 바뀐 부분만 적용하는 방식으로 고침 (고칠 곳을 정확히 한 번 못 찾으면 migration 전체 실패). 결과 함수는 로컬·원격 md5가 같음
- [x] 기존 `project_participants`는 그대로 둠 (앱은 `project_members`를 씀)
- [x] 테스트: SQL 65개(`tests/test_project_team.sql`, 일부러 망가뜨린 12가지 모두 검출, #30에서 2.0 팀장 준비 추가), 15명 동시 참여 + 저장 섞어도 교착 없음(`test_concurrency.sh` (d)), 앱 모듈(`tests/project_team_lib.test.ts`), 원격 확인 11개(`tests/remote_project_team_smoke.sql`, 되돌림, #30에서 T5a 추가), 두 기기 검증 11-1번 묶음 5개

**메모 즐겨찾기 · 프로젝트 파일 · 팀장 권한 · 백업** (2026-11-15, migration #29 `20261115050043_favorites_project_files` · #30 `20261115050142_project_leader_permissions` · #31 `20261115050145_cloud_backups`)
- [x] **메모 즐겨찾기 (사람마다 따로)**: `note_favorites(account_id, workspace_id, note_id)`. 동기화 원장에 안 남김(다른 사람 기기로 안 감). 같은 사람의 다른 기기는 `list_note_favorites(공간)`으로 받음
  - `set_note_favorites(공간, 메모 id 배열(1~500), true|false)` → `{ok, changed, note_ids}`. 공간 멤버가 아니면 `FORBIDDEN`, 없는 메모는 `NOT_FOUND`
  - 메모가 지워지면 같이 지워짐(FK), 공간에서 나가거나 내보내지면 그 공간 즐겨찾기 정리(트리거)
- [x] **프로젝트에 파일 직접 연결 (메모 없이)**: `project_files(workspace_id, project_id, asset_id, position, added_by)`. `sync_push`의 연결 엔티티 `project_files`(키 `project_id`·`asset_id`, 같은 공간의 AVAILABLE 공유 첨부만). 옮기기 = 이전 프로젝트 DELETE + 새 프로젝트 UPSERT. `sync_pull`·`sync_snapshot`에 포함
- [x] **팀장 권한**(#30): 프로젝트를 관리할 수 있는 사람 = 공간 관리자(OWNER) 또는 그 프로젝트의 계정 연결된 '팀장'. 계정 연결된 팀장이 없는 프로젝트는 지금처럼 편집자 누구나
  - 관리 = 프로젝트 이름·설명 수정·삭제, 팀원 추가·수정·이동·삭제(이동은 양쪽 프로젝트 모두), 프로젝트 초대 만들기. 메모·할 일·파일 연결은 지금처럼 편집자 누구나
  - 권한이 없으면 `sync_push`가 예외 대신 **충돌**(reason `NOT_PROJECT_LEADER`, `server` = 서버 값)로 돌려줌 → 오프라인에 쌓인 변경이 막혀 멈추지 않음. 앱은 `resolveConflict(use_server)`로 서버 값으로 되돌림
  - 화면 버튼용 `get_project_permissions(공간)` → `{프로젝트 id: true|false}` (앱 `canManageProject`와 같은 규칙, 기기에서도 계산 가능)
  - 새 프로젝트 + 나를 팀장으로 한 번에 저장해도 됨 (아직 팀장 없는 프로젝트라서)
- [x] **백업·복원**(#31): 기기 데이터(개인 공간)를 **기기에서 암호화**(AES-256-GCM)해서 `backups` 버킷에 올림. 서버 파일에는 내용이 안 보임
  - 키는 계정마다 하나, 서버 `private.backup_keys`에 보관(앱은 표로 못 읽음). `backup_key(제안 키)` → 처음 제안한 키가 남고, 이후엔 같은 키를 돌려줌 → 새 기기에서 로그인만 하면 복원 가능
  - `backup_register(asset_id, MANUAL|AUTO, 기록 수, 기기 이름, 앱 버전, 보관 개수(기본 10, 1~50))` → 보관 개수를 넘은 오래된 백업 id를 돌려주면 앱이 삭제. `list_backups('new'|'old')`, 같은 요청 재시도는 처음 결과
  - 복원: 고른 백업을 먼저 받아 풀어 봄 → 지금 상태를 "자동" 백업 → 적용. 풀기에 실패하면 아무것도 안 바뀜
  - 용량은 기존 백업 한도(FREE 200MB · PRO·TEAM 1GB), 업로드는 기존 `assets` API(`purpose: 'BACKUP'`)
- [x] 테스트: SQL 89개(`tests/test_project_extras.sql`, 일부러 망가뜨린 16가지 중 15가지 검출 — 남은 1가지는 두 기기가 동시에 처음 키를 만들 때만 차이가 나는 것이라 순차 테스트로는 못 잡음. 코드는 `on conflict do nothing` 뒤 다시 읽어서 항상 먼저 저장된 키 하나를 씀), 앱 모듈(`tests/project_extras_lib.test.ts`), 원격 확인 18개(`tests/remote_extras_smoke.sql`, 되돌림), 두 기기 검증 11-2번·18번 묶음 (로컬 64개 통과)

**공유 휴지통 · 회원 탈퇴 · 푸시 알림 · 초대 메일** (2026-11-15, migration #32 `shared_trash` · #33 `account_withdrawal` · #34 `push_notifications` · #35 `invite_mail` · #36 `search_path_fix` · #37 `briefing_default_0900`)
- [x] **공유 휴지통**(#32): `sync_push`
  - `RESTORE`: 메모·할 일·일정·프로젝트·회의·안건·프로젝트 팀원 모두. 공간 편집자면 됨 (팀장 있는 프로젝트·그 팀원은 #30 팀장 규칙)
  - `PURGE`(영구 삭제, 새로): 휴지통에 있는 것만. 공간 관리자 또는 휴지통으로 보낸 사람만 → 아니면 충돌 `PURGE_NOT_ALLOWED`, 휴지통에 없으면 `NOT_DELETED`
  - 연결(메모↔프로젝트·첨부 연결·즐겨찾기·프로젝트 파일·팀원·초대)은 같이 지우고, 가리키던 할 일·일정·회의는 남기고 연결만 끊음(`note_id`·`project_id`·이월 원본 = null). 전부 원장(DELETE/UPSERT)에 남겨 다른 기기도 지움. 대기 중 프로젝트 초대의 공간 초대 코드는 취소
  - 30일 넘게 휴지통에 있던 것은 매일 03:17(서울) cron `trash-purge-expired`가 영구 삭제 (안건 → 할 일·일정 → 메모 → 회의 → 팀원 → 프로젝트 순)
- [x] **회원 탈퇴**(#33): Edge Function `account` `/delete` (`{ confirm: 'DELETE' }`)
  - 공유 기록은 남기고 작성자 칸만 null(앱: '탈퇴한 사용자'), 계정·프로필·설정·구독·결제 기록·기기·동의·AI 사용 기록·즐겨찾기·백업·녹음은 삭제
  - 혼자 OWNER인 공간: 먼저 들어온 편집자 → 없으면 먼저 들어온 보기 전용에게 OWNER. ACTIVE 멤버가 나뿐이면 공간째 삭제(첨부 파일 포함). 다른 공간은 나가기, 내가 만든 대기 중 초대는 취소, 내 계정이 연결된 팀원 칸은 '탈퇴한 사용자'
  - 원장의 내 멤버 기록에서 이름·사진을 지우고 `withdrawn: true`
  - 순서: 정리(`account_withdraw_prepare`) → 파일 삭제 → 계정 삭제(`account_withdraw_finish`) → 로그인 계정 삭제. 중간에 실패해도 다시 부르면 이어서 함 (혼자 공간은 마지막에 지워서 파일 목록을 잃지 않음)
  - 대시보드에서 사용자를 바로 지워도 같은 정리가 돌도록 `accounts` 삭제 전 트리거. 화면용 미리 보기 `account_withdraw_preview()`
- [x] **푸시 알림·브리핑**(#34, Expo Push): 매분 cron `push-tick` → 알림 만들기 → 보낼 것이 있으면 `push-send`
  - 공유 기록 마감·시작 전(`reminder_minutes`): 받는 사람 = 그 프로젝트의 계정 연결된 팀원, 없으면 공간 멤버 전체. 프로젝트 마감일은 그날 09:00(서울) 기준. 개인 할 일·일정은 기기 로컬 알림
  - 공간 소식(새 멤버) · 긴 녹음 변환 끝(실패 구간 안내) · 일간·주간 브리핑(사용자 시간대의 설정 시각, 푸시만 → 내용은 기기가 개인+공유 기록으로)
  - 설정 `get/set_notification_settings` (`user_settings.preferences.notifications`), 토큰 `set_push_token`(같은 휴대폰의 다른 계정 토큰 정리), 알림함 `list_notifications`·`mark_notifications_read`
  - 같은 알림은 한 번만(`dedupe_key`), 실패는 1분 뒤 3번까지, 등록 해제된 토큰은 기기에서 뺌, 기기 없는 알림은 SKIPPED
- [x] **초대 메일**(#35): Edge Function `invite-mail` `/send` (`{ code, email? }`). 공간 초대·프로젝트 메일 초대 모두
  - 코드 해시로 그 초대가 맞는지·보낸 사람이 만든 사람인지 확인. 한 사람 하루 30통 · 전체 하루 450통 · 같은 초대·주소는 10분에 한 번
  - 보낸 프로젝트 초대는 `mailed_at` + 원장 → "초대 대기"에 '메일 보냄'. 기록은 `private.invite_mails` (10분 넘게 보내는 중이면 cron이 실패로 정리)
  - **Secrets `SMTP_PASSWORD`(Gmail 앱 비밀번호)를 병욱이 등록해야 실제로 감**. 없으면 503 `MAIL_NOT_CONFIGURED` → 앱은 공유 문구로
- [x] #36: 보안 점검 경고(search_path 고정) 4건 정리
- [x] #37: 일간 브리핑 기본 시각 08:00 → 09:00 (팀 결정, 프로젝트 마감 알림 기준 시각과 같게). 일간 브리핑을 꺼 둔 채 08:00으로 저장돼 있던 값도 09:00으로 옮김(켜 둔 사람의 시각은 그대로)
- [x] 테스트: SQL 휴지통 49 · 탈퇴 31 · 푸시 54 · 메일 25 (`tests/test_trash.sql`·`test_withdrawal.sql`·`test_push.sql`·`test_invite_mail.sql`), Edge Function `account_function.test.ts`·`push_send.test.ts`·`invite_mail.test.ts`, 동시성 (e), 원격 확인 16개(`tests/remote_jobs_smoke.sql`, 되돌림), 두 기기 검증 11-3·19·20 묶음 (로컬 70개 통과)
  - 일부러 망가뜨린 서버 코드 69가지 중 67가지 검출. 남은 2가지는 결과가 같은 것(내부 함수 권한 회수 한 줄, 이미 앞 단계가 막는 프로젝트 초대 상태 검사)

## 앱 연결 정보

```
SUPABASE_URL   = https://zcblwwcukkbcwmgugknl.supabase.co
PUBLISHABLE    = sb_publishable_mgBnoYrbmRRkhtykoMKEwg_mrf_sGvT   (공개용 키, 앱에 넣어도 됨)
OAuth Callback = https://zcblwwcukkbcwmgugknl.supabase.co/auth/v1/callback
```

> ⚠️ service_role 키, secret 키, OpenAI 키는 절대 앱이나 레포에 넣지 마세요.

**클라이언트 설정** (`@supabase/supabase-js`)

```ts
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const supabase = createClient(SUPABASE_URL, PUBLISHABLE, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});
```

**AI 호출 예시**

```ts
const { data, error } = await supabase.functions.invoke('ai-gateway/analyze', {
  body: {
    client_request_id: requestId,  // 재시도할 때는 같은 값 사용
    text: memoText,
    kind: 'MEETING',               // MEETING | MEMO
    timezone: 'Asia/Seoul',
  },
});
// data.draft → 초안. 사용자가 승인하면 sync_push로 저장
```

AI를 호출하기 전에 사용자의 외부 AI 동의(`consents`)가 있어야 합니다.

**월 한도 (FREE / PRO)**

| 기능 | FREE | PRO | TEAM |
|---|---|---|---|
| 가격 (월, 가짜 결제) | 0원 | 4,900원 | 9,900원 |
| 메모 정리 | 100 | 1000 | 1000 |
| 할 일·일정 추출 | 30 | 300 | 300 |
| 사진 → 글자 | 30 | 300 | 300 |
| AI 채팅 질문 | 50 | 500 | 500 |
| AI 채팅 검색 조건 (질문 수와 별도, 남용 방지) | 150 | 1500 | 1500 |
| 안건 논의 판단 | 50 | 500 | 500 |
| 녹음 → 글자 (분) | 60분 | 600분 | 600분 |
| 이번 달 프로젝트 초대 | 10 | 50 | 200 |
| 공간 첨부 용량 (공간 관리자 요금제) | 500MB | 2GB | 10GB |
| 백업 용량 | 200MB | 1GB | 1GB |

## 해야 할 것

**프론트 기준으로 맞춘 결정** (2026-11-15)
- 비밀번호 규칙: 영문+숫자+특수문자, 8자 이상 (화면 `checkPasswordRule`과 같음). Supabase 설정은 "8자 · Letters and digits" 그대로 두고, 특수문자는 앱 모듈(`login-rules.ts`)이 가입·재설정 전에 검사. Supabase에는 "영문+숫자+특수문자" 옵션이 없어서(특수문자를 고르면 대소문자까지 강제) 이렇게 나눔
- 로그인 5회 실패 → 10분 잠금은 **앱(기기)에서만**. 서버는 IP 기준 요청 제한만
- 공간 역할 이름: 관리자 = OWNER, 멤버 = EDITOR. 앱은 이 두 가지만 씀 (VIEWER는 서버에 남아 있지만 앱에서 만들지 않음)

**백엔드 (병욱)**
- [x] OpenAI 키 등록·실제 호출 확인 (11/14, 검증 74개 통과)
- [x] 긴 녹음(최대 3시간): 구간 업로드 → 서버 구간별 전사 → 전사문 → 녹음 삭제 (11/14 배포)
- [x] `/transcribe` 녹음 → 글자 (`gpt-transcribe`, 한도는 녹음 분 단위, 올리고 → 변환 후 삭제 · 실패하면 3일 보관) — 11/14 배포, 실제 호출은 키 등록 후 확인
- [x] `/ocr` 사진 → 글자 (Terra 이미지 입력) — 11/14 배포, 검증 15번 묶음으로 실제 확인
- [x] ~~AI 모드 선택 + 모델별 차감~~ → 모델을 Terra 하나로 줄여서 필요 없음 (11/14)
- [x] migration #22·#23(11/15 원격 직접 적용분)을 파일·로컬 테스트·앱 모듈에 반영 (11/15)
- [x] 가짜 결제 FREE ↔ PRO (11/15 배포, migration #24)
- [x] 프로젝트 팀원·프로젝트 초대 (11/15 배포, migration #25, 프론트 화면 기준)
- [x] 녹음 시각 보존(구간 2분 + `[12:00]` 표시, migration #26) · 문서 글자 추출(`doc-extract`) · 기기 PDF 내보내기(`pdf-export.ts`) (11/15, 슬라이드 20 ②·④)
- [x] AI 채팅(`/query/plan`·`/query/answer`) · 안건 논의 판단(`/agenda/judge`) (11/15 배포, ai-gateway v12, migration #27)
- [x] Team 요금제 9,900원 (11/15 배포, migration #28): AI 한도 = PRO, 초대 200회, 공간 첨부 10GB
- [x] 메모 즐겨찾기 · 프로젝트 파일 직접 연결 · 팀장 권한 · 백업·복원 (11/15 배포, migration #29~#31)
- [x] 공유 휴지통 · 회원 탈퇴 · 푸시 알림·브리핑 · 초대 메일 (11/15 배포, migration #32~#37, Edge Function account·push-send·invite-mail)
- [ ] **Secrets에 `SMTP_PASSWORD` 등록** (Gmail 앱 비밀번호, stella.app.noreply@gmail.com) → 초대 메일 실제 발송
- [ ] 데모 전에 프로젝트가 Active 상태인지 확인 (무료 플랜은 7일 동안 안 쓰면 일시 정지)

**프론트엔드**
- [ ] 공간 화면: 초대 만들기·공유(`createInvite` → `inviteShareText` → `Share.share`), 초대 목록·취소, 멤버 목록·역할 변경·내보내기, 나가기
- [ ] [공간 참여] 화면: 코드 입력 → `previewInvite`로 확인 → `acceptInvite` → `getSnapshot`. `invite?code=` 딥링크로 열렸을 때도 같은 화면으로
- [ ] `sync_pull`에서 `workspace_members` 변경을 받으면 기기의 멤버 목록 갱신. 내 공간에서 `FORBIDDEN`이 오면 나갔거나 내보내진 것 → 공간 닫기
- [ ] `app.json`의 `scheme`을 정해서 알려주기 → 병욱이 Supabase 리디렉트 URL에 등록
  - Google·Kakao 로그인은 `expo-auth-session`의 `makeRedirectUri()`로 만든 주소를 `signInWithOAuth`의 `redirectTo`에 넣고, `expo-web-browser`로 엽니다
  - Expo Go와 개발 빌드는 리디렉트 주소가 달라서 둘 다 등록해야 합니다
- [ ] 외부 AI 동의 화면, 녹음 전 동의 안내 화면
- [ ] `local-sync`로 공유 공간 연동 (기기 저장소는 `expo-sqlite`), 공간 화면에서 `watchWorkspace`로 실시간 받기
- [ ] 녹음 화면 (`expo-audio`): 경과 시간·일시정지·종료, 3시간이면 자동 종료. 설정은 `RECORDING_AUDIO`(m4a 모노 64kbps부터 품질 테스트)
- [ ] 분할 모듈 `modules/stella-audio-split`을 앱에 넣고 개발 빌드로 iPhone·Android에서 확인 (**연결·검증 필요**)
- [ ] 녹음 처리 화면: 진행률(`recordingProgressText`), 실패 구간 재시도, 취소, 전사문 확인·수정 → `analyzeMemo` → 저장 → `ackRecordingTranscript`
- [ ] 문서 가져오기 화면: 파일 고르기(`expo-document-picker`) → `extractDocumentText`(진행률) → `documentNoticeText` 안내 → 글자 확인·수정 → 메모 저장 또는 정리
- [ ] PDF 내보내기 화면: 항목 고르기 → 구역 함수로 묶기 → `exportPdf`(`expo-print`) → 공유 또는 `savePdfAttachment`
- [ ] AI 채팅 화면: `answerFromApp` 자리에 `askAssistant`(기기 SQLite에서 `ChatRecord`를 읽는 `findRecords` 필요). 클라우드·로컬 AI 모드를 한 화면에서 쓰면 팀 서버 응답과 모양 맞추기
- [ ] 메모 목록 즐겨찾기: `setFavorites` 자리에 `setNoteFavorites`, 목록 표시는 `listNoteFavorites`
- [ ] 프로젝트 상세 파일: 메모를 거치지 않고 `projectFileChanges.link/unlink/move` → `saveLocal`, 목록은 `projectFilesOf`
- [ ] 팀원 화면·프로젝트 수정 버튼: `canManageProject`(기기) 또는 `getProjectPermissions`(서버)로 보이기/숨기기, 충돌 `NOT_PROJECT_LEADER`는 `teamErrorMessage`로 안내 후 서버 값
- [ ] 백업 화면: `BackupStore` 자리에 `backup.ts` (`createBackup`·`listBackups`·`restoreBackup`·`deleteBackup`), 무작위 바이트는 `expo-crypto` `getRandomBytes`, 패키지 `@noble/ciphers` 추가
- [ ] 휴지통 화면: 메모만 → `trashItems`(listLocal에 `includeDeleted: true`)로 7가지, [복구] `trashChanges.restore`, [삭제] `trashChanges.purge`(버튼은 `canPurge`), 남은 날 `trashNoticeText`
- [ ] 회원탈퇴 화면(ROUTES.Withdraw): `getWithdrawPreview` 안내 → 확인 창 → `withdrawAccount` → 기기 데이터 삭제. 작성자 이름은 `authorName`(없으면 '탈퇴한 사용자')
- [ ] 알림: 로그인 후 `getExpoPushTokenAsync` → `registerPushToken`, 설정 > AI 및 브리핑 저장 때 `setNotificationSettings(briefingFromAiSettings(ai))`, 알림을 누르면 `notificationTarget`, 🔔는 `listNotifications`
- [ ] 초대 화면: 초대를 만든 직후 `sendInviteMail`, `shouldShareInstead(e)`면 지금처럼 공유 문구
- [ ] 안건 비교 화면: `AgendaJudge.js`의 `judgeDiscussion` 자리에 `judgeAgendaDiscussion`(그날 회의 메모·전사문을 `discussions`로)

**팀 결정 필요**
- [x] ~~회의 녹음에 화자 구분을 넣을지~~ → 넣지 않음 (11/15)
- [x] ~~AI 모델 선택 UI를 넣을지~~ → 클라우드 AI는 Terra 하나로 정함 (11/14)
- [x] ~~로컬 AI와 외부 AI 중 무엇을 기본으로 할지~~ → 프론트 화면대로: 설정의 '기기 내 AI 처리' 토글 값을 따름 (11/15)
- [x] ~~회원탈퇴 후 데이터 처리 정책~~ → 정한 대로 구현 (11/15, #33)
- [x] ~~탈퇴 전 다시 확인 방식~~ → 지금처럼 확인 창만 (비밀번호 재입력·재로그인 없음, 11/15)
- [x] ~~프로젝트 마감 알림 기준 시각과 브리핑 기본값~~ → 마감 알림은 그날 09:00(서울) 유지, 브리핑 기본은 일간 09:00·주간 월 09:00(둘 다 꺼짐) (11/15, #37)
- [x] ~~백업 키를 서버에 두는 방식 유지할지~~ → 지금처럼 서버 보관, 비밀번호로 한 번 더 감싸지 않음 (11/15)
- [x] ~~팀장이 한 명도 없는 프로젝트 규칙~~ → 지금처럼 편집자 누구나 관리 (11/15)
- [ ] 기기 SQLite 스키마를 서버 스키마와 맞추기 (병욱, 손주원)
