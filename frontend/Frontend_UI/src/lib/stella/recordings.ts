// 긴 녹음 (최대 3시간) → 구간 업로드 → 서버가 구간별 전사 → 전사문 확인 → Terra 정리
//
//  흐름 (실시간 전사는 후속 기능)
//   1. 녹음: 하나의 연속 녹음(기기 파일). 3시간이 되면 자동 종료 (shouldStopRecording)
//   2. 종료 후 나누기: 네이티브 모듈 stella-audio-split로 약 2분 구간 m4a를 만듦 (원본은 그대로 둠)
//        전사 모델은 문장별 시각을 주지 않아서, 구간 시작 시각으로 녹음 시각을 남겨요 (전사문의 [12:00] 표시)
//   3. createRecording → uploadRecordingSegments
//        구간마다 Storage에 올림 → 서버가 실제 파일·크기·소유자 확인 → 전사 작업 등록
//        → onSegmentConfirmed에서 그 구간 임시 파일 삭제, allUploaded면 기기 원본 삭제
//        끊기면 같은 recordingId로 uploadRecordingSegments를 다시 부르면 남은 구간만 올림
//   4. watchRecording으로 진행률 표시 ("음성 변환 중 · 90개 중 24개 완료" / "실패한 구간 1개 · 재시도 가능")
//        업로드·등록이 끝난 구간은 앱을 닫아도 서버가 계속 처리
//   5. getRecordingTranscript → 사용자가 확인·수정 → analyzeMemo({ kind: 'LECTURE' | 'MEETING' })
//   6. 전사문을 기기(SQLite)나 공유 공간에 저장한 뒤 ackRecordingTranscript → 서버 임시 전사문 삭제
//        요약이 실패해도 전사문으로 다시 요청하면 됨 (음성을 다시 보낼 필요 없음)
//
//  서버 보관 규칙: 전사 성공한 구간 음성은 바로 삭제, 실패 구간은 최초 실패부터 3일(재시도해도 연장 없음),
//                 취소하면 바로 정리, 전사문은 ack하면 바로·안 하면 7일 뒤 삭제
//  이 파일은 react-native를 쓰지 않아요 (파일 읽기·삭제는 앱이 콜백으로 넘김)
import type { SupabaseClient } from '@supabase/supabase-js';

export const MAX_RECORDING_SECONDS = 3 * 60 * 60;      // 3시간
export const RECORDING_SEGMENT_SECONDS = 2 * 60;       // 약 2분 구간 → 3시간이면 90개. 시각 표시 간격이기도 함
export const RECORDING_SEGMENT_MINUTES = { min: 1, max: 15 } as const;  // 구간 길이 설정 범위 (분 단위)
export const RECORDING_MAX_SEGMENTS = 200;              // 서버 한도 (1분 구간 3시간 = 180개)
export const RECORDING_MAX_SEGMENT_BYTES = 25 * 1024 * 1024;
export const RECORDING_BUCKET = 'stt-recordings';
export const RECORDING_FAILED_KEEP_DAYS = 3;
/** 전송용 녹음 설정 (expo-audio RecordingOptions에 그대로). 모노 64kbps부터 품질 테스트 */
export const RECORDING_AUDIO = { extension: '.m4a', sampleRate: 22050, numberOfChannels: 1, bitRate: 64000 } as const;

export class RecordingError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
    this.name = 'RecordingError';
  }
}

export type RecordingState = 'UPLOADING' | 'PROCESSING' | 'NEEDS_RETRY' | 'DONE' | 'DONE_WITH_GAPS' | 'FAILED' | 'CANCELED';
export type SegmentStatus = 'PENDING_UPLOAD' | 'QUEUED' | 'PROCESSING' | 'DONE' | 'FAILED' | 'GAVE_UP' | 'CANCELED';

export interface RecordingSegmentInfo {
  seq: number;
  status: SegmentStatus;
  errorCode: string | null;
  path: string;
  mimeType: string;
  sizeBytes: number;
  startSeconds: number;
  durationSeconds: number;
  retainUntil: string | null;   // 실패 구간 보관 기한 (이 시각까지 재시도 가능)
  hasTranscript: boolean;
}
export interface RecordingStatus {
  recordingId: string;
  workspaceId: string | null;
  state: RecordingState;
  total: number;
  totalSeconds: number;
  counts: { pendingUpload: number; queued: number; processing: number; done: number; failed: number; gaveUp: number; canceled: number };
  chargedMinutes: number;
  retryUntil: string | null;
  ackedAt: string | null;
  segments: RecordingSegmentInfo[];
}

