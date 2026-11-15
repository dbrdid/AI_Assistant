// =====================================================================
// Stella 백엔드 타입 (서버 마이그레이션 기준, 2026-11-15 · migration #23까지)
//   테이블 행 타입은 database.types.ts(자동 생성)에서 가져오고,
//   여기에는 동기화·AI처럼 jsonb로 오가는 형식을 정의합니다.
// =====================================================================
import type { Database } from './database.types';

type Tables = Database['public']['Tables'];
export type Row<T extends keyof Tables> = Tables[T]['Row'];

// ---------------------------------------------------------------------
// 값 목록 (서버 check 제약과 동일)
// ---------------------------------------------------------------------
export type WorkspaceRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export type MemberStatus = 'ACTIVE' | 'LEFT' | 'REMOVED';
export type ConsentType = 'TERMS' | 'PRIVACY' | 'EXTERNAL_AI' | 'SERVER_AI' | 'PERSONAL_SYNC' | 'MARKETING';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELED';
export type EventStatus = TaskStatus;
export type ProjectStatus = 'ACTIVE' | 'ARCHIVED';                     // 보관 상태
export type ProjectProgress = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'ON_HOLD' | 'CANCELED';  // 진행 상태
export type Priority = 0 | 1 | 2 | 3;
export type MeetingStatus = 'SCHEDULED' | 'DONE' | 'CANCELED';
export type AgendaStatus = 'OPEN' | 'DISCUSSED' | 'DEFERRED' | 'CARRIED_OVER' | 'CLOSED';
export type SourceKind = 'TEXT' | 'VOICE' | 'IMAGE' | 'DOCUMENT';
export type Plan = 'FREE' | 'PRO';
export type Platform = 'ios' | 'android' | 'web';

// ---------------------------------------------------------------------
// sync_push: 엔티티별 data (서버가 받는 필드만)
//   * 표시는 "만들 때만" 지정 가능 (수정 때 보내도 무시됨)
//   날짜·시각은 ISO 8601 문자열 (예: 2026-11-13T15:00:00+09:00)
// ---------------------------------------------------------------------
/**
 * 손글씨 획 1개 (화면 InkCanvas 저장 형식 그대로). 서버가 형식을 검사함 (어기면 CHECK_FAILED)
 *   id 1~100자 · c(색) 1~64자 · w(굵기) 0 초과 100 이하 · p(점) 1~10,000개, 점은 [x, y] 숫자 2개
 *   메모 하나의 strokes 전체는 JSON 1MiB까지
 */
export interface Stroke { id: string; c: string; w: number; p: Array<[number, number]> }

export interface NoteData {
  title?: string | null;
  body?: string;
  strokes?: Stroke[];                 // 안 보내면 그대로, [] 보내면 모두 지움 (null은 거절)
  source_id?: string | null;          // *
  source_version_id?: string | null;  // *
}
export interface TaskData {
  title?: string;                     // 만들 때 필수, 1~200자
  description?: string | null;
  status?: TaskStatus;
  priority?: Priority;
  due_at?: string | null;
  all_day?: boolean;
  note_id?: string | null;
  project_id?: string | null;
  assignee_id?: string | null;        // 이 공간의 ACTIVE 멤버
  assignee_name?: string | null;      // 화면 표시용 자유 입력 (100자). 권한과 무관, 실제 배정은 assignee_id
  reminder_minutes?: number | null;   // 마감 몇 분 전 알림 (0~525600). 저장만, 발송은 기기 로컬 알림
  location?: string | null;           // 200자
  source_version_id?: string | null;  // *
}
export interface EventData {
  title?: string;                     // 만들 때 필수, 1~200자
  description?: string | null;
  location?: string | null;
  start_at?: string;                  // 만들 때 필수
  end_at?: string;                    // 만들 때 필수, start_at 이후
  all_day?: boolean;
  timezone?: string;                  // 기본 Asia/Seoul
  status?: EventStatus;               // 기본 TODO (ON_HOLD 없음)
  priority?: Priority;                // 기본 0, null 불가
  reminder_minutes?: number | null;   // 시작 몇 분 전 알림 (0~525600)
  assignee_name?: string | null;      // 화면 표시용 (100자)
  note_id?: string | null;
  project_id?: string | null;
  source_version_id?: string | null;  // *
}
export interface ProjectData {
  name?: string;                      // 만들 때 필수
  description?: string | null;
  status?: ProjectStatus;             // 보관 상태 (기본 ACTIVE)
  progress_status?: ProjectProgress;  // 진행 상태 (기본 TODO)
  due_date?: string | null;           // 'YYYY-MM-DD'
  priority?: Priority;                // 기본 0, null 불가
  reminder_minutes?: number | null;   // 0~525600
  assignee_name?: string | null;      // 화면 표시용 (100자). 프로젝트별 권한은 아직 없음
  location?: string | null;           // 200자
}
/** 프로젝트 팀원 (화면 표시용 이름·역할, 권한 아님). project-team.ts의 teamChanges로 만드세요 */
export interface ProjectMemberData {
  project_id?: string;                // 만들 때 필수. 바꾸면 다른 프로젝트로 이동
  name?: string;                      // 1~20자
  role?: string;                      // 1~12자, 기본 '팀원' (팀장·팀원·직접 입력)
  account_id?: string | null;         // 공간 ACTIVE 멤버 계정 (없으면 이름만 있는 팀원)
  position?: number;
}
export interface MeetingData {
  title?: string;                     // 만들 때 필수
  project_id?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  status?: MeetingStatus;
}
export interface AgendaItemData {
  meeting_id?: string;                // * 만들 때 필수
  title?: string;
  description?: string | null;
  status?: AgendaStatus;              // 바뀌면 서버가 agenda_transitions에 이력 기록
  position?: number;
  carried_from_id?: string | null;    // * 이월 원본 안건
}
export interface InputSourceData {
  kind: SourceKind;
  original_text?: string | null;
  asset_id?: string | null;           // 업로드 검증이 끝난(AVAILABLE) 첨부만
}
export interface SourceTextVersionData {
  source_id: string;
  text: string;                       // 사용자가 확정한 원문 (비어 있으면 안 됨). 버전 번호는 서버가 배정
}
export interface NoteProjectLink { note_id: string; project_id: string }
export interface ProjectParticipantLink { project_id: string; account_id: string }
export interface NoteAttachmentLink { note_id: string; asset_id: string; position?: number }
/** 프로젝트에 직접 연결한 파일 (#29) */
export interface ProjectFileLink { project_id: string; asset_id: string; position?: number }

