// 녹음 → 글자 (AI Gateway `/transcribe`, OpenAI gpt-transcribe) — 노션 모바일 방식
//
//  ① 녹음을 서버 임시 보관함(비공개 버킷)에 올림  ② 서버가 꺼내서 글자로 바꿈
//  ③ 성공하면 서버가 녹음을 바로 지움 / 실패하면 3일 보관 → 다시 올리지 않고 다시 변환 가능
//  올리고 변환하지 않은 녹음도 3일 뒤 자동 삭제
//
//  const uploadId = newId(), clientRequestId = newId();   // 둘 다 녹음 파일 경로와 함께 기기 DB에 저장
//  const r = await transcribeAudio(supabase, {
//    uploadId, clientRequestId,
//    bytes: await new File(recorder.uri).bytes(),         // expo-file-system (SDK 54+). RN은 uri로 바로 못 올려서 bytes로
//    durationSeconds: state.durationMillis / 1000,
//    keywords: ['Stella', '손주원'],
//  });
//  실패하면 retryPlan(e.code)로 다음 행동을 정하세요 (같은 요청 / 새 요청·같은 녹음 / 다시 올리기 / 중단)
//
//  이 파일은 react-native를 쓰지 않아요
import type { SupabaseClient } from '@supabase/supabase-js';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

export const STT_MAX_SECONDS = 1800;
export const STT_MAX_BYTES = 25 * 1024 * 1024;
export const STT_MONTHLY_MINUTES = { FREE: 60, PRO: 600 } as const;
export const STT_UPLOAD_KEEP_DAYS = 3;

export class TranscribeError extends Error {
  constructor(public code: string, message: string, public status?: number, public detail?: unknown) {
    super(message);
    this.name = 'TranscribeError';
  }
}

export interface UploadRecordingInput {
  /** newId()로 만들고 녹음 파일과 함께 저장. 실패 후 다시 변환할 때 같은 값 */
  uploadId: string;
  /** 녹음 내용 (expo-file-system: await new File(uri).bytes()) */
  bytes: Uint8Array | ArrayBuffer | Blob;
  /** 기본 audio/mp4 (.m4a) */
  mimeType?: string;
  /** 확장자로 형식을 알려 줄 때 (기본 recording.m4a). 이름은 OpenAI에 보내지 않아요 */
  fileName?: string;
}

export interface TranscribeUploadedInput {
  /** newId(). 같은 요청을 다시 보낼 때 같은 값 */
  clientRequestId: string;
  uploadId: string;
  /** 녹음 길이(초). expo-audio: recorderState.durationMillis / 1000 */
  durationSeconds: number;
  /** 공유 공간 녹음이면 공간 id */
  workspaceId?: string | null;
  /** 녹음에 나올 수 있는 언어. 기본 ['ko', 'en'] */
  languages?: string[];
  /** 정확히 받아 적어야 할 말 (사람·프로젝트·용어). 50개·각 60자까지 */
  keywords?: string[];
  /** 주제 설명이나 앞 조각의 끝부분. 1000자까지 */
  prompt?: string | null;
}

export interface TranscribeResult {
  requestId: string;
  text: string;
  languages: string[];
  durationSeconds: number;
  chargedMinutes: number;
  remainingMinutes: number;
  model: string;
  inputHash: string;
  /** 서버가 녹음을 지웠는지 (못 지웠으면 다음 정리 때 지워짐) */
  uploadDeleted: boolean;
}

type ServerOk = {
  ok: true; request_id: string; model: string; draft: { text: string; languages: string[] };
  duration_seconds: number; charged_minutes: number; remaining_minutes: number; input_hash: string; upload_deleted: boolean;
};

async function invoke<T>(client: SupabaseClient, path: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.functions.invoke<T>(`ai-gateway/${path}`, { body });
  if (!error) return data as T;
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    let payload: { code?: string; message?: string } | null = null;
    try { payload = await res.json(); } catch { /* 본문 없음 */ }
    throw new TranscribeError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? '녹음 변환 요청이 실패했습니다', res.status, payload);
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    throw new TranscribeError('NETWORK', '서버에 연결하지 못했어요. 잠시 후 다시 시도하세요', undefined, error);
  }
  throw new TranscribeError('UNKNOWN', String((error as Error)?.message ?? error), undefined, error);
}

function toUint8(b: Uint8Array | ArrayBuffer): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