// ---------------------------------------------------------------------
// 1·2. 녹음 시간, 구간 나누기 계획
// ---------------------------------------------------------------------
/** 녹음 화면 경과 시간 "1:02:05" / "02:05" */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 3시간이 되면 녹음을 멈춰야 하는지 (일시정지 시간은 빼고 녹음된 길이 기준) */
export function shouldStopRecording(recordedMillis: number): boolean {
  return recordedMillis >= MAX_RECORDING_SECONDS * 1000;
}

/**
 * 구간 계획: 약 2분씩(기본), 마지막 조각이 너무 짧으면(30초 미만) 앞 구간에 붙임
 *   네이티브 분할 모듈에 그대로 넘기거나, 결과 확인용으로 써요
 *   segmentSeconds는 1~15분, 분 단위로 맞춰요 (변환 시간은 구간마다 분 단위 올림으로 차감되므로
 *   90초 같은 구간은 손해). 짧을수록 시각이 촘촘하지만 구간 경계에서 문장이 끊기는 곳도 많아져요
 */
export function planSegments(totalSeconds: number, segmentSeconds = RECORDING_SEGMENT_SECONDS, minLastSeconds = 30) {
  segmentSeconds = normalizeSegmentSeconds(segmentSeconds);
  const total = Math.max(0, totalSeconds);
  if (total <= 0) return [] as { seq: number; startSeconds: number; durationSeconds: number }[];
  const n = Math.max(1, Math.ceil(total / segmentSeconds));
  const out: { seq: number; startSeconds: number; durationSeconds: number }[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * segmentSeconds;
    out.push({ seq: i, startSeconds: start, durationSeconds: Math.min(segmentSeconds, total - start) });
  }
  const last = out[out.length - 1];
  if (out.length > 1 && last.durationSeconds < minLastSeconds) {
    out.pop();
    out[out.length - 1].durationSeconds += last.durationSeconds;
  }
  return out.map((s) => ({ ...s, durationSeconds: Math.round(s.durationSeconds * 100) / 100 }));
}

// ---------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------
function toStatus(d: any): RecordingStatus {
  const c = d.counts ?? {};
  return {
    recordingId: d.recording_id,
    workspaceId: d.workspace_id ?? null,
    state: d.state,
    total: Number(d.total),
    totalSeconds: Number(d.total_seconds),
    counts: {
      pendingUpload: Number(c.pending_upload ?? 0), queued: Number(c.queued ?? 0), processing: Number(c.processing ?? 0),
      done: Number(c.done ?? 0), failed: Number(c.failed ?? 0), gaveUp: Number(c.gave_up ?? 0), canceled: Number(c.canceled ?? 0),
    },
    chargedMinutes: Number(d.charged_minutes ?? 0),
    retryUntil: d.retry_until ?? null,
    ackedAt: d.acked_at ?? null,
    segments: (d.segments ?? []).map((s: any): RecordingSegmentInfo => ({
      seq: Number(s.seq), status: s.status, errorCode: s.error_code ?? null, path: s.path, mimeType: s.mime_type,
      sizeBytes: Number(s.size_bytes), startSeconds: Number(s.start_seconds), durationSeconds: Number(s.duration_seconds),
      retainUntil: s.retain_until ?? null, hasTranscript: !!s.has_transcript,
    })),
  };
}

async function rpc(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<any> {
  let res: { data: any; error: any };
  try {
    res = await client.rpc(fn, args);
  } catch (e) {
    throw new RecordingError('NETWORK', '서버에 연결하지 못했어요', e);
  }
  if (res.error) {
    const msg = String(res.error.message ?? '');
    if (/AUTH_REQUIRED|JWT|permission denied/i.test(msg)) throw new RecordingError('AUTH_REQUIRED', '로그인이 필요해요', res.error);
    throw new RecordingError('NETWORK', '서버에 연결하지 못했어요', res.error);
  }
  if (res.data && res.data.ok === false) {
    throw new RecordingError(res.data.code ?? 'REJECTED', recordingErrorMessage({ code: res.data.code }), res.data);
  }
  return res.data;
}

async function byteLength(b: Uint8Array | ArrayBuffer | Blob): Promise<number> {
  if (typeof Blob !== 'undefined' && b instanceof Blob) return b.size;
  return b instanceof Uint8Array ? b.byteLength : (b as ArrayBuffer).byteLength;
}

/** 구간 길이(초)를 1~15분 사이 분 단위로 맞춤. 잘못된 값이면 기본 2분 */
export function normalizeSegmentSeconds(segmentSeconds: number): number {
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) return RECORDING_SEGMENT_SECONDS;
  const m = Math.min(RECORDING_SEGMENT_MINUTES.max, Math.max(RECORDING_SEGMENT_MINUTES.min, Math.round(segmentSeconds / 60)));
  return m * 60;
}