export interface RevisionedEntities {
  notes: NoteData;
  tasks: TaskData;
  events: EventData;
  projects: ProjectData;
  project_members: ProjectMemberData;
  meetings: MeetingData;
  agenda_items: AgendaItemData;
}
export interface ImmutableEntities {
  input_sources: InputSourceData;
  source_text_versions: SourceTextVersionData;
}
export interface LinkEntities {
  note_projects: NoteProjectLink;
  project_participants: ProjectParticipantLink;
  note_attachments: NoteAttachmentLink;
  project_files: ProjectFileLink;
}
export type RevisionedEntity = keyof RevisionedEntities;
export type ImmutableEntity = keyof ImmutableEntities;
export type LinkEntity = keyof LinkEntities;
export type SyncEntity = RevisionedEntity | ImmutableEntity | LinkEntity;

export interface SyncOp {
  entity: SyncEntity;
  op: 'UPSERT' | 'DELETE' | 'RESTORE' | 'PURGE';   // RESTORE·PURGE는 휴지통 대상 7가지, data는 {} (#32)
  id?: string;                // 연결(LINK) 엔티티는 없음
  base_revision?: number;     // 새로 만들 때는 없음, 수정·삭제 때는 마지막으로 받은 revision
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------
// sync_push 응답 (receipt)
// ---------------------------------------------------------------------
export interface PushResultItem {
  index: number;
  entity: SyncEntity | 'agenda_transitions';
  id?: string;
  key?: string;               // 연결 엔티티: "{a}:{b}"
  revision?: number;          // 이 값을 다음 수정 때 base_revision으로
  seq?: number;
  deleted?: boolean;
  purged?: true;              // 영구 삭제됨 (#32): 기기 사본도 지우기
  version?: number;           // source_text_versions: 서버가 배정한 버전 번호
  op?: 'UPSERT' | 'DELETE';
  unchanged?: true;           // 이미 연결/해제된 상태라 바뀐 것 없음
}
export type ConflictReason =
  | 'REVISION_MISMATCH'       // 다른 사람이 먼저 고침 → server 값을 보고 다시 시도
  | 'DELETED'                 // 이미 휴지통에 있음
  | 'NOT_DELETED'             // 복구·영구 삭제하려는 기록이 휴지통에 없음 (다른 사람이 먼저 복구)
  | 'NOT_FOUND'               // 수정하려는 대상이 없음
  | 'ALREADY_EXISTS'          // 같은 id가 이미 있음 (새로 만들기 중복)
  | 'ID_TAKEN'                // 다른 공간에서 쓰는 id
  | 'ALREADY_CARRIED'         // 이미 이 회의로 이월된 안건
  | 'NOT_PROJECT_LEADER'      // 프로젝트 관리는 팀장·관리자만 (#30)
  | 'PURGE_NOT_ALLOWED';      // 영구 삭제는 공간 관리자·휴지통으로 보낸 사람만 (#32)
export interface PushConflict {
  index: number;
  entity: SyncEntity;
  id: string;
  reason: ConflictReason;
  base_revision?: number;
  server?: Record<string, unknown>;  // 서버의 현재 행
}
export type PushReceipt =
  | { status: 'ACCEPTED'; operation_id: string; results: PushResultItem[]; last_seq: number; auth_epoch: number; replayed?: true }
  | { status: 'CONFLICT'; operation_id: string; conflicts: PushConflict[]; last_seq: number; auth_epoch: number; replayed?: true };

// ---------------------------------------------------------------------
// sync_pull / sync_snapshot 응답
// ---------------------------------------------------------------------
export interface ChangeItem {
  seq: number;
  entity: SyncEntity | 'agenda_transitions' | 'workspace_members' | 'assets' | 'project_invites';
  key: string;                // id, 연결 엔티티는 "{a}:{b}", workspace_members는 account_id, assets는 첨부 id
  op: 'UPSERT' | 'DELETE';    // DELETE는 연결 해제만. 기록 삭제는 UPSERT + deleted_at
  revision: number | null;
  data: Record<string, unknown> | null;  // 변경 후 행 전체 (연결 해제는 null). workspace_members는 MemberChangeData
  operation_id: string | null;           // 멤버 변경(초대 수락·나가기 등)은 null
  actor_id: string;
  committed_at: string;
}

/** sync_pull의 entity = 'workspace_members' 변경 data (참여·역할 변경·나가기·내보내기) */
export interface MemberChangeData {
  workspace_id: string;
  account_id: string;
  role: WorkspaceRole;
  status: MemberStatus;
  joined_at: string;
  ended_at: string | null;
  display_name: string | null;
  avatar_path: string | null;
}
export type PullResult =
  | { status: 'OK'; changes: ChangeItem[]; next_seq: number; has_more: boolean; last_seq: number; auth_epoch: number }
  | { status: 'SNAPSHOT_REQUIRED'; last_seq: number; min_retained_seq: number; auth_epoch: number };

export interface SnapshotMember {
  account_id: string;
  role: WorkspaceRole;
  status: MemberStatus;
  display_name: string | null;
  avatar_path: string | null;
}
export interface Snapshot {
  status: 'OK';
  as_of_seq: number;          // 다음 pull은 이 값부터
  auth_epoch: number;
  workspace: Row<'workspaces'>;
  members: SnapshotMember[];
  projects: Row<'projects'>[];
  project_members: Row<'project_members'>[];
  project_invites: Row<'project_invites'>[];
  project_participants: Row<'project_participants'>[];
  input_sources: Row<'input_sources'>[];
  source_text_versions: Row<'source_text_versions'>[];
  notes: Row<'notes'>[];
  note_projects: Row<'note_projects'>[];
  note_attachments: Row<'note_attachments'>[];
  project_files: Row<'project_files'>[];
  assets: Row<'assets'>[];
  tasks: Row<'tasks'>[];
  events: Row<'events'>[];
  meetings: Row<'meetings'>[];
  agenda_items: Row<'agenda_items'>[];
  agenda_transitions: Row<'agenda_transitions'>[];
}

// ---------------------------------------------------------------------
// 공간 초대 · 멤버 관리
// ---------------------------------------------------------------------
export type InviteRole = Exclude<WorkspaceRole, 'OWNER'>;
export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

/** create_invite 결과. code는 이때 한 번만 받을 수 있음 (서버에는 해시만 저장) */
export interface CreatedInvite {
  invite_id: string;
  workspace_id: string;
  code: string;               // 'XXXXX-XXXXX'
  role: InviteRole;
  expires_at: string;
  max_uses: number;
}

/** 초대 목록 (OWNER만 조회 가능). 코드 원문은 없음 */
export interface InviteSummary {
  id: string;
  workspace_id: string;
  role: InviteRole;
  status: InviteStatus;       // 기간이 지난 PENDING은 EXPIRED로 바꿔서 돌려줌
  expires_at: string;
  max_uses: number;
  use_count: number;
  invited_by: string | null;   // 초대한 사람이 탈퇴하면 null (#33)
  created_at: string;
}

/** 수락 전 확인 화면용 */
export interface InvitePreview {
  workspace_id: string;
  workspace_name: string;
  role: InviteRole;
  invited_by_name: string | null;
  expires_at: string;
  member_count: number;
  already_member: boolean;    // 이미 이 공간 멤버 → 수락 대신 바로 공간 열기
  my_role: WorkspaceRole | null;
  blocked: boolean;           // 내보내진 사람 + 내보내기 전에 만든 초대 → 참여 불가
}

/** 초대받은 프로젝트에 팀원으로 추가된 결과 (프로젝트 초대 코드일 때) */
export interface JoinedProject { project_id: string; member_id: string | null }
export type AcceptInviteResult =
  | { workspace_id: string; role: WorkspaceRole; already_member: true; projects: JoinedProject[]; last_seq: number }
  | { workspace_id: string; workspace_name: string; role: InviteRole; already_member: false; seq: number; projects: JoinedProject[]; last_seq: number };

// ---------------------------------------------------------------------
// AI Gateway
// ---------------------------------------------------------------------
export interface OrganizeDraft {
  title: string;
  summary: string;
  organized: string;
  keywords: string[];
}
export interface TaskDraft {
  title: string;
  description: string | null;
  assignee_name: string | null;
  due_date: string | null;    // YYYY-MM-DD (timezone 기준 현지 날짜)
  due_time: string | null;    // HH:MM
  priority: 0 | 1 | 2 | 3;
  evidence: string;           // 근거 원문 구절
}
export interface EventDraft {
  title: string;
  description: string | null;
  location: string | null;
  date: string;               // YYYY-MM-DD
  start_time: string | null;
  end_date: string | null;
  end_time: string | null;
  all_day: boolean;
  evidence: string;
}
/** 회의록 안건별 정리 (kind: 'MEETING'일 때) */
export interface MeetingTopicDraft {
  title: string;              // 안건 제목 (100자까지)
  points: string[];           // 논의된 내용 1~6개
  decisions: string[];        // 이 안건에서 정해진 것
}
/** 강의의 주요 개념 (kind: 'LECTURE'일 때) */
export interface KeyConceptDraft {
  term: string;               // 개념·용어 (100자까지)
  explanation: string;        // 원문에 근거한 설명 1~2문장
}
export interface AnalyzeDraft {
  summary: string;            // 메모 1~3문장, 회의록·강의 3~6문장 (1200자까지)
  topics: MeetingTopicDraft[]; // 회의록이면 안건별, 강의면 내용 흐름별 정리, 메모면 빈 배열
  key_concepts: KeyConceptDraft[]; // 강의면 주요 개념 3~10개, 아니면 빈 배열
  tasks: TaskDraft[];
  events: EventDraft[];
  decisions: string[];
  open_questions: string[];   // 사용자에게 확인할 질문
  dropped: number;            // 형식이 맞지 않아 서버가 뺀 항목 수
}
export interface AiResponse<D> {
  ok: true;
  request_id: string;
  endpoint: 'organize' | 'analyze';
  model: string;              // 실제로 결과를 만든 모델
  retried: boolean;           // 첫 시도가 실패해서 서버가 다시 호출했는지 (모델은 Terra 하나)
  draft: D;
  input_hash: string;
  usage: { input_tokens: number | null; output_tokens: number | null };
  remaining: number;          // 이번 달 남은 횟수
}
/** 사진 → 글자 초안 (/ocr) */
export interface OcrDraft {
  title: string;              // 40자까지
  text: string;               // 사진 속 글 그대로 (여러 장이면 "--- 2쪽 ---"로 구분, 읽을 수 없는 곳은 [읽을 수 없음])
  summary: string;            // 1~3문장
  content_type: 'DOCUMENT' | 'HANDWRITING' | 'WHITEBOARD' | 'SLIDE' | 'SCREENSHOT' | 'RECEIPT' | 'OTHER';
  has_text: boolean;          // 읽을 글이 없으면 false
  unclear_parts: string[];    // 흐리거나 잘려서 확실하지 않은 부분 → 사용자에게 보여 주세요
}
export type OrganizeResponse = AiResponse<OrganizeDraft>;
export type OcrResponse = Omit<AiResponse<OcrDraft>, 'endpoint'> & { endpoint: 'ocr'; pages: number };
export type AnalyzeResponse = AiResponse<AnalyzeDraft> & { timezone: string; reference_date: string };

export type AiErrorCode =
  | 'AUTH_REQUIRED' | 'INVALID_REQUEST' | 'INPUT_TOO_LONG' | 'NOT_FOUND' | 'NOT_CONFIGURED' | 'INTERNAL'
  | 'FORBIDDEN' | 'CONSENT_REQUIRED' | 'QUOTA_EXCEEDED'
  | 'IN_PROGRESS' | 'RESULT_UNKNOWN' | 'ALREADY_DONE' | 'REQUEST_ID_REUSED'
  | 'PROVIDER_TIMEOUT' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_REFUSED' | 'OUTPUT_SCHEMA_INVALID'
  | 'TOO_LARGE' | 'TOO_MANY_IMAGES' | 'UNSUPPORTED_TYPE'
  | (string & {});
