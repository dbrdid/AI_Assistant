# `lib/stella`: 백엔드 연결 모듈 (React Native + Expo)

> 저장소 위치: `frontend/Frontend_UI/src/lib/stella/` (녹음 나누기 모듈은 `frontend/Frontend_UI/modules/stella-audio-split/`). 서버 쪽은 `backend/supabase/`. 아직 어떤 화면도 이 폴더를 import하지 않아요. 연결할 때 필요한 패키지는 아래 설치 안내를 따르세요.

로그인, 내 정보·동의, 기기 등록, 공유 공간, 동기화, AI를 한 곳에서 가져다 씁니다.

```ts
import { signInWithProvider, analyzeMemo, pushChanges, op, newId } from '@/lib/stella';
```

## 1. 설치

이 폴더를 앱의 `src/lib/stella/`에 복사하고 패키지를 설치합니다.

```bash
npx expo install @supabase/supabase-js @react-native-async-storage/async-storage react-native-url-polyfill \
  expo-auth-session expo-web-browser expo-crypto expo-linking expo-constants expo-sqlite
# PDF 내보내기·공유·파일 고르기를 쓸 때 (11/15)
npx expo install expo-print expo-sharing expo-document-picker expo-file-system
# 백업·복원을 쓸 때 (11/15, 기기에서 AES-256-GCM 암호화)
npm install @noble/ciphers@^1.3.0
```

`app.json`에 `"scheme": "stella"`(이름은 팀에서 정하기)를 넣으세요. 다음으로 아래 코드로 출력한 주소를 백엔드 담당에게 보내 Supabase Redirect URLs에 등록합니다. Expo Go와 개발 빌드는 주소가 다르니 둘 다 보내 주세요.

```ts
import { redirectTo } from '@/lib/stella';
console.log(redirectTo);   // 예: exp://192.168.0.5:8081/--/auth/callback, stella://auth/callback
```

## 2. 파일 구성

| 파일 | 내용 |
|---|---|
| `supabase.ts` | Supabase 클라이언트 (앱 전체에서 하나만) |
| `auth.ts` | 이메일 가입·로그인, Google·Kakao 로그인, 딥링크 처리 |
| `account.ts` | 프로필·설정 수정, 동의 기록·철회, 이번 달 AI 남은 횟수 |
| `devices.ts` | 기기 등록 (로그인 후 한 번) |
| `local-sync.ts` | 기기 SQLite 동기화: 보낼 목록, 받은 변경 반영, 전체 재동기화, 충돌 해결 (RN 의존 없음) |
| `sqlite-expo.ts` | expo-sqlite를 local-sync가 쓰는 모양으로 감싸기 |
| `realtime.ts` | 공유 공간 실시간 변경 신호 구독, 신호가 오면 자동으로 받기(`watchWorkspace`) (RN 의존 없음) |
| `attachments.ts` | 첨부·백업 올리기(준비 → 업로드 → 서버 확인), 보기 주소, 받기, 삭제, 오류 문구 (RN 의존 없음) |
| `transcribe.ts` | 녹음 올리기(임시 보관함) → 글자 초안(`gpt-transcribe`), 재시도 계획(`retryPlan`), 이번 달 사용 분, 나눠 녹음할 때 이어 받기, 오류 문구 (RN 의존 없음) |
| `recordings.ts` | **긴 녹음(최대 3시간)**: 구간 계획(기본 2분), 등록, 구간 업로드·이어 올리기, 진행 문구, 재시도·취소, 전사문 받기(구간마다 `[12:00]` 녹음 시각)·ack, 녹음 시간 표시 (RN 의존 없음) |
| `documents.ts` | **문서 → 글자**: PDF·Word(docx)·PowerPoint(pptx)에서 글자 꺼내기, 쪽·슬라이드 표시, 스캔본 안내, 오류 문구 (RN 의존 없음) |
| `pdf-export.ts` | **PDF 내보내기(기기에서)**: 메모·손글씨·할 일·일정·회의·전사문·문서 글자 → HTML → `expo-print`, 공유 공간 첨부로 보관 (RN 의존 없음) |
| `ai-chat.ts` | **AI 채팅(클라우드)**: 질문 → 검색 조건 → 기기 기록 고르기·발췌 → 답변·출처 (`askAssistant` 하나로), 오류 문구 (RN 의존 없음) |
| `agenda-judge.ts` | **안건 논의 판단**: 안건 비교 화면의 달라진 항목 + 그날 회의 메모·전사문 → 논의됨/미논의·근거 구절, 캐시 (RN 의존 없음) |
| `favorites.ts` | **메모 즐겨찾기(사람마다 따로)**: 켜기·끄기(500개씩 나눠 보냄), 내 즐겨찾기 목록(공간별), 오류 문구 (RN 의존 없음) |
| `trash.ts` | **공유 휴지통**: 휴지통 목록(7가지)·남은 날, 복구·영구 삭제 변경, 버튼 표시 규칙, 충돌 문구 (RN 의존 없음) |
| `withdraw.ts` | **회원 탈퇴**: 미리 보기(공간별 삭제·넘김·나가기), 탈퇴 실행, '탈퇴한 사용자' 이름, 오류 문구 (RN 의존 없음) |
| `push.ts` | **푸시 알림·브리핑**: Expo 토큰 등록, 알림 설정(화면 브리핑 값 변환), 알림 눌렀을 때 갈 화면, 알림함·읽음 (RN 의존 없음) |
| `invite-mail.ts` | **초대 메일**: 보내기, 오늘 남은 메일, 공유 문구로 보낼지, 오류 문구, '메일 보냄' 표시 (RN 의존 없음) |
| `backup.ts` | **백업·복원**: 계정 키 받기, 기기에서 암호화 → 올리기 → 등록(보관 개수), 목록, 받아 풀기, 복원(복원 전 자동 백업), 삭제, 오류 문구 (RN 의존 없음, `@noble/ciphers`) |
| `workspaces.ts` | 공유 공간 만들기·삭제, 내 공간·멤버 목록, 초대 만들기·취소·목록, 참여, 나가기, 역할 변경, 내보내기 |
| `invites.ts` | 초대 코드 읽기(입력·링크·공유 문구), 공유 문구 만들기, 역할 이름, 오류 문구 (RN 의존 없음) |
| `sync.ts` | 올리기(push), 받기(pull), 전체 받기(snapshot) |
| `ops.ts` | push에 보낼 변경(op) 만들기 |
| `ai.ts` | 메모 정리, 요약·할 일·일정 추출 (회의·강의·메모), 사진 → 글자(`ocrImages`) |
| `convert.ts` | AI 초안 → 승인 → 저장용 op 변환 (시간대 처리 포함), 정리 노트 본문(`analyzeDraftToNoteBody`) |
| `types.ts`, `database.types.ts` | 타입 (`database.types.ts`는 서버에서 자동 생성) |

## 3. 자주 쓰는 흐름

### 로그인

```ts
// 앱 최상단 (_layout.tsx): 이메일 인증 링크로 앱이 열렸을 때 로그인 완료
import * as Linking from 'expo-linking';
const url = Linking.useURL();
useEffect(() => { if (url?.includes('auth/callback')) completeSignInFromUrl(url).catch(showError); }, [url]);

// 로그인 버튼
await signInWithProvider('kakao');           // 취소하면 null

// ── 이메일 + 비밀번호 가입 → 메일 6자리 코드로 이메일 인증 (앱의 가입 → 인증번호 화면) ──
// 가입 화면 [다음]
const r = await signUpWithEmail(email, password, { displayName: '병욱', affiliation: '경영학과' });
if (r.needsVerification) goToVerifyScreen(email);          // 인증 메일 발송됨 (Confirm email 켜짐)
// 인증번호 화면 [확인]
const session = await verifyEmailCode(email, code);        // 성공 = 이메일 인증 + 로그인 완료
// 인증번호 화면 [다시 받기] (60초 뒤 활성화, 서버도 60초 제한)
await resendSignUpCode(email);

// 로그인 화면
try {
  await signInWithEmail(email, password);
} catch (e) {
  if (needsEmailVerification(e)) { await resendSignUpCode(email); goToVerifyScreen(email); }   // 인증 안 하고 나갔던 사람
  else if (e.code === 'login_locked') showLockedDialog(authErrorMessage(e));   // 🔒 "비밀번호 5회 불일치. 10분 후 다시 시도해주세요"
  else showError(authErrorMessage(e));
}

// 비밀번호 재설정: 코드 메일 → 코드 확인(임시 로그인) → 새 비밀번호
await sendPasswordReset(email);
await verifyPasswordResetCode(email, code);
await updatePassword(newPassword);

// 오류 문구: authErrorMessage(e) — 이미 가입된 이메일, 코드 틀림·만료, 비밀번호 규칙, 인증 전 로그인, 5회 잠금 등
// 비밀번호 규칙 (화면과 같음): checkPasswordRule(pw) — 영문+숫자+특수문자, 8자 이상. 안내 문구 PASSWORD_RULE_HINT
//   signUpWithEmail·updatePassword는 규칙에 안 맞으면 서버에 보내지 않고 weak_password 오류 (문구 PASSWORD_RULE_MESSAGE)
// 5회 실패 잠금 (화면과 같음): 같은 이메일로 5번 틀리면 10분 잠금. 이 기기 안에서만 세고(서버는 IP 기준 요청 제한만),
//   로그인 성공·비밀번호 재설정이면 풀림. 서버 오류·네트워크 오류는 세지 않음
// 코드 입력칸: <TextInput keyboardType="number-pad" maxLength={6} textContentType="oneTimeCode" autoComplete="one-time-code" />
// (선택) 비밀번호 없이 코드로만 로그인: sendEmailCode(email) → verifyEmailCode(email, code) — 지금 UI에서는 안 씀

// 로그인 후 한 번
const deviceId = await registerDevice({ appVersion: Constants.expoConfig?.version ?? '0.0.0' });
```

### 공간 만들기 · 초대 · 참여