// ---------------------------------------------------------------------
// 3. 등록·업로드
// ---------------------------------------------------------------------
export interface RecordingSegmentFile {
  seq: number;              // 0부터
  durationSeconds: number;  // 분할 모듈이 알려 준 실제 길이
  sizeBytes: number;        // 구간 파일 크기 (서버가 올라온 파일과 비교)
  mimeType?: string;        // 기본 audio/mp4 (m4a)
}

/**
 * 녹음 등록. 같은 recordingId로 다시 부르면 기존 녹음을 돌려줘요(existing: true) → 이어서 업로드
 *   minutesNeeded > remainingMinutes면 "이번 달 남은 변환 시간 N분 — 앞부분만 변환돼요" 같은 안내를 보여 주세요
 */
export async function createRecording(client: SupabaseClient, input: {
  recordingId: string;
  segments: RecordingSegmentFile[];
  workspaceId?: string | null;   // 공유 공간 녹음 (편집 권한 필요). 개인 녹음은 생략
  languages?: string[];          // 기본 ko, en
  keywords?: string[];           // 사람·과목·프로젝트 이름 (정확도)
}): Promise<RecordingStatus & { existing: boolean; minutesNeeded: number | null; remainingMinutes: number; plan: string }> {
  if (input.segments.length === 0) throw new RecordingError('INVALID_REQUEST', '녹음 구간이 없어요');
  if (input.segments.length > RECORDING_MAX_SEGMENTS) {
    throw new RecordingError('TOO_MANY_SEGMENTS', recordingErrorMessage({ code: 'TOO_MANY_SEGMENTS' }));
  }
  const total = input.segments.reduce((a, s) => a + s.durationSeconds, 0);
  if (total > MAX_RECORDING_SECONDS + 60) throw new RecordingError('RECORDING_TOO_LONG', recordingErrorMessage({ code: 'RECORDING_TOO_LONG' }));
  const big = input.segments.find((s) => s.sizeBytes > RECORDING_MAX_SEGMENT_BYTES);
  if (big) throw new RecordingError('TOO_LARGE', recordingErrorMessage({ code: 'TOO_LARGE' }), { seq: big.seq });
  const d = await rpc(client, 'stt_recording_create', {
    p_recording_id: input.recordingId,
    p_segments: input.segments.map((s) => ({
      seq: s.seq, duration_seconds: Math.round(s.durationSeconds * 100) / 100, size_bytes: s.sizeBytes, mime_type: s.mimeType ?? 'audio/mp4',
    })),
    p_workspace_id: input.workspaceId ?? null,
    p_languages: input.languages ?? ['ko', 'en'],
    p_keywords: (input.keywords ?? []).map((k) => k.replace(/[<>\r\n]/g, ' ').trim().slice(0, 60)).filter(Boolean),
  });
  return {
    ...toStatus(d), existing: !!d.existing, minutesNeeded: d.minutes_needed ?? null,
    remainingMinutes: Number(d.remaining_minutes ?? 0), plan: d.plan ?? 'FREE',
  };
}

/**
 * 남은 구간 업로드 (끊겼다가 다시 불러도 됨: 업로드 대기 구간만 올림)
 *   readSegment(seq)       : 구간 파일 내용 (expo-file-system: await new File(uri).bytes())
 *   onSegmentConfirmed(seq): 서버가 확인·등록한 구간 → 그 구간 임시 파일을 지우세요
 *                            (이미 등록된 구간도 한 번 불러 줘요: 지난번에 못 지운 임시 파일 정리용)
 *   결과 allUploaded면 기기 원본을 지워도 돼요
 */
