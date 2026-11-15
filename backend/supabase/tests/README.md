# DB 테스트 (로컬 Postgres)

Supabase 없이 로컬 Postgres 16+에서 migration 전체를 올리고 시나리오를 확인합니다. `bootstrap.sql`이 Supabase의 역할(anon·authenticated·service_role), `auth.users`·`auth.uid()`, Storage(`metadata` 크기 포함)·pg_cron·Realtime(`realtime.messages`·`send`·`topic`, 원격과 같은 정의)·Vault(`vault.create_secret`·`decrypted_secrets`)·pg_net(`net.http_post`) 자리를 흉내 냅니다.

```bash
# Postgres를 -p 54329 -k /tmp 로 띄운 뒤
./reset.sh ../migrations/*.sql                                        # DB 새로 만들고 migration 전부 적용
psql -h /tmp -p 54329 -U postgres -d stella -f test_invites.sql | grep -E "TOTAL|FAIL"   # 초대·멤버 시나리오 89개
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_realtime.sql | grep -E "TOTAL|FAIL"   # 실시간 신호 31개
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_assets.sql | grep -E "TOTAL|FAIL"     # 첨부 업로드 RPC 66개
deno test -A --no-check assets_function.test.ts                       # Edge Function assets (가짜 Storage + 로컬 DB)
deno test -A --no-check --config deno.test.json attachments_lib.test.ts   # 앱 모듈 attachments.ts ↔ 함수 (deno.test.json: {"imports":{"@supabase/supabase-js":"npm:@supabase/supabase-js@2"}})
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_ai_quota.sql | grep -E "TOTAL|FAIL"   # AI 한도 예약·정산(횟수·분, 채팅·안건 한도 #27) 45개
deno test -A --no-check gateway_e2e.test.ts                          # 진짜 ai-gateway/index.ts를 띄워서 정리·추출·회의 안건별 요약·강의 주요 개념·사진 글자(/ocr)·받아쓰기·AI 채팅(/query/plan·/query/answer: 인용 확인·멤버 아닌 공간 403)·안건 판단(/agenda/judge: 빠진 항목 재시도·근거 없으면 미논의) (가짜 Supabase·OpenAI, 포트 8000·54330) 14단계
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_stt_uploads.sql | grep -E "TOTAL|FAIL"   # 녹음 임시 보관함(준비·꺼내기·성공 삭제·실패 3일 보관·정리 대상·비밀값·cron) 29개
deno test -A --no-check transcribe_function.test.ts                  # ai-gateway /transcribe/prepare·/transcribe (가짜 OpenAI·Storage + 로컬 DB) 9단계
deno test -A --no-check stt_cleanup.test.ts                          # Edge Function stt-cleanup (비밀값, 기한 지난 녹음 삭제, Storage 오류)
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_stt_recordings.sql | grep -E "TOTAL|FAIL"   # 긴 녹음: 등록(구간 200개까지)·업로드 정책·확인·워커·재시도·취소·정리·권한 82개
deno test -A --no-check stt_worker.test.ts                           # Edge Function stt-worker (동시 2개, 저장 후 삭제, 실패·취소·한도·시간 예산) 8단계
deno test -A --no-check --config deno.test.json recordings_lib.test.ts   # 앱 모듈 recordings.ts ↔ SQL(Storage 정책 포함) ↔ stt-worker
deno test -A --no-check --config deno.test.json transcribe_lib.test.ts   # 앱 모듈 transcribe.ts(올리기·변환·재시도 계획) ↔ /transcribe
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_ui_fields.sql | grep -E "TOTAL|FAIL"   # 공간 설명·화면 칸·손글씨 형식·메모 복구(RESTORE, 6.6은 #32에 맞춰 바꿈) 70개
deno test -A --no-check --config deno.auth.test.json auth_rules_lib.test.ts   # 앱 모듈 login-rules.ts·auth.ts·invites.ts ↔ 화면 규칙 (비밀번호 규칙 40개 비교, 5회 잠금, 역할 이름. stubs/로 RN 대역, 가짜 Auth 포트 54333)
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_billing.sql | grep -E "TOTAL|FAIL"   # 가짜 결제: 구독·결제 실패 시연·재시도·해지 예약·해지 취소·기간 끝(FREE/자동 연장)·권한·Team(9,900원·PRO↔TEAM 변경·초대 200회·공간 첨부 10GB/백업 1GB) 70개
./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json billing_lib.test.ts   # 앱 모듈 billing.ts ↔ 결제 RPC (로컬 DB, RLS 그대로, Team 흐름·요금제 표 문구 포함)
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_project_team.sql | grep -E "TOTAL|FAIL"   # 프로젝트 팀원(만들기·수정·이동·삭제)·프로젝트 초대(메일·링크·한도·취소)·코드로 참여·팀장 준비(#30) 65개
./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json project_team_lib.test.ts   # 앱 모듈 project-team.ts ↔ 화면 규칙·초대 RPC
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_project_extras.sql | grep -E "TOTAL|FAIL"   # #29~#31 메모 즐겨찾기(사람마다·정리 트리거)·프로젝트 파일 직접 연결(연결·이동·권한·전체 받기)·팀장 권한(충돌 NOT_PROJECT_LEADER·초대·폴백)·백업(키·등록·보관 개수·목록·권한) 89개
./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json project_extras_lib.test.ts   # 앱 모듈 favorites.ts·project-team.ts(canManageProject = 서버)·backup.ts(암호화 → assets 함수 → 복원·자동 백업) 3단계
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_trash.sql | grep -E "TOTAL|FAIL"   # #32 공유 휴지통: 7가지 복구·영구 삭제 권한(관리자·지운 사람, 팀장 규칙)·연결 정리·원장·한 묶음·재전송·30일 자동 삭제 49개
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_withdrawal.sql | grep -E "TOTAL|FAIL"   # #33 회원 탈퇴: 미리 보기·OWNER 넘기기·혼자 공간 삭제·나가기·초대 취소·작성자 null·개인 기록 삭제·대시보드 삭제 31개
./reset.sh ../migrations/*.sql && deno test -A --no-check account_function.test.ts   # Edge Function account: 확인 문구·파일/로그인 계정 삭제 실패 뒤 이어서·파일 정리 5단계
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_push.sql | grep -E "TOTAL|FAIL"   # #34 푸시: 토큰·설정·마감/시작 알림(받는 사람)·공간 소식·녹음 끝·브리핑(시간대)·보내기·결과·알림함·기본 시각(#37) 54개
./reset.sh ../migrations/*.sql && deno test -A --no-check push_send.test.ts   # Edge Function push-send: 비밀값·100개씩·기기 여러 대·잘못된 토큰·Expo 실패 재시도 4단계
./reset.sh ../migrations/*.sql && psql -h /tmp -p 54329 -U postgres -d stella -f test_invite_mail.sql | grep -E "TOTAL|FAIL"   # #35 초대 메일: 확인·10분 재전송·하루 한도·프로젝트 mailed_at·정리 25개
./reset.sh ../migrations/*.sql && deno test -A --no-check invite_mail.test.ts   # Edge Function invite-mail: 설정 없음 503·권한·SMTP 실패·HTML 이스케이프·nodemailer 원문(한글) 6단계
./test_concurrency.sh                                                 # 동시 수락·저장·초대 생성, 결제 버튼 10번 동시에 → 결제 1번, 15명 동시 프로젝트 참여, 휴지통 자동 삭제 + 저장·영구 삭제 동시에 (e)
deno test -A --no-check --config deno.test.json doc_extract.test.ts      # Edge Function doc-extract: PDF(쪽·이어 읽기·시간 예산·스캔본·암호)·DOCX(표·쪽 나눔·변경 추적)·PPTX(순서·메모·숨김)·zip 폭탄·권한 23단계
deno test -A --no-check --config deno.test.json documents_lib.test.ts    # 앱 모듈 documents.ts ↔ doc-extract (50쪽씩 이어 부르기·진행률·오류 문구)
deno test -A --no-check --config deno.test.json pdf_export_lib.test.ts   # 앱 모듈 pdf-export.ts: 이스케이프·손글씨 SVG·날짜·구역·expo-print 호출·첨부 보관 + Chromium으로 실제 인쇄 → 글자 다시 읽기
deno test -A --no-check --config deno.test.json ai_assist_lib.test.ts    # 앱 모듈 ai-chat.ts·agenda-judge.ts ↔ assist.ts(서버 검사 그대로): 기록 고르기·발췌·한도·인사 바로 답·기록 없으면 답변 안 부름·화면 모양·캐시 17단계
```