```ts
import { Share } from 'react-native';

// [관리자] 공간 만들고 초대 보내기 (화면 역할 이름: 관리자 = OWNER, 멤버 = EDITOR → roleLabel(role))
const workspaceId = await createWorkspace('스텔라 팀', '캡스톤 6인 팀 공간');   // 설명은 선택, 120자까지
const inv = await createInvite(workspaceId, { maxUses: 5, expiresInHours: 72 });   // 앱은 멤버(EDITOR) 초대만
// inv.code는 지금만 받을 수 있음 (서버에는 해시만 저장) → 바로 공유하거나 화면에 보여주기
await Share.share({ message: inviteShareText({
  workspaceName: '스텔라 팀', code: inv.code, role: inv.role, expiresAt: inv.expires_at, url: inviteUrl(inv.code),
}) });

// 초대 목록·취소 (관리자에게만 보임)
const invites = await listInvites(workspaceId);        // 사용 가능한 것만. 사용 현황 = use_count / max_uses
await revokeInvite(invites[0].id);

// [받는 사람] 코드 입력 화면 또는 딥링크(invite?code=...)로 열렸을 때
const code = parseInviteCode(inputText);               // 직접 입력, 링크, 공유 문구 통째로 붙여넣기 모두 인식
if (!code) return showError('초대 코드를 다시 확인해 주세요');
try {
  const p = await previewInvite(code);                 // "관리자 Owner 님이 초대했어요 · 멤버 · 멤버 3명" (roleLabel(p.role))
  if (p.already_member) return openWorkspace(p.workspace_id);
  if (p.blocked) return showError('이 공간에서 내보내져서 이 초대로는 들어갈 수 없어요');
  // 확인 버튼을 누르면
  const r = await acceptInvite(code);
  const snap = await getSnapshot(r.workspace_id);      // 참여 직후 전체 받기
} catch (e) {
  showError(memberErrorMessage(e));                    // 만료·취소·인원 초과 등 화면 문구
}
```

초대 링크(`.../invite?code=...`)로 앱이 열릴 때:
- **Expo Router를 쓰면** `app/invite.tsx` 화면을 만들면 됩니다. 링크가 그 화면으로 바로 열리고 `useLocalSearchParams().code`로 코드를 받습니다. 코드 입력 화면과 같은 화면을 써도 됩니다.
- **React Navigation을 쓰면** 아래처럼 직접 처리합니다.

```ts
const url = Linking.useURL();
useEffect(() => { const c = parseInviteCode(url); if (url?.includes('invite') && c) navigation.navigate('Join', { code: c }); }, [url]);
```

### 멤버 관리

```ts
const members = await listMembers(workspaceId, { activeOnly: true });   // 멤버 화면·담당자 선택
await changeMemberRole(workspaceId, accountId, APP_ROLE['관리자']);     // 관리자만 (canManage(myRole)). 앱은 관리자↔멤버만
await removeMember(workspaceId, accountId);
// 공간 메뉴: isAdmin(myRole)이면 [삭제] deleteWorkspace, 아니면 [나가기] leaveWorkspace (WorkspaceScreen과 같은 기준)
await leaveWorkspace(workspaceId);   // 마지막 관리자면 LAST_OWNER → 다른 멤버를 관리자로 바꾸거나 deleteWorkspace
// 관리자 넘기기: changeMemberRole(ws, 상대, 'OWNER') → leaveWorkspace(ws) 또는 changeMemberRole(ws, 나, 'EDITOR')
```

다른 멤버의 참여·역할 변경·나가기는 `pullAll`의 변경 목록에 `entity: 'workspace_members'`로 옵니다(`data`는 `MemberChangeData`). 기기의 멤버 목록을 갱신하고, `data.account_id`가 나이고 `status`가 `ACTIVE`가 아니면 그 공간을 닫으세요. 내가 빠진 공간에서는 `pullAll`·`getSnapshot`이 `FORBIDDEN`을 냅니다.

### 외부 AI 동의 → 메모 분석 → 승인 → 저장

```ts
if (!(await hasConsent('EXTERNAL_AI'))) {
  // 동의 화면을 보여주고, 동의하면
  await grantConsent('EXTERNAL_AI', { provider: 'openai', features: ['organize', 'analyze'] });
}

const requestId = newId();   // 재시도할 때는 같은 값
const res = await analyzeMemo({ clientRequestId: requestId, text, kind: 'MEETING', workspaceId });
// res.draft.tasks / events / open_questions를 화면에 보여주고, 사용자가 고른 항목만 저장

const sourceId = newId(), versionId = newId(), noteId = newId();
const { ops, warnings } = analyzeDraftToOps(res.draft, {
  timezone: res.timezone, newId, noteId, sourceVersionId: versionId,
  members: await listMembers(workspaceId, { activeOnly: true }),  // 담당자 이름 → 멤버 매칭
  taskIndexes: [0, 2], eventIndexes: [0],         // 사용자가 체크한 것
});
// warnings(예: "종료 시각이 없어 60분으로 잡았습니다")는 사용자에게 보여주기

const receipt = await pushChanges(workspaceId, [
  ...sourceOps({ sourceId, versionId, kind: 'TEXT', confirmedText: text }),  // 원문 → 확정 원문
  op.create('notes', noteId, { title: res.draft.summary.slice(0, 40), body: text, source_id: sourceId, source_version_id: versionId }),
  ...ops,                                                                    // 할 일·일정
], { operationId: newId(), deviceId });
```

### 회의 녹음 → 회의록 (요약·안건별 정리·할 일)

회의 녹음의 전사문(아래 "긴 녹음"의 `getRecordingTranscript`)을 `analyzeMemo`에 **`kind: 'MEETING'`** 으로 한 번 보내면 회의록 초안이 와요. 강의면 `kind: 'LECTURE'`(주요 개념 `draft.key_concepts` 포함).

```ts
const transcript = (await getRecordingTranscript(supabase, recordingId)).text;   // 사용자가 고친 글 (60,000자 ≈ 3시간까지)
const res = await analyzeMemo({ clientRequestId: newId(), text: transcript, kind: 'MEETING', workspaceId });
res.draft.summary        // 회의 전체 요약 3~6문장
res.draft.topics         // 안건별: { title, points: 논의 내용, decisions: 결정 }
res.draft.tasks / events / decisions / open_questions   // 할 일·일정·결정 전체·확인할 점

// 사용자가 승인하면: 회의 → 안건 → 할 일·일정 순서로 한 번에
const meetingId = newId();
const { ops: agendaOps } = meetingTopicsToAgendaOps(res.draft, { meetingId, newId, topicIndexes: [0, 1] });  // 고른 안건만
const { ops: taskOps } = analyzeDraftToOps(res.draft, { timezone: res.timezone, newId, members, taskIndexes, eventIndexes });
await pushChanges(workspaceId, [
  op.create('meetings', meetingId, { title: '11/14 팀 회의', status: 'DONE' }),
  ...agendaOps,           // 안건 설명 = '- 논의 내용' 줄 + '결정: …' 줄, 상태 DISCUSSED
  ...taskOps,
], { operationId: newId(), deviceId });
```

- 60,000자(약 3시간)를 넘으면 `INPUT_TOO_LONG`이에요. 그보다 길면 앞뒤로 나눠 두 번 보내세요.
- 메모(`kind: 'MEMO'`)는 예전처럼 요약 1~3문장이고 `topics`는 빈 배열이에요.

### 수정·삭제 (공유 공간)

```ts
// base_revision = 기기 DB에 저장해 둔 마지막 revision
const r = await pushChanges(workspaceId, [op.update('tasks', taskId, 3, { status: 'DONE' })], { operationId, deviceId });
if (r.status === 'ACCEPTED') saveRevisions(revisionsFrom(r));            // 새 revision 저장
else showConflict(r.conflicts);   // REVISION_MISMATCH: 다른 사람이 먼저 고침 → server 값 보여주고 다시 시도
```

### 기기 SQLite 동기화 (`local-sync.ts`) — 공유 공간은 이걸 쓰세요

보낼 목록(outbox), 받은 변경 반영, 전체 재동기화, 충돌 해결을 한 번에 처리하는 기준 구현입니다. 아래 `pushChanges`·`pullAll`을 직접 쓰는 대신 이걸 쓰면 재전송·충돌·재동기화 규칙을 따로 만들 필요가 없습니다.

```ts
import * as SQLite from 'expo-sqlite';
import { expoSqliteDb, setupLocalSync, bindSyncAccount, supabaseTransport, newId,
         saveLocal, syncNow, listLocal, getSyncStatus, resolveConflict } from '@/lib/stella';

const db = expoSqliteDb(await SQLite.openDatabaseAsync('stella.db'));
await setupLocalSync(db);                                      // 앱 시작 때 한 번 (테이블 5개 생성)
await bindSyncAccount(db, userId);                             // 로그인 직후: 다른 계정이 쓰던 기기면 남은 기록·못 보낸 수정을 지움
const ctx = { db, transport: supabaseTransport, workspaceId, myAccountId: userId, newId };

// 저장: 기기에 먼저 → 화면에 바로 반영 (오프라인이어도 됨)
await saveLocal(ctx, [
  { kind: 'create', entity: 'notes', id: newId(), data: { title: '회의록', body: '...' } },
]);
await saveLocal(ctx, [{ kind: 'update', entity: 'notes', id: noteId, data: { body: '고친 내용' } }]);  // 바꾼 필드만
await saveLocal(ctx, [{ kind: 'delete', entity: 'tasks', id: taskId }]);                             // 휴지통
await saveLocal(ctx, [{ kind: 'restore', entity: 'notes', id: noteId }]);                            // 휴지통에서 복구 (메모만)
await saveLocal(ctx, [{ kind: 'link', entity: 'note_projects', data: { note_id, project_id } }]);

// 보내고 받기: 앱 켤 때, 당겨서 새로고침, 네트워크가 돌아왔을 때
const { flush, pull } = await syncNow(ctx);
if (flush.status === 'CONFLICT') showConflict(flush.outboxSeq, flush.conflicts);   // conflicts[i].server = 서버 현재 값
if (pull.status === 'CLOSED') closeWorkspace();                                     // 나갔거나 내보내짐

// 화면: 서버 값 + 안 보낸 내 수정이 합쳐진 값
const notes = await listLocal(db, workspaceId, 'notes');          // [{ data, pending, conflict }]
const status = await getSyncStatus(db, workspaceId);              // { pending, conflicts, failed, lastSeq }

// 충돌: 사용자가 고르면
await resolveConflict(ctx, outboxSeq, 'merge');       // 먼저 스스로 합쳐 봄 (다른 칸·다른 줄·다른 획). 못 합치면 CANNOT_MERGE
await resolveConflict(ctx, outboxSeq, 'keep_mine');   // 서버 최신 값 위에 내가 바꾼 필드만 다시 저장
await resolveConflict(ctx, outboxSeq, 'use_server');  // 내 수정 버리기
```