export async function uploadRecordingSegments(client: SupabaseClient, input: {
  recordingId: string;
  readSegment: (seq: number) => Promise<Uint8Array | ArrayBuffer | Blob>;
  onSegmentConfirmed?: (seq: number, info: { already: boolean }) => void | Promise<void>;
  onProgress?: (p: { uploaded: number; total: number }) => void;
  shouldStop?: () => boolean;    // 사용자가 화면을 나가는 등 멈춰야 할 때 true
}): Promise<{ allUploaded: boolean; uploadedNow: number[]; status: RecordingStatus }> {
  let status = await getRecordingStatus(client, input.recordingId);
  if (status.state === 'CANCELED') throw new RecordingError('CANCELED', recordingErrorMessage({ code: 'CANCELED' }));
  const uploadedNow: number[] = [];
  let uploaded = status.segments.filter((s) => s.status !== 'PENDING_UPLOAD').length;
  input.onProgress?.({ uploaded, total: status.total });

  for (const s of status.segments) {
    if (s.status !== 'PENDING_UPLOAD') {
      if (s.status !== 'GAVE_UP') await input.onSegmentConfirmed?.(s.seq, { already: true });
      continue;
    }
    if (input.shouldStop?.()) break;
    for (let attempt = 1; ; attempt++) {
      const bytes = await input.readSegment(s.seq);
      const size = await byteLength(bytes);
      if (size !== s.sizeBytes) {
        throw new RecordingError('SIZE_MISMATCH', '구간 파일이 등록할 때와 달라요. 녹음을 다시 나눠 주세요', { seq: s.seq, expected: s.sizeBytes, actual: size });
      }
      const body = typeof Blob !== 'undefined' && bytes instanceof Blob ? bytes : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
      const { error } = await client.storage.from(RECORDING_BUCKET).upload(s.path, body, { contentType: s.mimeType, upsert: true });
      if (error) throw new RecordingError('UPLOAD_FAILED', recordingErrorMessage({ code: 'UPLOAD_FAILED' }), { seq: s.seq, error });
      const { data, error: cErr } = await client.rpc('stt_segment_confirm', { p_recording_id: input.recordingId, p_seq: s.seq });
      if (cErr) throw new RecordingError('NETWORK', '서버에 연결하지 못했어요', cErr);
      if (data?.ok) break;
      // 올라갔는데 확인이 안 되면(크기 다름·아직 안 보임) 한 번 더 올림
      if (attempt < 2 && (data?.code === 'SIZE_MISMATCH' || data?.code === 'NOT_UPLOADED')) continue;
      throw new RecordingError(data?.code ?? 'UPLOAD_FAILED', recordingErrorMessage({ code: data?.code ?? 'UPLOAD_FAILED' }), data);
    }
    uploadedNow.push(s.seq);
    uploaded++;
    input.onProgress?.({ uploaded, total: status.total });
    await input.onSegmentConfirmed?.(s.seq, { already: false });
  }
  status = await getRecordingStatus(client, input.recordingId);
  return { allUploaded: status.counts.pendingUpload === 0 && status.state !== 'CANCELED', uploadedNow, status };
}

// ---------------------------------------------------------------------
// 4. 진행 상태·재시도·취소
// ---------------------------------------------------------------------
export async function getRecordingStatus(client: SupabaseClient, recordingId: string): Promise<RecordingStatus> {
  return toStatus(await rpc(client, 'stt_recording_status', { p_recording_id: recordingId }));
}

/** 더 기다려도 바뀌지 않는 상태인지 (사용자 행동이 필요하거나 끝남) */
export function isRecordingSettled(state: RecordingState): boolean {
  return state !== 'UPLOADING' && state !== 'PROCESSING';
}

/**
 * 진행 문구 (줄 단위). 예)
 *   ["음성 변환 중 · 90개 중 24개 완료", "실패한 구간 1개 · 재시도 가능"]
 */