/** ① 녹음을 서버 임시 보관함에 올리기 (같은 uploadId로 다시 부르면 덮어씀) */
export async function uploadRecording(client: SupabaseClient, input: UploadRecordingInput): Promise<{ uploadId: string; expiresAt: string }> {
  const type = (input.mimeType ?? 'audio/mp4').toLowerCase();
  const isBlob = typeof Blob !== 'undefined' && input.bytes instanceof Blob;
  const size = isBlob ? (input.bytes as Blob).size : toUint8(input.bytes as Uint8Array | ArrayBuffer).byteLength;
  if (size === 0) throw new TranscribeError('INVALID_REQUEST', '빈 녹음 파일이에요');
  if (size > STT_MAX_BYTES) throw new TranscribeError('TOO_LARGE', '녹음 파일은 25MB까지 보낼 수 있어요');

  const prep = await invoke<{ ok: true; bucket: string; path: string; token: string; expires_at: string }>(client, 'transcribe/prepare', {
    upload_id: input.uploadId, mime_type: type, size_bytes: size, file_name: input.fileName ?? 'recording.m4a',
  });
  const body = isBlob ? (input.bytes as Blob) : toUint8(input.bytes as Uint8Array | ArrayBuffer);
  const { error } = await client.storage.from(prep.bucket).uploadToSignedUrl(prep.path, prep.token, body, { contentType: type, upsert: true });
  if (error) throw new TranscribeError('UPLOAD_FAILED', '녹음을 올리지 못했어요. 연결을 확인하고 같은 녹음으로 다시 시도하세요', undefined, error);
  return { uploadId: input.uploadId, expiresAt: prep.expires_at };
}

/** ② 올린 녹음 → 글자 초안. 실패하면 녹음은 3일 남아 있어서 같은 uploadId로 다시 부르면 돼요 */
export async function transcribeUploaded(client: SupabaseClient, input: TranscribeUploadedInput): Promise<TranscribeResult> {
  const dur = Number(input.durationSeconds);
  if (!Number.isFinite(dur) || dur <= 0) throw new TranscribeError('INVALID_REQUEST', '녹음 길이를 알 수 없어요');
  if (dur > STT_MAX_SECONDS) throw new TranscribeError('DURATION_TOO_LONG', `한 번에 ${STT_MAX_SECONDS / 60}분까지 보낼 수 있어요. 녹음을 나눠 주세요`);
  const keywords = (input.keywords ?? []).map((k) => k.replace(/[<>\r\n]/g, ' ').trim().slice(0, 60)).filter(Boolean);
  const d = await invoke<ServerOk>(client, 'transcribe', {
    client_request_id: input.clientRequestId,
    upload_id: input.uploadId,
    duration_seconds: Math.round(dur * 10) / 10,
    workspace_id: input.workspaceId ?? null,
    languages: input.languages ?? ['ko', 'en'],
    keywords,
    prompt: input.prompt ? input.prompt.slice(-1000) : null,
  });
  return {
    requestId: d.request_id, text: d.draft.text, languages: d.draft.languages, durationSeconds: d.duration_seconds,
    chargedMinutes: d.charged_minutes, remainingMinutes: d.remaining_minutes, model: d.model, inputHash: d.input_hash,
    uploadDeleted: d.upload_deleted,
  };
}

/** ①+② 한 번에 */
export async function transcribeAudio(
  client: SupabaseClient,
  input: UploadRecordingInput & TranscribeUploadedInput,
): Promise<TranscribeResult> {
  const dur = Number(input.durationSeconds);
  if (!Number.isFinite(dur) || dur <= 0) throw new TranscribeError('INVALID_REQUEST', '녹음 길이를 알 수 없어요');
  if (dur > STT_MAX_SECONDS) throw new TranscribeError('DURATION_TOO_LONG', `한 번에 ${STT_MAX_SECONDS / 60}분까지 보낼 수 있어요. 녹음을 나눠 주세요`);
  await uploadRecording(client, input);
  return transcribeUploaded(client, input);
}

export type RetryPlan = 'same_request' | 'new_request_same_upload' | 'reupload' | 'stop';

/**
 * 실패했을 때 다음 행동
 *   same_request            잠시 뒤 같은 clientRequestId·uploadId로 transcribeUploaded
 *   new_request_same_upload 새 clientRequestId, 같은 uploadId로 transcribeUploaded (다시 올릴 필요 없음)
 *   reupload                uploadRecording부터 다시 (지워졌거나 안 올라감)
 *   stop                    사용자에게 알리고 멈춤 (동의·한도·형식·길이 등)
 */