규칙:
- 한 번 보낸 묶음은 **같은 operation_id·같은 내용으로만** 다시 보냅니다. 응답을 못 받고 재전송해도 서버가 한 번만 저장합니다.
- 충돌·거절이 나면 **그 묶음에서 멈춥니다.** 뒤 묶음이 앞 묶음에 기대는 경우가 있어서예요.
- 받기와 전체 재동기화는 **서버 사본만 바꿉니다.** 안 보낸 내 수정은 그 위에 다시 얹어 보여주므로, 재동기화를 해도 지워지지 않습니다.
- 받은 데이터와 커서는 **같은 트랜잭션**에 저장합니다.
- 복구(`restore`)는 지금 **메모만** 됩니다. 두 기기가 같은 메모를 동시에 복구하면 늦은 쪽은 충돌이 나고, 이미 복구됐으므로 `keep_mine` 대신 `use_server`를 쓰세요 (`CANNOT_KEEP`). 복구하면서 내용도 고치려면 `restore` 다음에 `update`를 따로 넣으세요.
- **기기 DB는 한 계정 것입니다 (11/15).** `bindSyncAccount(db, accountId)`는 같은 계정이면 그대로 두고, 다른 계정이면 앞 계정의 공유 공간 기록·보낼 목록을 지운 뒤 `{ cleared, droppedOutbox }`를 돌려줍니다. 앞사람이 못 보낸 수정이 뒷사람 이름으로 올라가지 않게 하려는 것입니다. 로그아웃·탈퇴 때는 `clearLocalSync(db)`를 부르세요(먼저 `getSyncStatus`의 `pending`으로 못 보낸 수정이 있는지 알려 주세요). `backend/local`의 다리(`createBridge`)는 `accountId`를 넘기면 첫 동기화 전에 `bindSyncAccount`를 대신 부릅니다.
- **넘겨받는 묶음은 한 번만 (11/15).** `saveLocal(ctx, changes, { handoffKey })`: 같은 `handoffKey`로 다시 부르면 아무것도 더하지 않고 처음의 operation_id를 돌려줍니다. `backend/local`의 보낼 목록을 넘긴 직후 앱이 꺼져 같은 줄을 다시 넘겨도 중복이 생기지 않습니다. 화면에서 직접 부를 때는 `handoffKey` 없이 쓰면 됩니다.
- 한 묶음은 1~100개입니다. `backend/local`은 저장할 때 100개씩 나눠 적습니다.
- **충돌 스스로 합치기 (11/15).** 서버는 같은 기록을 두 기기가 고치면 칸이 달라도 충돌로 돌려줍니다. `resolveConflict(ctx, outboxSeq, 'merge')`는 서로 다른 칸, 본문·설명의 서로 다른 줄, 서로 다른 손글씨 획이면 둘 다 살려 다시 보낼 묶음으로 만듭니다. 같은 칸·같은 줄을 다르게 고쳤으면 `CANNOT_MERGE`(아무것도 바꾸지 않음)를 내고, 그때는 `keep_mine`·`use_server`·`keep_both`(본문은 내 줄 다음에 상대 줄, 한 줄 칸은 내 값) 가운데 사용자가 고릅니다. 합치는 기준은 보낼 내용을 고정한 때의 서버 값입니다. `listConflicts(db, workspaceId)`는 충돌 화면에 쓸 내용(어느 기록의 어느 칸이 `base`·`mine`·`server`로 어떻게 다른지, `mergeable`, `canKeep`)을 줍니다. `mergeText`·`mergeStrokes`도 따로 쓸 수 있습니다.
- **오류 알림 (11/15).** 보내기·받기가 `OFFLINE`일 때 `code`(`NETWORK`·`AUTH_REQUIRED` 등)와 `attempts`(그 묶음을 보낸 횟수)가 같이 옵니다. `getSyncStatus`는 `lastError`("CODE: 설명")와 `attempts`를 돌려줍니다. 로그인이 만료된 채 계속 실패하는 경우를 화면이 알 수 있습니다.
- 이 규칙들은 `stella-sync-verify` 검증(두 기기 흉내)으로 확인했습니다. 로컬 DB 50개(11/15, 복구·손글씨 포함), 실제 Supabase 45개 통과 (11/14).

### 프로젝트 팀원 · 초대 (`project-team.ts`, 11/15, 프론트 화면 기준)

```ts
import { teamChanges, newProjectChanges, membersOf, pendingInvites, wouldRemoveAllLeaders, createProjectInvite,
         getProjectInviteQuota, projectInviteShareText, teamErrorMessage, acceptInvite, saveLocal, syncNow, listLocal, newId } from '@/lib/stella';

// 프로젝트 만들기: 만든 사람 = 팀장
await saveLocal(ctx, newProjectChanges(newId(), { name: '발표 준비' }, { accountId: userId, name: myName, memberId: newId() }));

// 팀원 관리 화면 (TeamScreen)
const members = membersOf(await listLocal(db, ws, 'project_members'), projectId);   // project.members 자리 (id·name·role)
await saveLocal(ctx, teamChanges.edit(id, { name, role }));         // 이름 20자·역할 12자 (팀장·팀원·직접 입력)
await saveLocal(ctx, teamChanges.move(pickedIds, otherProjectId));  // [이동]
try { await saveLocal(ctx, teamChanges.remove(members, pickedIds)); }   // [삭제]
catch (e) { setNotice(teamErrorMessage(e)); }                       // 팀장을 모두 지우면 "팀장은 모두 삭제할 수 없어요"
await syncNow(ctx);
const invites = pendingInvites(await listLocal(db, ws, 'project_invites'), projectId);   // project.invites 자리 ("초대 대기", email 없으면 '링크 초대')

// 팀원 초대 화면 (ProjectInviteScreen)
const q = await getProjectInviteQuota(supabase);                    // "이번 달 남은 초대 횟수 q.remaining / q.limit회" (FREE 10 / PRO 50 / TEAM 200)
try {
  const inv = await createProjectInvite(supabase, projectId, { method, email });   // method: '메일' | '링크'
  await Share.share({ message: projectInviteShareText({ projectName: project.title, code: inv.code, expiresAt: inv.expires_at }) });
} catch (e) { setError(teamErrorMessage(e)); }                      // 이메일 형식·이번 달 횟수 초과·이미 초대함

// 초대받은 사람: 공간 참여 화면에서 코드 입력 → acceptInvite(code)
const r = await acceptInvite(code);   // 공간 참여 + 초대받은 프로젝트에 '팀원'으로 (r.projects). 이미 공간 멤버여도 됨
```