문서 추출 테스트 파일은 `fixtures/docs/`에 있어요(`make_fixtures.py`로 다시 만들 수 있음: google-chrome·qpdf·python-docx·python-pptx 필요).

`remote_smoke.sql`은 원격 DB(SQL Editor)에서 실행하는 확인용입니다. 마지막에 일부러 오류를 내서 테스트 계정·공간이 남지 않고, 오류 메시지 `SMOKE_RESULT [...]`에 항목별 결과가 나옵니다.

`remote_realtime_smoke.sql`도 같은 방식이에요(실시간 신호 트리거·받기 권한 8개). Realtime이 한 번 연결된 뒤(날짜별 저장 공간이 생긴 뒤) 실행하세요.

`remote_assets_smoke.sql`은 첨부 업로드 RPC 확인용이에요(7개, Storage 없이 DB 판단만).

`remote_project_team_smoke.sql`은 프로젝트 팀원·초대 확인용이에요(11개: 팀장 저장·링크 초대·코드로 참여·팀원은 팀원 관리 불가(#30 충돌)·관리자가 역할 수정·이동·sync_pull·보기 전용 차단·전체 받기·원장 순번).

`remote_billing_smoke.sql`은 가짜 결제 확인용이에요(17개, Team 4개 포함: 구독·실패 시연·재시도·해지·해지 취소·기간 끝 연장/FREE·한도·권한·cron).

`remote_stt_segment_smoke.sql`은 #26 긴 녹음 구간 한도 확인용이에요(4개: 200개 등록·201개 거절·3시간 초과 거절·마지막 구간 경로/시각).

`remote_ai_quota_smoke.sql`은 AI 한도 예약·정산 확인용이에요(7개: 녹음 분 단위 예약·차감·거절·실패 환불, 기존 organize 호출 그대로).

`remote_extras_smoke.sql`은 #29~#31 확인용이에요(18개: 즐겨찾기 사람마다·팀장 권한표·팀원 수정 충돌·초대 차단·팀장 없는 프로젝트·프로젝트 파일 연결·이동·전체 받기·백업 키·등록·보관 개수·목록 권한·키 표 접근 차단·원장 순번).

`remote_jobs_smoke.sql`은 #32~#35 확인용이에요(16개: 공간 소식 알림·할 일 복구·영구 삭제·원장·cron 3개·마감 알림·알림 설정·보낼 목록 권한·SKIPPED·초대 메일 확인·권한·기록·탈퇴 미리 보기·탈퇴·작성자 null). 실제 메일·푸시는 보내지 않아요.
