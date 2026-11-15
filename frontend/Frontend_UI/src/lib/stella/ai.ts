// AI Gateway 호출 (서버가 OpenAI를 대신 호출. 앱에는 API 키 없음)
//
//  흐름: 외부 AI 동의 확인 → organize / analyze / ocr → 초안을 화면에 보여줌 → 사용자 승인 → sync_push(또는 기기 SQLite)로 저장
//    - 결과는 초안일 뿐 서버 어디에도 저장되지 않습니다.
//    - clientRequestId: 한 번의 "AI 실행"마다 새로 만들고, 네트워크 오류 등으로 재시도할 때는 같은 값을 쓰세요.
//      canRetryWithSameRequestId(err.code)가 false면 새 값으로 다시 요청해야 합니다.
//    - workspaceId: 공유 공간의 기록을 보낼 때만. 개인 기록이면 생략
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { DEFAULT_TIMEZONE } from './config';
import { AiError } from './errors';
import { supabase } from './supabase';
import type { AnalyzeResponse, OcrResponse, OrganizeResponse } from './types';

export const AI_MAX_CHARS = { organize: 8000, analyze: 60000 } as const;   // analyze 60,000자 ≈ 한국어 녹음 3시간
/** 사진 → 글자: 한 번에 5장, 한 장 5MB, 합계 10MB (앱에서 긴 변 2048px JPEG로 줄여 보내기 권장) */
export const OCR_LIMITS = { maxImages: 5, maxImageBytes: 5 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, recommendedMaxSide: 2048 } as const;

async function invoke<T>(path: 'organize' | 'analyze' | 'ocr', body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(`ai-gateway/${path}`, { body });
  if (!error) return data as T;

  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    let payload: { code?: string; message?: string } | null = null;
    try {
      payload = await res.json();
    } catch { /* 본문 없음 */ }
    throw new AiError(payload?.code ?? `HTTP_${res.status}`, payload?.message ?? 'AI 요청이 실패했습니다', res.status, payload);
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    // 서버에 닿지 못함 → 같은 clientRequestId로 재시도 가능
    throw new AiError('NETWORK', '서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요', undefined, error);
  }
  throw new AiError('UNKNOWN', String(error?.message ?? error), undefined, error);
}

/** 메모 정리 초안 (제목·요약·정리본·키워드). 텍스트 8,000자까지 */
export function organizeMemo(p: { clientRequestId: string; text: string; workspaceId?: string }) {
  return invoke<OrganizeResponse>('organize', {
    client_request_id: p.clientRequestId,
    text: p.text,
    workspace_id: p.workspaceId ?? null,
  });
}

/**
 * 요약·할 일·일정 추출 초안. 텍스트 60,000자(약 3시간)까지
 *   kind: 'MEETING'이면 회의록 요약(3~6문장)과 안건별 정리(draft.topics)도 함께 → 승인 후 meetingTopicsToAgendaOps
 *   kind: 'LECTURE'면 강의 요약 + 내용 흐름(topics) + 주요 개념(draft.key_concepts), 과제는 tasks·시험은 events
 *   녹음 전사문의 "[구간 N … 변환 실패]" 표시는 그대로 보내세요 (그 부분은 추측하지 않음)
 *   결과의 날짜·시각은 timezone 기준 현지 값 → 승인 후 analyzeDraftToOps로 ops 변환
 *   draft.open_questions는 사용자에게 꼭 보여주세요 (날짜·담당자가 불명확한 항목)
 */
export function analyzeMemo(p: {
  clientRequestId: string;
  text: string;
  kind?: 'MEETING' | 'LECTURE' | 'MEMO';
  timezone?: string;
  workspaceId?: string;
}) {
  return invoke<AnalyzeResponse>('analyze', {
    client_request_id: p.clientRequestId,
    text: p.text,
    kind: p.kind ?? 'MEMO',
    timezone: p.timezone ?? DEFAULT_TIMEZONE,
    workspace_id: p.workspaceId ?? null,
  });
}

/**
 * 사진 → 글자 초안 (Terra가 사진을 직접 읽음, 사진은 서버에 남지 않음)
 *   images: base64 문자열(expo-image-manipulator의 base64 결과 그대로) 1~5장, 장 순서 = 쪽 순서
 *   hint: "강의 판서", "회의 화이트보드"처럼 짧은 설명 (200자까지, 선택)
 *   결과 draft.text를 사용자가 확인·수정한 뒤 저장(원문 kind 'IMAGE'). 할 일·일정은 그 글로 analyzeMemo
 */
export async function ocrImages(p: { clientRequestId: string; images: string[]; hint?: string; workspaceId?: string }) {
  if (p.images.length === 0) throw new AiError('INVALID_REQUEST', '사진을 1장 이상 골라 주세요');
  if (p.images.length > OCR_LIMITS.maxImages) throw new AiError('TOO_MANY_IMAGES', `사진은 한 번에 ${OCR_LIMITS.maxImages}장까지 보낼 수 있어요`);
  const sizes = p.images.map((b) => Math.floor((b.replace(/^data:[^;,]*;base64,/, '').length * 3) / 4));
  if (sizes.some((n) => n > OCR_LIMITS.maxImageBytes) || sizes.reduce((a, n) => a + n, 0) > OCR_LIMITS.maxTotalBytes) {
    throw new AiError('TOO_LARGE', '사진이 너무 커요. 줄여서 보내 주세요 (한 장 5MB, 합계 10MB까지)');
  }
  return invoke<OcrResponse>('ocr', {
    client_request_id: p.clientRequestId,
    images: p.images.map((base64) => ({ base64 })),
    hint: p.hint?.slice(0, 200) ?? null,
    workspace_id: p.workspaceId ?? null,
  });
}

/** 사용자에게 보여줄 문구 (서버 message가 있으면 그대로, 없으면 코드별 기본 문구) */
export function aiErrorMessage(err: unknown): string {
  if (!(err instanceof AiError)) return 'AI 처리 중 문제가 생겼습니다';
  const fallback: Record<string, string> = {
    CONSENT_REQUIRED: '외부 AI 사용에 동의해야 이 기능을 쓸 수 있습니다',
    QUOTA_EXCEEDED: '이번 달 AI 사용 횟수를 모두 썼습니다',
    INPUT_TOO_LONG: '글이 너무 깁니다. 나눠서 요청해 주세요',
    NETWORK: '인터넷 연결을 확인해 주세요',
    TOO_LARGE: '사진이 너무 커요. 줄여서 보내 주세요',
    TOO_MANY_IMAGES: '사진은 한 번에 5장까지 보낼 수 있어요',
    UNSUPPORTED_TYPE: '이 사진 형식은 읽을 수 없어요 (JPEG·PNG·WebP)',
  };
  return fallback[err.code] ?? err.message;
}