- **팀장만 프로젝트를 관리해요 (11/15, #30).** 프로젝트 이름·설명 수정·삭제, 팀원 추가·수정·이동·삭제, 프로젝트 초대는 **공간 관리자 또는 그 프로젝트의 '팀장'(계정 연결된)**만. 계정 연결된 팀장이 없는 프로젝트는 예전처럼 멤버 누구나. 메모·할 일·파일 연결은 멤버 누구나. 다른 역할 이름(팀원·디자이너 등)은 이름표예요.

```ts
import { canManageProject, getProjectPermissions, isLeaderConflict } from '@/lib/stella';
// 버튼 보이기/숨기기 (기기에서 계산, 서버와 같은 규칙)
const canManage = canManageProject({ me: userId, myRole, members });   // members = membersOf(...) 그 프로젝트
// 또는 서버에서 한 번에: { [projectId]: true|false }
const perms = await getProjectPermissions(supabase, ws);
// 오프라인에서 저장했는데 권한이 없었으면: 오류가 아니라 충돌로 돌아옴 → 서버 값으로 되돌리고 안내
const r = await flushOutbox(ctx);
if (r.status === 'CONFLICT' && r.conflicts.some(isLeaderConflict)) {
  await resolveConflict(ctx, r.outboxSeq, 'use_server');
  setNotice(teamErrorMessage({ code: 'NOT_PROJECT_LEADER' }));   // "프로젝트 팀장만 할 수 있어요. 바꾼 내용은 되돌려졌어요"
}
```
- 팀원 이름은 프로젝트 안에서만 쓰는 표시 이름이에요. 초대로 들어온 사람은 처음에 프로필 이름이 들어가고, 화면에서 고치면 그 프로젝트에서만 바뀌어요.
- **메일 초대는 만든 직후 `sendInviteMail`로 보내요** (아래 '초대 메일'). 메일 설정 전에는 공유 문구로.
- 공간 보기 전용 멤버는 팀원 편집·초대를 할 수 없어요 (`FORBIDDEN`).

### 프로젝트에 파일 직접 연결 (`project-team.ts`, 11/15, #29)

메모를 거치지 않고 공유 공간 첨부를 프로젝트에 바로 연결해요 (ProjectDetailScreen `linkItems`의 파일 자리). 멤버 누구나 할 수 있어요.

```ts
import { uploadAttachment, projectFileChanges, projectFilesOf, projectOfFile } from '@/lib/stella';
const asset = await uploadAttachment(supabase, { workspaceId: ws, assetId: newId(), bytes, mimeType, name });
await saveLocal(ctx, projectFileChanges.link(projectId, asset.id));         // 연결 (position 선택)
await saveLocal(ctx, projectFileChanges.unlink(projectId, asset.id));       // 연결 끊기 (파일은 남음)
await saveLocal(ctx, projectFileChanges.move(asset.id, fromId, toId));      // 다른 프로젝트로
const files = projectFilesOf(await listLocal(db, ws, 'project_files'), projectId);   // { project_id, asset_id, position, added_by, added_at }
```

- 같은 공간의 올리기가 끝난(AVAILABLE) 첨부만 연결돼요. 첨부를 지우면 연결 목록에 "삭제된 첨부"로 보여 주세요.

### 메모 즐겨찾기 (`favorites.ts`, 11/15, #29)

**사람마다 따로예요.** 내가 별표한 메모가 다른 멤버에게는 별표로 보이지 않아요. 내 다른 기기에서는 같은 목록이 보여요(동기화 원장이 아니라 목록 RPC로 받음).

```ts
import { favoriteAction, setNoteFavorites, listNoteFavorites, favoriteErrorMessage } from '@/lib/stella';
// MemoListScreen setFavorites 자리
const add = favoriteAction(selected) === 'add';   // 고른 메모가 전부 별표면 해제, 아니면 추가 (화면 규칙)
const { noteIds } = await setNoteFavorites(supabase, ws, selected.map((m) => m.id), add);   // 500개 넘으면 나눠 보냄
const favs = await listNoteFavorites(supabase, ws);   // Set<noteId> → 목록의 favorite 표시
```

- 개인 공간(서버에 없는 메모)은 기기 SQLite에만 두세요. 공간에서 나가면 그 공간 즐겨찾기는 서버가 지워요.

### 백업 · 복원 (`backup.ts`, 11/15, #31)

설정 > 백업(BackupStore 자리). 개인 공간 기록을 **기기에서 암호화**해서 올려요. 키는 계정마다 하나라서 새 기기에서도 로그인만 하면 복원돼요.

```ts
import * as Crypto from 'expo-crypto';
import { createBackup, listBackups, restoreBackup, deleteBackup, backupErrorMessage, newId } from '@/lib/stella';
const deps = {
  newId, randomBytes: (n: number) => Crypto.getRandomBytes(n),
  digest: (b: Uint8Array) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, b),
  deviceName: Device.deviceName, appVersion: Application.nativeApplicationVersion,
};
// [지금 백업하기]
const { backup } = await createBackup(supabase, { data: personalData, counts: { memos, tasks, projects }, deps });   // 보관 10개(keep), 넘으면 오래된 것 삭제
// 목록: created_at · counts · device_name · auto("자동") · size_bytes
const list = await listBackups(supabase);            // 'new' 최신순 / 'old'
// [복원]: 고른 백업을 먼저 풀어 보고 → 지금 상태를 "자동" 백업 → apply
await restoreBackup(supabase, { backup: list[0], currentData: personalData, currentCounts, deps, apply: async (data) => { /* 기기 SQLite 바꾸기 */ } });
await deleteBackup(supabase, backupId);
// 오류: backupErrorMessage(e) — 용량 초과·키 없음·손상·더 새 버전 백업·복원 전 저장 실패
```

- 백업 용량: FREE 200MB · PRO·TEAM 1GB. 파일 하나 50MB까지.
- 공유 공간 기록은 서버에 이미 있으니 백업에 넣지 않아도 돼요.
- 키는 서버에 보관해요(앱에서는 `backup_key` RPC로만 받음). 서버 파일만으로는 못 풀지만, DB 관리자는 이론상 풀 수 있어요 — 더 막을지는 팀 결정.

### 공유 휴지통 (`trash.ts`, 11/15, #32)

TrashScreen(지금은 메모만)을 7가지(메모·할 일·일정·프로젝트·회의·안건·팀원)로. 쓰기는 `saveLocal`이라 오프라인에서도 돼요.

```ts
import { trashItems, trashChanges, canPurge, canRestore, trashNoticeText, trashConflictMessage, listLocal, saveLocal, syncNow } from '@/lib/stella';
const all = (e: string) => listLocal(db, ws, e, { includeDeleted: true });   // ⚠️ 기본은 휴지통 기록을 빼고 줌
const items = trashItems({ notes: await all('notes'), tasks: await all('tasks'), events: await all('events'), projects: await all('projects') });
// 줄마다: item.title · `삭제 ${formatMD(item.deletedAt)}` · trashNoticeText(item) ("12일 뒤 자동으로 영구 삭제돼요")
await saveLocal(ctx, trashChanges.restore(selected));   // [복구] 멤버 누구나 (팀장 있는 프로젝트는 팀장·관리자)
if (selected.every((i) => canPurge({ me: userId, myRole, item: i }))) await saveLocal(ctx, trashChanges.purge(selected));   // [삭제] 관리자·지운 사람
const r = await flushOutbox(ctx);
if (r.status === 'CONFLICT') { setNotice(trashConflictMessage(r.conflicts[0]?.reason)); await resolveConflict(ctx, r.outboxSeq, 'use_server'); }
```

- 30일이 지나면 서버가 자동으로 영구 삭제해요(매일 03:17). 영구 삭제하면 다른 기기에서도 사라지고, 그 기록을 가리키던 할 일·일정은 남고 연결만 끊어져요.
- 프로젝트를 영구 삭제하면 팀원·초대·파일 연결도 같이 지워져요 (할 일·일정·회의는 '프로젝트 없음'으로 남음).

### 회원 탈퇴 (`withdraw.ts`, 11/15, #33)

설정 > 회원탈퇴(ROUTES.Withdraw, 화면은 아직 없음).

```ts
import { getWithdrawPreview, withdrawPreviewText, withdrawAccount, withdrawErrorMessage, authorName } from '@/lib/stella';
const preview = await getWithdrawPreview(supabase);   // 공간마다: DELETE(혼자라 삭제) · TRANSFER(누구에게 관리자) · LEAVE
preview.map(withdrawPreviewText);                      // "'팀 공간'의 관리자는 김OO님에게 넘어가요"
// 확인 창("탈퇴할까요?")에서 [탈퇴]를 누르면 → (11/15 결정: 비밀번호 재입력·재로그인은 하지 않음)
try { await withdrawAccount(supabase); /* 기기 SQLite·AsyncStorage 지우고 로그인 화면으로 */ }
catch (e) { setError(withdrawErrorMessage(e)); }       // 파일·로그인 계정 삭제가 실패하면 [다시 시도] → 이어서 처리
// 공유 기록의 작성자: authorName(row.created_by, 멤버 이름표) → 탈퇴했으면 '탈퇴한 사용자'
```

- 공유 기록은 남고 작성자만 '탈퇴한 사용자'로 보여요. 개인 공간 기록은 기기에만 있으니 앱이 지워 주세요.

### 푸시 알림 · 브리핑 (`push.ts`, 11/15, #34)

```ts
import * as Notifications from 'expo-notifications';
import { registerPushToken, disablePushToken, setNotificationSettings, briefingFromAiSettings, notificationTarget, listNotifications, markNotificationsRead, unreadCount } from '@/lib/stella';
// 로그인 후 (deviceId = registerDevice 결과)
const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
await registerPushToken(supabase, deviceId, token);           // 로그아웃 전에는 disablePushToken
// 설정 > AI 및 브리핑 [저장] 때 (화면 값 그대로: '오전 7:30', '금')
await setNotificationSettings(supabase, briefingFromAiSettings({ daily: ai.daily, weekly: ai.weekly }));
// 설정 > 알림
await setNotificationSettings(supabase, { push: true, workspace: true, recording: true, reminders: false });
// 알림을 눌렀을 때
Notifications.addNotificationResponseReceivedListener((r) => {
  const t = notificationTarget(r.notification.request.content.data);   // { route: 'Briefing' | 'TaskEdit' | 'ProjectDetail' | 'Workspace' | 'Notices', params }
  navigation.navigate(t.route, t.params);
});
// 홈의 🔔 (Notices)
const items = await listNotifications(supabase); const badge = unreadCount(items); await markNotificationsRead(supabase);
```

- 서버가 보내는 것: 공유 공간 할 일 마감·일정 시작·프로젝트 마감 전(`reminder_minutes`, 프로젝트 팀원에게, 팀원이 없으면 공간 멤버 모두), 새 멤버, 긴 녹음 변환 끝, 브리핑 시각.
- **개인 할 일·일정 알림은 지금처럼 기기 로컬 알림**이에요 (서버에 기록이 없어서).
- 브리핑 기본값은 일간 09:00 · 주간 월요일 09:00이고 둘 다 꺼져 있어요 (#37, 11/15).
- 브리핑 푸시는 "오늘의 브리핑" 안내만 와요. Briefing 화면이 기기의 개인+공유 기록으로 내용을 만들어요.
- 패키지: `npx expo install expo-notifications expo-device` (Android는 알림 채널 `default`)

### 초대 메일 (`invite-mail.ts`, 11/15, #35)

```ts
import { sendInviteMail, shouldShareInstead, inviteMailErrorMessage, inviteMailBadge } from '@/lib/stella';
const inv = await createProjectInvite(supabase, projectId, { method: '메일', email });
try { await sendInviteMail(supabase, { code: inv.code }); setNotice(`${email}로 초대 메일을 보냈어요`); }
catch (e) {
  if (shouldShareInstead(e)) await Share.share({ message: projectInviteShareText({ projectName, code: inv.code, expiresAt: inv.expires_at }) });
  else setError(inviteMailErrorMessage(e));
}
// 공간 초대도 같음: sendInviteMail(supabase, { code, email })
// "초대 대기" 줄: inviteMailBadge(invite) → '메일 보냄' | '메일 안 보냄'
```

- 서버에 메일 설정(`SMTP_PASSWORD`)이 들어가기 전에는 `MAIL_NOT_CONFIGURED` → 공유 문구로 보내 주세요.
- 한 사람 하루 30통, 같은 초대·같은 주소는 10분에 한 번.

### 구독 관리 · 가짜 결제 (`billing.ts`, 11/15)

```ts
import { getSubscription, changePlan, cancelSubscription, planId, nextPaymentText, planOptionText, billingErrorMessage, newId } from '@/lib/stella';

// 구독 관리 화면
const sub = await getSubscription(supabase);
PLANS[planId(sub)].name;                 // 'free' | 'pro' | 'team' → 화면의 PLANS 키
nextPaymentText(sub);                    // "2026년 12월 15일 · 9,900원" / "12월 15일부터 무료 요금제로 바뀌어요" / "-  (무료 요금제는 결제가 없어요)"
const paid = sub.plan !== 'FREE';        // [구독 해지] 버튼 활성화

// 요금제 선택 모달에서 고르면 (requestId는 누를 때 한 번 만들고, 실패해서 다시 보낼 때는 같은 값)
try {
  const r = await changePlan(supabase, id, { requestId });   // id: 'free' | 'pro' | 'team'
  if (!r.ok) setPayFailed(true);                            // PAYMENT_DECLINED → PaymentFailedDialog
  else refresh();                                           // SUBSCRIBED · CHANGED(PRO↔TEAM) · RESUMED · ALREADY_ACTIVE · CANCEL_SCHEDULED · ALREADY_FREE
} catch (e) { notice.show(billingErrorMessage(e)); }

// 요금제 선택 목록의 설명 줄 (서버 값으로): PLAN_INFO 대신 또는 옆에
planOptionText(sub, 'team');             // "월 9,900원 · 초대 월 200회 · 공간 첨부 10GB"
sub.plans.TEAM;                          // { price_krw, project_invites_per_month, workspace_storage_bytes, backup_storage_bytes, ai: {...} }

// [구독 해지] 확인
await cancelSubscription(supabase);      // 다음 결제일까지 지금 요금제(PRO·TEAM), 그 뒤 FREE

// 결제 실패 화면 시연: changePlan(supabase, 'pro', { requestId, simulateDecline: true })
```

- 가짜 결제예요. 카드 입력 없이 바로 결제된 것으로 처리하고 `payments`에 기록만 남겨요 (`listPayments`로 내역 조회).
- 결제·해지하면 서버 AI 한도가 바로 바뀌어요. 이용량 화면은 `getAiUsage()`를 다시 부르세요.
- 해지 예약 중에 같은 요금제를 다시 고르면 결제 없이 해지가 취소돼요.
- **Team (월 9,900원, 11/15)**: AI 한도는 PRO와 같고, 이번 달 프로젝트 초대 200회(PRO 50·FREE 10), 내가 관리자인 공간의 첨부 용량 10GB(PRO 2GB·FREE 500MB). 공간 인원 한도는 없어요.
- PRO ↔ TEAM은 고르는 즉시 바뀌고 오늘부터 새 한 달로 가짜 결제해요(`r.action === 'CHANGED'`, `r.previous_plan`). 남은 기간 일할 계산은 없어요(시연용).
- 이용량 화면(`AiUsageScreen`)의 초대 한도 `MONTHLY_INVITES`는 `getProjectInviteQuota()`의 `limit`으로 바꾸면 요금제에 따라 바뀌어요.

### 화면 칸 · 손글씨 (11/15 서버 반영)

```ts
// 프로젝트: status는 보관 상태(ACTIVE·ARCHIVED), 진행 상태는 progress_status
{ kind: 'create', entity: 'projects', id, data: { name: '발표 준비', progress_status: 'IN_PROGRESS', due_date: '2026-11-30',
  priority: 2, reminder_minutes: 1440, assignee_name: '병욱', location: '공학관 301' } }
// 할 일: 알림·담당자 이름(표시용)·장소 / 일정: 상태(TODO·IN_PROGRESS·DONE·CANCELED)·중요도·알림·담당자 이름
{ kind: 'update', entity: 'events', id, data: { status: 'DONE', reminder_minutes: 10 } }
// 메모 손글씨: 화면 InkCanvas 형식 그대로. 안 보내면 그대로, [] 보내면 모두 지움
{ kind: 'update', entity: 'notes', id, data: { strokes: [{ id: 's1', c: '#111111', w: 2.5, p: [[10, 20], [11, 21]] }] } }
```

- `assignee_name`은 화면 표시용 글자예요. 권한이나 계정과는 상관없고, 할 일의 실제 담당자 배정은 `assignee_id`(공간 멤버)예요.
- 알림 칸(`reminder_minutes`)은 저장만 돼요. 개인 기록 알림은 기기 로컬 알림으로 보내 주세요.
- 손글씨는 서버가 형식을 검사해요 (`Stroke` 타입 주석 참고, 메모 하나 1MiB까지). 틀리면 `flush.status === 'BLOCKED'`, `code === 'CHECK_FAILED'` → `discardOutbox`로 버리기.
- 서버에서 받은 손글씨 객체는 키 순서가 바뀌어 있어요(`{c,p,w,id}`). 값은 같으니 키로 읽으면 됩니다.
- 프로젝트·일정의 `priority`에는 `null`을 보내지 마세요 (`REQUIRED_FIELD`). 0~3만 받아요.

### 실시간 변경 신호 (`realtime.ts`)

다른 기기에서 공유 공간에 저장하면 서버가 **"바뀌었다"는 신호만** 보냅니다. 데이터는 신호에 없고, `watchWorkspace`가 신호를 받으면 알아서 `pullWorkspace`로 받아 SQLite에 반영합니다.

```ts
import { supabase, watchWorkspace } from '@/lib/stella';

// 공유 공간 화면에 들어올 때
const stop = watchWorkspace(supabase, ctx, {
  onPulled: (out) => {
    if (out.status === 'CLOSED') closeWorkspace();   // 나감·내보내짐·공간 삭제
    else refreshList();                              // listLocal로 다시 그리기
  },
  onStatus: (s) => setLive(s === 'connected'),       // (선택) "실시간 연결됨" 표시
});
// 화면을 떠날 때 (useEffect cleanup)
stop();
```

- 신호가 여러 개 몰려도 한 번에 묶어서 받고, 이미 받은 순번의 신호는 무시합니다.
- 연결되거나 다시 연결될 때 바로 한 번, **5초 뒤에 한 번 더** 받습니다(끊긴 동안 놓친 신호 대비).
  - 5초 뒤 받기가 필요한 이유: 한동안 아무도 연결하지 않아 Realtime 서버가 쉬고 있었다면, 첫 연결 뒤 1~2초는 "연결됨"이어도 서버가 아직 DB 신호를 못 읽어서 그 사이 신호가 빠져요(11/14 원격 검증에서 실제로 확인). 시간은 `catchUpMs`로 바꿀 수 있어요(0이면 안 함).
- 신호는 빨리 알려 주는 장치일 뿐이라 놓칠 수 있어요. **앱이 앞으로 나올 때·당겨서 새로고침할 때는 계속 `syncNow`를 부르세요.**
- 그 공간의 ACTIVE 멤버만 구독할 수 있고(서버 권한), 앱은 신호를 보낼 수 없습니다.
- 신호만 직접 받고 싶으면 `subscribeWorkspace(supabase, workspaceId, { onSignal, onStatus })`를 씁니다. 신호: `{ type: 'changed', workspaceId, lastSeq }` 또는 `{ type: 'closed', workspaceId }`.

### 첨부 파일 (`attachments.ts`)

사진·녹음·PDF·문서를 공유 공간에 올립니다. 서버가 업로드된 파일의 **크기·SHA-256·형식을 직접 다시 재서** 확인한 뒤에만 다른 사람에게 보입니다.

```ts
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';           // SDK 54+ 새 파일 API (앱에서 연결·검증 필요)
import { supabase, newId, uploadAttachment, getAttachmentUrl, deleteAttachment,
         saveLocal, canRetryUpload, attachmentErrorMessage } from '@/lib/stella';

const assetId = newId();                           // 기기 DB에 파일 경로와 함께 저장해 두면 재시도할 때 그대로 씀
const bytes = await new File(fileUri).bytes();     // Uint8Array
try {
  const asset = await uploadAttachment(supabase, {
    workspaceId, assetId, bytes, mimeType: 'image/jpeg', name: '회의 사진.jpg',
    digest: (b) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, b),
  });
  // 메모에 붙이기 (다른 기기에도 동기화됨)
  await saveLocal(ctx, [{ kind: 'link', entity: 'note_attachments', data: { note_id: noteId, asset_id: asset.id, position: 0 } }]);
} catch (e) {
  if (canRetryUpload(e.code)) { /* 나중에 같은 assetId로 다시 */ } else { /* 새 assetId로 처음부터 */ }
  showToast(attachmentErrorMessage(e));
}

// 보기: 1시간짜리 주소 (공간 멤버만 발급)
const url = await getAttachmentUrl(supabase, asset);    // <Image source={{ uri: url }} /> 등
// 삭제: 올린 사람 또는 공간 소유자
await deleteAttachment(supabase, asset.id);
```

- 올릴 수 있는 것: 사진(`image/*`), 녹음(`audio/*`), PDF, 텍스트, Word·PowerPoint·Excel. **파일 하나 50MB, 공간마다 합계는 공간 관리자 요금제 기준 FREE 500MB · PRO 2GB · TEAM 10GB** (백업은 FREE 200MB · PRO·TEAM 1GB). 넘으면 `QUOTA_EXCEEDED`, `attachmentErrorMessage`가 서버가 준 용량으로 문구를 만들어요.
- 다른 기기는 `sync_pull`로 `assets` 변경을 받고(`listLocal(db, ws, 'assets')`), 메모 연결은 `note_attachments`로 받습니다.
- 삭제된 첨부는 `deleted_at`이 있고 주소를 받을 수 없어요. 메모 연결은 남아 있으니 "삭제된 첨부"로 보여 주세요.
- 업로드 순서는 **파일 먼저, 메모 연결은 업로드가 끝난 뒤**예요. 서버는 확인이 끝난(AVAILABLE) 첨부만 메모에 연결해 줍니다.
- 녹음 → 글자(`transcribeAudio`)는 이 첨부 업로드가 아니라 녹음 전용 임시 보관함에 올려요(아래, 변환 후 삭제). 공유 공간에 녹음 파일도 남기고 싶을 때만 첨부로 따로 올리세요.

### 사진 → 글자 (`ocrImages`, Terra가 사진을 직접 읽음)

판서·필기·문서·슬라이드 사진을 글자 **초안**으로 바꿔요. 사진과 결과는 서버에 남지 않아요. 한 번에 1~5장(고른 순서 = 쪽 순서), 월 FREE 30회 / PRO 300회.

```ts
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';   // (앱에서 연결·검증 필요)
import { supabase, newId, ocrImages, aiErrorMessage, analyzeMemo, OCR_LIMITS } from '@/lib/stella';

const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: OCR_LIMITS.maxImages });
if (picked.canceled) return;
// 긴 변 2048px JPEG로 줄여서 base64로 (HEIC도 여기서 JPEG로 바뀜, 한 장 약 0.5~1.5MB)
const images = await Promise.all(picked.assets.map(async (a) => {
  const ctx = ImageManipulator.manipulate(a.uri);
  if (Math.max(a.width, a.height) > OCR_LIMITS.recommendedMaxSide) {
    ctx.resize(a.width >= a.height ? { width: OCR_LIMITS.recommendedMaxSide } : { height: OCR_LIMITS.recommendedMaxSide });
  }
  const img = await (await ctx.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  return img.base64!;
}));
try {
  const r = await ocrImages({ clientRequestId: newId(), images, hint: '강의 판서', workspaceId });
  // r.draft.text: 사진 속 글 그대로 (여러 장이면 "--- 2쪽 ---"), r.draft.unclear_parts: 흐린 곳 → 사용자에게 표시
  // r.draft.has_text === false면 "글자를 찾지 못했어요"
  const edited = await openTextEditor(r.draft.text);       // 사용자가 확인·수정
  // 저장: 원문 input_sources(kind 'IMAGE', original_text: r.draft.text) → 확정본 source_text_versions(edited) → 노트
  // 할 일·일정이 필요하면: await analyzeMemo({ clientRequestId: newId(), text: edited, kind: 'LECTURE' })
} catch (e) {
  showToast(aiErrorMessage(e));   // TOO_LARGE·TOO_MANY_IMAGES·UNSUPPORTED_TYPE·QUOTA_EXCEEDED·CONSENT_REQUIRED 등
}
```

- 실패해도 같은 `clientRequestId`로 다시 보내면 한 번만 처리돼요(`canRetryWithSameRequestId`).
- 원본 사진을 공유 공간에 남기고 싶으면 첨부(`attachments.ts`)로 따로 올리고 `input_sources.asset_id`에 연결하세요.

### 문서 → 글자 (`documents.ts`, PDF·Word·PowerPoint, 11/15)

PDF·Word(docx)·PowerPoint(pptx)에서 글자를 꺼내 **초안**으로 보여 줘요. 문서는 서버에 저장되지 않고 **외부 AI로도 가지 않아요**(Edge Function `doc-extract`가 글자만 꺼냄) → 외부 AI 동의·AI 사용 횟수와 무관해요.

| 입력 | 한도 | 쪽 표시 |
|---|---|---|
| 공유 공간 첨부 `{ assetId }` (공간 멤버만) | 20MB | PDF `--- 3쪽 ---` |
| 기기 파일 `{ bytes, mimeType, fileName }` | 10MB (더 크면 첨부로 올린 뒤 assetId) | PowerPoint `--- 슬라이드 3 ---` (+ `[발표자 메모] …`) |
| PDF는 서버가 한 번에 50쪽씩 읽고 `extractDocumentText`가 끝까지 이어 불러요 | 기본 2000쪽까지 (`maxPages`) | Word `--- 약 3쪽 ---` (Word가 저장할 때 남긴 쪽 표시가 있을 때만, 대략) |

```ts
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { supabase, extractDocumentText, documentNoticeText, documentErrorMessage, isExtractableDocument, DOCUMENT_MIME } from '@/lib/stella';

const pick = await DocumentPicker.getDocumentAsync({ type: Object.values(DOCUMENT_MIME) });
if (pick.canceled) return;
const f = pick.assets[0];
if (!isExtractableDocument(f.mimeType, f.name)) return showToast('PDF·Word·PowerPoint만 읽을 수 있어요');
try {
  const doc = await extractDocumentText(supabase, { bytes: await new File(f.uri).bytes(), mimeType: f.mimeType, fileName: f.name },
    { onProgress: ({ done, total }) => setProgress(`${total}쪽 중 ${done}쪽 읽음`) });
  documentNoticeText(doc).forEach(showToast);   // 스캔본(글자 없음)·빈 쪽·잘림·Word 쪽 번호는 대략
  const edited = await openTextEditor(doc.text);  // 사용자가 확인·수정 → 메모로 저장하거나 analyzeMemo / organizeMemo
} catch (e) {
  showToast(documentErrorMessage(e));             // 암호 PDF, 손상, 지원 안 하는 형식(옛 doc·ppt), 크기
}
// 공유 공간 첨부를 읽을 때: extractDocumentText(supabase, { assetId: asset.id })
```

- **스캔한 PDF**는 글자층이 없어서 `noText`가 와요 → 쪽을 사진으로 찍어 `ocrImages`로 읽게 안내하세요.
- 머리글·바닥글·각주·변경 추적으로 지운 글자는 빼요. 표는 칸을 ` | `로 이어요. PowerPoint는 화면에 보이는 슬라이드 순서대로예요(숨긴 슬라이드는 `(숨긴 슬라이드)` 표시).
- 원본 파일을 공간에 남기고 싶으면 첨부(`attachments.ts`)로 올리고 `input_sources`(`kind: 'DOCUMENT'`, `asset_id`)로 연결하세요.

### PDF 내보내기 (`pdf-export.ts`, 기기에서 만들기, 11/15)

고른 항목을 **기기에서** PDF로 만들어요(서버로 내용을 보내지 않음). 구역을 골라 이어 붙이면 돼요.

| 구역 함수 | 내용 |
|---|---|
| `notePdfSection(note)` | 제목·수정 시각·본문(줄바꿈 그대로)·손글씨(SVG라 확대해도 선명) |
| `tasksPdfSection(tasks)` | 체크리스트(안 끝난 일·마감 빠른 순, 취소는 뺌), 마감·담당·중요도 |
| `eventsPdfSection(events)` | 표: 언제(같은 날이면 `14:00 ~ 15:30`)·일정·장소·상태 |
| `meetingPdfSection(meeting, agenda, { minutes })` | 일시·상태, 안건 표, 회의록 |
| `transcriptPdfSection(tr, { summary })` | 요약 + 전사문 (`[12:00]` 시각 그대로) |
| `documentTextPdfSection(doc)` | 문서 글자 추출 결과를 쪽·슬라이드별로 |

```ts
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { supabase, newId, exportPdf, notePdfSection, tasksPdfSection, transcriptPdfSection, savePdfAttachment, pdfFileName } from '@/lib/stella';

const pdf = await exportPdf({
  title: '데이터베이스 3주차', subtitle: '강의 정리', meta: [['공간', workspace.name]],
  sections: [notePdfSection(note), tasksPdfSection(tasks), transcriptPdfSection(tr, { summary, newPage: true })],
}, { printToFileAsync: Print.printToFileAsync });            // 옵션: { paper: 'A4' | 'LETTER', landscape, fontScale }

// ① 공유(카톡·메일·파일 앱에 저장)
await Sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: pdf.fileName });
// ② 공유 공간에 보관 → 다른 멤버 기기에 동기화. 메모에 붙이려면 받은 asset.id로 note_attachments 링크 저장
const asset = await savePdfAttachment(supabase, {
  workspaceId, assetId: newId(), uri: pdf.uri, title: '데이터베이스 3주차',
  readFile: (uri) => new File(uri).bytes(), digest: (b) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, b),
});
```

- **개인 공간 PDF는 서버에 올리지 않아요**(백업은 기기에서 암호화한 파일만 받음) → 기기에 두거나 공유하세요.
- 모든 글자는 HTML 이스케이프돼요. 그림은 `data:image/…` 또는 `file://` 주소만 넣어요(웹 주소·스크립트는 막음).
- 글자 대체 모양(합자·문맥 대체)을 꺼서 PDF에서 복사·검색한 글자가 정확해요.
- `expo-print`는 개발 빌드·Expo Go 모두 돼요. **실제 iPhone·Android에서 한글 글꼴·여백 확인 필요** (iOS는 여백을 따로 넘김).

### AI 채팅 (`ai-chat.ts`, 클라우드 AI, 11/15)

팀 서버(로컬 AI 모드)와 같은 2단계예요. **기록은 서버에 없어서** 앱이 기기에서 찾고, 고른 발췌만 보내요.

1. `ai-gateway/query/plan` 질문 → 검색 조건(키워드·종류·기간·상태·사람·프로젝트·정렬) — 질문 횟수에 안 들어감(별도 남용 한도 FREE 150 / PRO 1,500)
2. 앱이 기기 SQLite에서 후보를 가져오면 `rankRecords`가 조건으로 고르고 발췌를 만듦 (최대 12개, 합계 24,000자)
3. `ai-gateway/query/answer` 질문 + 발췌 → 답변 + 출처 — **질문 1회** (FREE 50 / PRO·TEAM 500)

```ts
import { supabase, newId, askAssistant, chatErrorMessage } from '@/lib/stella';

// AiChatScreen.js의 answerFromApp(text) 자리
try {
  const reply = await askAssistant(supabase, {
    question: text,
    history: messages.slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text })),
    newId,
    findRecords: (plan) => loadChatRecords(db, plan),   // 기기 SQLite → ChatRecord[] (아래)
  });
  setMessages((prev) => [...prev, { role: 'ai', text: reply.text, sources: reply.sources }]);   // sources: [{ id, type, title, quote }]
} catch (e) {
  setMessages((prev) => [...prev, { role: 'ai', text: chatErrorMessage(e), sources: [] }]);
}
```

- `ChatRecord`: `{ id, type: 'memo'|'task'|'event'|'project'|'meeting'|'file', title, text, date?, status?: 'open'|'done', people?, project?, workspaceId? }`. `findRecords`는 조건으로 미리 걸러도 되고(`plan.types`·`plan.date_from`·`plan.date_to`), 기록이 적으면 전부 줘도 돼요.
- 공유 공간 기록은 `workspaceId`를 꼭 넣으세요. 서버가 지금도 그 공간 멤버인지 확인하고, 아니면 `FORBIDDEN`(OpenAI로 안 보냄).
- 인사·감사, 기록과 무관한 질문은 1단계 답으로 끝나요(`reply.kind === 'direct'`). 찾은 기록이 없으면 답변 단계를 부르지 않아요(`'not_found'`). 둘 다 질문 횟수를 안 써요.
- 출처는 서버가 "인용 구절이 그 기록에 실제로 있는지" 확인한 것만 와요. `reply.followUps`는 이어 물어볼 질문(최대 3개).
- 외부 AI 동의가 필요해요. 질문·발췌는 서버에 저장되지 않아요(`ai_requests`엔 해시·토큰 수만).

### 안건 논의 판단 (`agenda-judge.ts`, 11/15)

안건 비교 화면(AgendaCompareScreen)의 **논의됨 / 미논의** 표시예요. 회의 요약(`/analyze`)과는 별개로, 달라진 항목마다 그날 회의에서 이야기했는지 판단해요. `ai-gateway/agenda/judge` (FREE 50 / PRO·TEAM 500회)

```ts
import { supabase, newId, judgeAgendaDiscussion, agendaJudgeErrorMessage } from '@/lib/stella';

// AgendaJudge.js의 judgeDiscussion(changes) 자리 — computeChanges의 changes를 그대로
const r = await judgeAgendaDiscussion(supabase, {
  changes,                                   // [{ key, kind, status: 'added'|'changed'|'removed', title, titleBefore, bodyBefore, bodyAfter, workspaceId }]
  discussions: [                             // 그날 프로젝트에 연결된 회의 메모·녹음 전사문
    { id: note.id, kind: 'MEETING_NOTE', title: note.title, text: note.body, workspaceId },
    { id: rec.id, kind: 'TRANSCRIPT', title: '회의 녹음', text: transcript.text, workspaceId },   // recordings.ts의 tr.text 그대로
  ],
  projectTitle: project.title, date: day, newId,
});
setJudged(r.judged);                         // { [key]: 'discussed' | 'open' } — 화면 모양 그대로
// r.details[key] = { reason, evidence(회의 원문 구절), discussion_id, downgraded }
```

- 회의 자료가 없으면 서버를 부르지 않고 빈 결과예요(표시 없음).
- 같은 입력은 캐시에서 돌려줘요(앱이 켜져 있는 동안, 최근 100개). 오래 두려면 `cache: { get, set }`에 SQLite 저장소를 넘기세요. `r.fromCache`
- 확신이 없으면 미논의로 해요. 모델이 논의됐다고 해도 근거 구절이 회의 원문에 없으면 서버가 미논의로 낮춰요(`downgraded: true`).
- 한도: 항목 50개(각 1,500자), 회의 자료 10개·합계 60,000자. 넘치면 앞에서부터 잘라 보내고 `r.truncated`에 알려요.
- 오류 문구는 `agendaJudgeErrorMessage(e)`.

### 긴 녹음 → 전사 → 정리 (`recordings.ts`, 최대 3시간) — 회의·강의 녹음은 이걸 쓰세요

**연속 녹음 → 종료 후 약 2분 구간으로 분할 → 구간 업로드 → 서버가 구간별 전사 → 전사문 확인·수정 → Terra 정리 → 저장 → 서버 정리.** 실시간 전사는 후속 기능이에요.

> **녹음 시각 보존 (11/15)**: 전사 모델(`gpt-transcribe`)은 문장별 시각을 주지 않아요. 그래서 구간을 짧게(기본 2분) 나누고 구간 시작 시각을 전사문에 붙여요 → `[00:00] …`, `[02:00] …`, `[1:02:00] …`. 시각은 **구간 단위(2분 간격)**로 정확하고, 그 안의 문장별 시각은 없어요.
> 구간 길이는 `planSegments(total, 60 * 분)`으로 1~15분 사이에서 바꿀 수 있어요(분 단위로 맞춤). 짧을수록 시각이 촘촘하지만 구간 경계에서 문장이 끊기는 곳이 늘어요. 서버 한도는 녹음 하나에 구간 200개(1분 구간 3시간 = 180개).

| 단계 | 앱이 할 일 | 함수 |
|---|---|---|
| 녹음 | 경과 시간·일시정지·종료 표시, 3시간이면 자동 종료. 파일은 기기에 | `formatClock`, `shouldStopRecording`, `RECORDING_AUDIO` |
| 나누기 | 종료 후 원본은 그대로 두고 약 2분 m4a 구간 생성 (다시 인코딩 안 함). 1~15분 설정 가능 | `planSegments`, `normalizeSegmentSeconds` + `modules/stella-audio-split`의 `splitAudio` |
| 등록·업로드 | 구간마다 올림 → 서버 확인되면 그 구간 임시 파일 삭제, 전부 확인되면 원본 삭제. 끊기면 같은 녹음 id로 다시 부르면 남은 구간만 | `createRecording`, `uploadRecordingSegments` |
| 진행률 | "음성 변환 중 · 90개 중 24개 완료" / "실패한 구간 1개 · 재시도 가능". 앱을 닫아도 서버는 계속 처리 | `watchRecording`, `recordingProgressText` |
| 전사문 | 구간 순서대로 이은 글. 구간마다 시각 `[12:00] …`, 빠진 구간은 `[구간 7 (12:00~14:00) 변환 실패]` → 사용자가 오인식 수정. 시각 없는 글은 `plainText` | `getRecordingTranscript`, `segmentTimeLabel` |
| 정리 | Terra로 요약·주요 개념·과제·할 일·일정·확인 질문 | `analyzeMemo({ kind: 'LECTURE' \| 'MEETING' })` |
| 저장 | 개인: 기기 SQLite / 공유: 사용자 승인 후 `pushChanges`. 저장했으면 서버 임시 전사문 삭제 | `ackRecordingTranscript` |

```ts
import { useAudioRecorder, useAudioRecorderState, RecordingPresets } from 'expo-audio';   // (앱에서 연결·검증 필요)
import { File } from 'expo-file-system';
import { getAudioDuration, splitAudio } from '@/modules/stella-audio-split';            // (실제 폰에서 검증 필요)
import { supabase, newId, RECORDING_AUDIO, formatClock, shouldStopRecording, planSegments, createRecording,
         uploadRecordingSegments, watchRecording, recordingProgressText, retryRecordingSegments, cancelRecording,
         getRecordingTranscript, analyzeMemo, analyzeDraftToNoteBody, ackRecordingTranscript, recordingErrorMessage } from '@/lib/stella';

// 1) 녹음 화면: 모노 64kbps m4a (품질 보고 조정)
const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, ...RECORDING_AUDIO });
const state = useAudioRecorderState(recorder, 500);
// 표시: formatClock(state.durationMillis / 1000)  →  "1:02:05"   버튼: recorder.pause() / recorder.record() / 종료
useEffect(() => { if (state.isRecording && shouldStopRecording(state.durationMillis)) void stop(); }, [state.durationMillis]);

// 2) 종료 → 나누기 → 등록 (recordingId와 구간 파일 경로를 기기 DB에 저장해 두면 앱을 다시 열어도 이어서 올림)
async function stop() {
  await recorder.stop();
  const original = recorder.uri!;
  const total = await getAudioDuration(original);
  const segs = await splitAudio(original, planSegments(total).map((p) => ({ start: p.startSeconds, duration: p.durationSeconds })));
  const recordingId = newId();
  const created = await createRecording(supabase, {
    recordingId, workspaceId,                                    // 개인 녹음이면 workspaceId 생략
    keywords: ['데이터베이스', '정규화', ...memberNames],          // 과목·사람 이름 → 정확도
    segments: segs.map((s) => ({ seq: s.seq, durationSeconds: s.durationSeconds, sizeBytes: s.sizeBytes, mimeType: 'audio/mp4' })),
  });
  if (created.minutesNeeded! > created.remainingMinutes) {
    showToast(`이번 달 남은 변환 시간은 ${created.remainingMinutes}분이에요. 앞부분만 변환돼요`);
  }
  // 3) 업로드 (끊기면 나중에 같은 recordingId로 다시 부르기)
  const r = await uploadRecordingSegments(supabase, {
    recordingId,
    readSegment: (seq) => new File(segs[seq].uri).bytes(),
    onSegmentConfirmed: (seq) => new File(segs[seq].uri).delete(),   // 서버가 확인한 구간만 지움
  });
  if (r.allUploaded) new File(original).delete();                    // 전부 확인된 뒤에 원본 삭제
}

// 4) 진행률 (화면이 열려 있는 동안)
const w = watchRecording(supabase, recordingId, { onUpdate: (s) => setLines(recordingProgressText(s).lines) });
// 실패 구간 다시: await retryRecordingSegments(supabase, recordingId)   (최초 실패부터 3일 안, 기한은 늘지 않음)
// 취소:          await cancelRecording(supabase, recordingId)          (서버 음성·전사문 정리, 기기 파일은 앱이 지움)

// 5) 전사문 → 사용자 수정 → Terra 정리 → 저장 → ack
const tr = await getRecordingTranscript(supabase, recordingId);      // tr.text: "[00:00] …\n\n[02:00] …", tr.missing: 빠진 구간, tr.complete
const edited = await openTranscriptEditor(tr.text);                    // 오인식 수정 화면
const res = await analyzeMemo({ clientRequestId: newId(), text: edited, kind: 'LECTURE', workspaceId });
const body = analyzeDraftToNoteBody(res.draft);                        // 요약 → 주요 개념 → 내용 → 확인할 점
// 개인: 기기 SQLite에 원문(VOICE, edited)·노트(body)·승인한 할 일/일정 저장 / 공유: 승인 후 pushChanges
await ackRecordingTranscript(supabase, recordingId);                   // 저장한 뒤에 → 서버 임시 전사문 삭제
```

- **요약은 음성과 따로**: 전사문만 저장돼 있으면 `analyzeMemo`가 실패해도 같은 전사문으로 다시 요청하면 돼요. 음성은 다시 안 보내요.
- **서버 보관 규칙**: 처리 전·중엔 유지 → 전사 성공하면 바로 삭제 → 실패 구간만 최초 실패부터 3일(재시도해도 연장 없음) → 지나면 삭제·최종 실패. 취소하면 바로 정리. 서버 임시 전사문은 `ack` 즉시, 안 해도 7일 뒤 삭제.
- **한도**: 구간마다 분 단위로 차감(FREE 월 60분 / PRO 600분). 구간 길이를 분 단위로 맞추는 이유예요(90초 구간이면 2분씩 차감돼 손해). 3시간 녹음은 180분이라 FREE는 앞 60분만 변환되고 나머지 구간은 `QUOTA_EXCEEDED`로 실패해요.
- **짧은 음성 메모(`transcribe.ts`)는 시각 표시가 없어요.** 한 파일을 한 번에 변환해서 구간이 없어요. 시각이 필요한 녹음은 이 긴 녹음 흐름을 쓰세요.
- **임시 저장공간**: 녹음·분할·업로드 중에는 원본 + 구간 파일이 함께 있어서 3시간 기준 약 170MB가 잠깐 필요해요(64kbps). 시작 전에 남은 공간을 확인하세요.
- **업로드 권한**: 앱은 자기 녹음의 업로드 대기 구간 경로에만 올릴 수 있고, 남의 경로·등록 안 된 경로·확인 끝난 구간은 거절돼요.
- 분할 모듈은 `modules/stella-audio-split`(아래 폴더)을 앱 루트 `modules/`에 넣으면 자동 연결돼요. **개발 빌드 필요(Expo Go 안 됨), 실제 iPhone·Android에서 연결·검증 필요.**

### 짧은 음성 메모 → 글자 (`transcribe.ts`, 30분까지)

노션 모바일처럼 **녹음을 서버의 비공개 임시 보관함에 올리고 → 변환이 끝나면 바로 삭제, 실패하면 3일 보관**해요. 실패해도 같은 녹음을 다시 올리지 않고 재시도할 수 있고, 올리기만 하고 안 쓴 녹음도 3일 뒤 서버가 지워요. 받아 적은 글은 서버에 남지 않아요(앱에 오는 **초안**뿐).

```ts
import { useAudioRecorder, useAudioRecorderState, RecordingPresets } from 'expo-audio';   // (앱에서 연결·검증 필요)
import { File } from 'expo-file-system';
import { supabase, newId, transcribeAudio, transcribeUploaded, uploadRecording, retryPlan, continuationPrompt,
         transcribeErrorMessage, saveLocal } from '@/lib/stella';

// 녹음 설정: m4a(AAC) 모노 16kHz 48kbps → 1시간에 약 22MB
const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, sampleRate: 16000, numberOfChannels: 1, bitRate: 48000 });
const state = useAudioRecorderState(recorder);    // state.durationMillis = 녹음 길이

// 녹음을 멈춘 뒤
const durationSeconds = state.durationMillis / 1000;
await recorder.stop();
const uploadId = newId();                         // 녹음 파일 경로와 함께 기기 DB에 저장 → 재시도할 때 같은 값
let clientRequestId = newId();                    // 이것도 저장 (retryPlan에 따라 새로 만듦)
const bytes = await new File(recorder.uri!).bytes();   // RN에서는 uri·FormData가 아니라 bytes로 올려요
try {
  const r = await transcribeAudio(supabase, {     // = uploadRecording + transcribeUploaded
    uploadId, clientRequestId, bytes, mimeType: 'audio/mp4', durationSeconds,
    workspaceId,                                   // 공유 공간 녹음이면 (개인 녹음은 생략)
    keywords: ['Stella', ...memberNames],          // 사람·프로젝트 이름을 주면 더 정확해요
  });
  // r.uploadDeleted === true → 서버 녹음은 이미 지워짐. r.text를 보여 주고 사용자가 고친 뒤 저장
  const sourceId = newId(), versionId = newId();
  await saveLocal(ctx, [   // 공유 공간 (개인 녹음이면 기기 DB에만 같은 모양으로 저장)
    { kind: 'create', entity: 'input_sources', id: sourceId, data: { kind: 'VOICE', original_text: r.text } },
    { kind: 'create', entity: 'source_text_versions', id: versionId, data: { source_id: sourceId, text: editedText } },
    { kind: 'create', entity: 'notes', id: newId(), data: { title, body: editedText, source_id: sourceId, source_version_id: versionId } },
  ]);
  // r.remainingMinutes → "이번 달 남은 변환 시간 58분"
} catch (e) {
  switch (retryPlan(e.code)) {
    case 'same_request':            // 네트워크·일시 오류: 잠시 뒤 같은 clientRequestId로 transcribeUploaded
      break;
    case 'new_request_same_upload': // 시간 초과 등: 녹음은 서버에 3일 보관 → 새 clientRequestId로 transcribeUploaded (다시 안 올림)
      clientRequestId = newId();
      break;
    case 'reupload':                // 녹음이 없음(안 올라감·지워짐): 새 uploadId로 transcribeAudio
      break;
    case 'stop':                    // 한도 초과·동의 없음·형식 오류 등: 사용자에게 안내만
      break;
  }
  showToast(transcribeErrorMessage(e));
}
// 재시도: await transcribeUploaded(supabase, { uploadId, clientRequestId, durationSeconds, workspaceId, keywords })
```

- **한도는 녹음 길이 기준**이에요: FREE 월 60분, PRO 600분. 실패하면 차감되지 않고(시간 초과는 결과를 몰라 차감), 남은 분은 `getSttUsage(supabase)`로 볼 수 있어요.
- **한 번에 30분·25MB까지** 보낼 수 있어요. 서버 함수가 150초 안에 끝나야 해서, 회의 녹음은 **10분 정도씩 나눠 녹음**하고 조각이 끝날 때마다 보내는 걸 권장해요.
  다음 조각에는 `prompt: continuationPrompt(앞 조각 글)`을 넘기면 말이 이어지게 받아 적어요.
- 형식은 m4a·mp3·wav·webm·ogg·flac·mp4. raw AAC(`.aac`)는 안 되니 m4a로 녹음하세요.
- 외부 AI 동의(`EXTERNAL_AI`)가 있어야 올릴 수 있어요. 녹음 전에 "녹음이 서버에 잠시 올라가 OpenAI로 전송되고, 변환 후 삭제돼요(실패하면 3일 뒤 삭제)" 안내를 보여 주세요.
- 변환을 기다리는 녹음은 계정당 10개까지예요(`TOO_MANY_PENDING`). 기기에 남은 녹음 파일은 앱이 따로 정리하세요.
- 서버 테스트는 가짜 OpenAI·Storage로 통과했고, 실제 OpenAI 호출은 서버에 키를 등록한 뒤 검증 도구 13번 묶음으로 확인해요. `expo-audio`·`expo-file-system` 부분은 **앱에서 연결·검증 필요**.

### 직접 받기 (local-sync를 안 쓸 때)

```ts
// 처음 공간에 들어갈 때
const snap = await getSnapshot(workspaceId);   // 전체 → 기기 DB에 저장, snap.as_of_seq 저장
// 이후 (앱 열 때, 당겨서 새로고침)
const res = await pullAll(workspaceId, lastSeq, async (changes, nextSeq) => {
  await applyToLocalDb(changes);                // data = 바뀐 뒤 행 전체, deleted_at이 있으면 휴지통
  await saveLastSeq(nextSeq);                   // 데이터와 같은 트랜잭션으로
});
if (res.status === 'SNAPSHOT_REQUIRED') { /* getSnapshot부터 다시. 안 보낸 수정은 지우지 말 것 */ }
```

## 4. 꼭 지킬 것

- **id는 앱이 만듭니다.** 기록 id, `operationId`, AI `clientRequestId` 모두 `newId()`를 씁니다.
- **재전송할 때는 같은 `operationId`를 씁니다.** 실패한 push를 다시 보낼 때 같은 값을 쓰면 서버가 한 번만 처리합니다. 보낼 목록(outbox)에 ops와 함께 저장해 두세요.
- **push 한 번은 1~100개까지입니다.** 전부 성공하거나 전부 실패하고, 순서대로 적용됩니다. 그래서 원문 → 원문 버전 → 메모 → 할 일처럼 참조 대상을 먼저 보내야 합니다.
- **개인 기록은 서버로 보내지 않습니다.** `pushChanges`는 공유 공간 전용이고, 개인 기록은 기기 SQLite에만 둡니다.
- **AI 결과는 초안입니다.** 사용자가 승인하기 전에는 아무 데도 저장되지 않습니다.
- **AI 오류는 재시도 방법을 확인합니다.** `canRetryWithSameRequestId(err.code)`가 false면 새 `clientRequestId`로 다시 요청하세요(이미 횟수에 들어간 경우). 화면 문구는 `aiErrorMessage(err)`를 쓰면 됩니다.
- **VIEWER는 수정할 수 없습니다.** push하면 `FORBIDDEN`이 나니, `canEdit(role)`로 버튼을 막아 두세요.
- **프로젝트 관리는 팀장(또는 관리자)만 합니다.** `canManageProject`로 프로젝트 수정·팀원 관리·초대 버튼을 숨기세요 (11/15).
- **초대·역할 변경·내보내기는 관리자(OWNER)만 합니다.** `canManage(role)`로 메뉴를 숨기세요. 앱 역할은 관리자·멤버 두 가지예요 (VIEWER는 서버에만 있고 앱에서는 만들지 않음).
- **초대 코드는 만들 때 한 번만 받습니다.** 잃어버리면 새로 만들고 예전 것은 취소하세요.
- **코드 입력 화면을 꼭 두세요.** 카카오톡 등에서는 `stella://`·`exp://` 링크가 눌리지 않을 수 있어서, 링크는 보조 수단입니다.

## 5. 아직 서버에 없는 기능

| 기능 | 상태 |
|---|---|
| 초대 메일 실제 발송 | 서버·`invite-mail.ts` 있음(11/15). Secrets `SMTP_PASSWORD` 등록 뒤부터 감 |
| AI 채팅 화면 연결 | 서버·`ai-chat.ts` 있음(11/15). 기기 SQLite에서 `ChatRecord`를 읽는 `loadChatRecords`는 프론트(데이터 폴더) 몫 |
| AI 모드 선택 | 안 함 (클라우드 AI는 Terra 하나, 11/14) |
| 문장 단위 녹음 시각 | 구간(기본 2분) 단위만. `gpt-transcribe`가 시각을 주지 않음 (시각을 주는 whisper-1은 2027-02-26 종료 예정, 11/15) |
| 스캔한 PDF 글자 인식 | 문서 추출은 글자층만 읽음. 스캔본은 사진 OCR(`ocrImages`, 한 번에 5장)로 안내 |
| 옛 형식 doc·ppt·hwp | 안 읽음 (docx·pptx로 다시 저장 안내) |