export function recordingProgressText(s: RecordingStatus, now = new Date()): { lines: string[]; canRetry: boolean } {
  const c = s.counts;
  const lines: string[] = [];
  const canRetry = c.failed > 0 && (!s.retryUntil || new Date(s.retryUntil) > now);
  switch (s.state) {
    case 'UPLOADING': lines.push(`업로드 중 · ${s.total}개 중 ${s.total - c.pendingUpload}개 올림`); break;
    case 'PROCESSING': lines.push(`음성 변환 중 · ${s.total}개 중 ${c.done}개 완료`); break;
    case 'NEEDS_RETRY': lines.push(`음성 변환 · ${s.total}개 중 ${c.done}개 완료`); break;
    case 'DONE': lines.push('음성 변환 완료'); break;
    case 'DONE_WITH_GAPS': lines.push(`음성 변환 완료 · ${c.gaveUp + c.canceled}개 구간은 복구하지 못함`); break;
    case 'FAILED': lines.push('음성 변환 실패'); break;
    case 'CANCELED': lines.push('취소됨'); break;
  }
  if (c.failed > 0 && s.state !== 'CANCELED') {
    lines.push(canRetry ? `실패한 구간 ${c.failed}개 · 재시도 가능${s.retryUntil ? ` (${formatDeadline(s.retryUntil)}까지)` : ''}`
                        : `실패한 구간 ${c.failed}개`);
  }
  return { lines, canRetry };
}

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return p.format(d);
}

/** 실패 구간 다시 시도 (seqs 생략하면 전부). 보관 기한(최초 실패 + 3일)은 늘어나지 않아요 */
export async function retryRecordingSegments(client: SupabaseClient, recordingId: string, seqs?: number[]): Promise<number> {
  const d = await rpc(client, 'stt_recording_retry', { p_recording_id: recordingId, p_seqs: seqs ?? null });
  return Number(d.requeued ?? 0);
}

/** 취소: 새 처리 중단, 서버의 음성·전사문 정리. 기기 임시 파일은 앱이 지우세요 */
export async function cancelRecording(client: SupabaseClient, recordingId: string): Promise<void> {
  await rpc(client, 'stt_recording_cancel', { p_recording_id: recordingId });
}

/**
 * 진행 상태를 주기적으로 받기. 끝나거나 사용자 행동이 필요해지면(isRecordingSettled) 스스로 멈춤
 *   업로드 중에는 업로드와 함께 쓰세요. 앱을 닫아도 서버 처리는 계속돼요
 */
export function watchRecording(client: SupabaseClient, recordingId: string, opts: {
  onUpdate: (s: RecordingStatus) => void;
  onError?: (e: unknown) => void;
  intervalMs?: number;
}): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const s = await getRecordingStatus(client, recordingId);
      if (stopped) return;
      opts.onUpdate(s);
      if (isRecordingSettled(s.state)) { stopped = true; return; }
    } catch (e) {
      opts.onError?.(e);
    }
    if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? 4000);
  };
  void tick();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

// ---------------------------------------------------------------------
// 5·6. 전사문 받기 → (사용자 확인·수정 → analyzeMemo) → 저장 후 ack
// ---------------------------------------------------------------------
export interface RecordingTranscript {
  /**
   * 구간 순서대로 이은 글. 구간마다 녹음 시작 기준 시각 "[12:00]" / "[1:02:00]"을 앞에 붙임
   * 빠진 구간은 "[구간 7 (12:00~14:00) 변환 실패]" 표시
   */
  text: string;
  /** 시각 표시 없이 이은 글 (빠진 구간 표시는 그대로) */
  plainText: string;
  segments: { seq: number; status: SegmentStatus; startSeconds: number; durationSeconds: number; text: string | null; languages: string[]; timeLabel: string }[];
  missing: { seq: number; status: SegmentStatus; errorCode: string | null; startSeconds: number; durationSeconds: number }[];
  /** 모든 구간이 전사됨 */
  complete: boolean;
  state: RecordingState;
}

/** 전사문 구간 시각 표시 "[12:00]" (1시간 넘으면 "[1:02:00]") */
export function segmentTimeLabel(startSeconds: number): string {
  return `[${formatClock(startSeconds)}]`;
}

export function missingSegmentMarker(seq: number, startSeconds: number, durationSeconds: number, status: SegmentStatus): string {
  const what = status === 'QUEUED' || status === 'PROCESSING' || status === 'PENDING_UPLOAD' ? '변환 중' : '변환 실패';
  return `[구간 ${seq + 1} (${formatClock(startSeconds)}~${formatClock(startSeconds + durationSeconds)}) ${what}]`;
}