export function retryPlan(code: string): RetryPlan {
  if (['NETWORK', 'PROVIDER_ERROR', 'PROVIDER_UNREACHABLE', 'PROVIDER_RATE_LIMITED', 'PROVIDER_BAD_RESPONSE',
       'IN_PROGRESS', 'INTERNAL', 'STORAGE_ERROR'].includes(code)) return 'same_request';
  if (['PROVIDER_TIMEOUT', 'RESULT_UNKNOWN', 'REQUEST_ID_REUSED'].includes(code)) return 'new_request_same_upload';
  if (['NOT_UPLOADED', 'UPLOAD_GONE', 'UPLOAD_FAILED', 'NOT_FOUND'].includes(code)) return 'reupload';
  return 'stop';
}

/** 같은 clientRequestId로 다시 시도해도 되는지 (retryPlan === 'same_request') */
export function canRetryTranscribe(code: string): boolean {
  return retryPlan(code) === 'same_request';
}

/** 나눠 녹음한 다음 조각에 넘길 prompt: 앞 조각의 끝부분 (문장 중간에서 자르지 않게) */
export function continuationPrompt(previousText: string, maxChars = 300): string | null {
  const t = previousText.trim();
  if (!t) return null;
  if (t.length <= maxChars) return t;
  const tail = t.slice(-maxChars);
  const cut = tail.search(/[.!?。]\s|\n/);
  return (cut >= 0 && cut < maxChars / 2 ? tail.slice(cut + 1) : tail).trim();
}

/** 이번 달 녹음 변환 사용량 (분). 남은 분 = STT_MONTHLY_MINUTES[plan] - used - reserved */
export async function getSttUsage(client: SupabaseClient, now = new Date()): Promise<{ usedMinutes: number; reservedMinutes: number }> {
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(now);
  const { data, error } = await client
    .from('usage_counters')
    .select('used, reserved')
    .eq('metric', 'AI_STT')
    .eq('period_start', `${ym.slice(0, 7)}-01`)
    .maybeSingle();
  if (error) throw new TranscribeError('NETWORK', '사용량을 불러오지 못했어요', undefined, error);
  return { usedMinutes: Number(data?.used ?? 0), reservedMinutes: Number(data?.reserved ?? 0) };
}

/** 오류 → 화면 문구 */
export function transcribeErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'CONSENT_REQUIRED': return '녹음을 글자로 바꾸려면 외부 AI 사용 동의가 필요해요';
    case 'QUOTA_EXCEEDED': return '이번 달 녹음 변환 시간을 모두 썼어요';
    case 'DURATION_TOO_LONG': return `녹음은 한 번에 ${STT_MAX_SECONDS / 60}분까지 바꿀 수 있어요. 나눠서 녹음해 주세요`;
    case 'TOO_LARGE': return '녹음 파일이 너무 커요 (25MB까지)';
    case 'UNSUPPORTED_TYPE': return '이 형식의 녹음은 바꿀 수 없어요 (m4a·mp3·wav)';
    case 'AUDIO_REJECTED': return '녹음 파일을 읽지 못했어요. 다시 녹음해 주세요';
    case 'FORBIDDEN': return '이 공간의 녹음을 바꿀 권한이 없어요';
    case 'TOO_MANY_PENDING': return '변환을 기다리는 녹음이 너무 많아요. 먼저 변환해 주세요';
    case 'UPLOAD_FAILED': case 'NOT_UPLOADED': return '녹음을 올리지 못했어요. 연결을 확인하고 다시 시도해 주세요';
    case 'UPLOAD_GONE': case 'NOT_FOUND': return '서버에 녹음이 없어요(변환이 끝났거나 3일이 지남). 다시 올려 주세요';
    case 'PROVIDER_TIMEOUT': case 'RESULT_UNKNOWN':
      return '변환이 늦어 결과를 받지 못했어요. 녹음은 서버에 3일 남아 있어서 다시 시도할 수 있어요';
    case 'ALREADY_DONE': return '이미 변환한 녹음이에요';
    case 'IN_PROGRESS': return '변환 중이에요. 잠시 후 다시 확인해 주세요';
    case 'AUTH_REQUIRED': return '로그인이 필요해요';
    case 'NOT_CONFIGURED': case 'PROVIDER_AUTH_FAILED': case 'PROVIDER_BAD_REQUEST':
      return '지금은 녹음 변환을 쓸 수 없어요 (서버 설정 확인 필요)';
    case 'NETWORK': case 'STORAGE_ERROR': return '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요';
    default: return '녹음을 글자로 바꾸지 못했어요. 잠시 후 다시 시도해 주세요';
  }
}