export async function getRecordingTranscript(client: SupabaseClient, recordingId: string): Promise<RecordingTranscript> {
  const d = await rpc(client, 'stt_recording_transcript', { p_recording_id: recordingId });
  const segments = (d.segments ?? []).map((s: any) => ({
    seq: Number(s.seq), status: s.status as SegmentStatus, errorCode: s.error_code ?? null,
    startSeconds: Number(s.start_seconds), durationSeconds: Number(s.duration_seconds),
    text: typeof s.text === 'string' ? s.text : null, languages: s.languages ?? [],
    timeLabel: segmentTimeLabel(Number(s.start_seconds)),
  }));
  const ok = (s: any) => s.status === 'DONE' && s.text !== null;
  const marker = (s: any) => missingSegmentMarker(s.seq, s.startSeconds, s.durationSeconds, s.status);
  // 내용 없는 구간(무음)은 시각만 남기지 않고 건너뜀
  const parts = segments.map((s: any) => ok(s) ? (s.text.trim() ? `${s.timeLabel} ${s.text.trim()}` : '') : marker(s));
  const plainParts = segments.map((s: any) => ok(s) ? s.text.trim() : marker(s));
  const missing = segments.filter((s: any) => !(s.status === 'DONE' && s.text !== null))
    .map((s: any) => ({ seq: s.seq, status: s.status, errorCode: s.errorCode, startSeconds: s.startSeconds, durationSeconds: s.durationSeconds }));
  return {
    text: parts.filter((p: string) => p.length > 0).join('\n\n'),
    plainText: plainParts.filter((p: string) => p.length > 0).join('\n\n'),
    segments: segments.map(({ errorCode: _e, ...rest }: any) => rest),
    missing, complete: missing.length === 0, state: d.state,
  };
}

/** 전사문을 기기(SQLite)·공유 공간에 저장한 뒤 호출 → 서버 임시 전사문 삭제 */
export async function ackRecordingTranscript(client: SupabaseClient, recordingId: string): Promise<number> {
  const d = await rpc(client, 'stt_recording_ack', { p_recording_id: recordingId });
  return Number(d.cleared ?? 0);
}

/** 오류 → 화면 문구 */
export function recordingErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'CONSENT_REQUIRED': return '녹음을 글자로 바꾸려면 외부 AI 사용 동의가 필요해요';
    case 'FORBIDDEN': return '이 공간에 녹음을 저장할 권한이 없어요';
    case 'RECORDING_TOO_LONG': return '녹음은 3시간까지 처리할 수 있어요';
    case 'TOO_LARGE': return '구간 파일이 너무 커요 (25MB까지). 더 짧게 나눠 주세요';
    case 'UNSUPPORTED_TYPE': return '이 형식은 처리할 수 없어요 (m4a·mp3)';
    case 'TOO_MANY_SEGMENTS': return '구간이 너무 많아요 (200개까지)';
    case 'TOO_MANY_ACTIVE': return '처리 중인 녹음이 3개 있어요. 끝난 뒤에 다시 시도해 주세요';
    case 'RECORDING_EXISTS': case 'RECORDING_ID_TAKEN': return '이미 등록된 녹음이에요. 새 녹음으로 다시 시도해 주세요';
    case 'UPLOAD_FAILED': case 'NOT_UPLOADED': return '구간을 올리지 못했어요. 연결을 확인하면 남은 구간부터 이어서 올려요';
    case 'SIZE_MISMATCH': return '구간 파일이 손상됐어요. 녹음을 다시 나눠 주세요';
    case 'CANCELED': return '취소된 녹음이에요';
    case 'NOT_FOUND': return '서버에 이 녹음이 없어요 (정리됐거나 다른 계정)';
    case 'QUOTA_EXCEEDED': return '이번 달 녹음 변환 시간을 모두 썼어요';
    case 'AUTH_REQUIRED': return '로그인이 필요해요';
    case 'NETWORK': return '서버에 연결하지 못했어요. 연결을 확인해 주세요';
    default: return '녹음을 처리하지 못했어요. 잠시 후 다시 시도해 주세요';
  }
}

/** 구간 실패 이유 → 짧은 문구 (실패 구간 목록에) */
export function segmentErrorMessage(code: string | null): string {
  switch (code) {
    case 'QUOTA_EXCEEDED': return '이번 달 변환 시간 초과';
    case 'AUDIO_REJECTED': case 'AUDIO_MISSING': return '음성을 읽지 못함';
    case 'UPLOAD_EXPIRED': return '3일 안에 올리지 못함';
    case 'CONSENT_REQUIRED': return '외부 AI 동의 필요';
    case 'FORBIDDEN': return '공간 권한 없음';
    case 'PROVIDER_TIMEOUT': return '변환 시간 초과';
    default: return '일시 오류';
  }
}
