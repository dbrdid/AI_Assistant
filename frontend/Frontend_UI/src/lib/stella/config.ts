// 앱 연결 정보
//   .env에 EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY를 넣으면 그 값을 쓰고, 없으면 아래 기본값을 씁니다.
//   publishable 키는 앱에 넣으라고 만든 공개용 키라 코드에 있어도 됩니다.
//   ⚠️ service_role·secret·OpenAI 키는 절대 앱에 넣지 마세요.
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'https://zcblwwcukkbcwmgugknl.supabase.co';
export const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_KEY ?? 'sb_publishable_mgBnoYrbmRRkhtykoMKEwg_mrf_sGvT';

/** 기본 시간대 (사용자 설정이 없을 때) */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

/** 동의 문서 버전: 약관·개인정보·외부 AI 안내 문구를 바꾸면 올리고, 사용자에게 다시 동의받기 */
export const POLICY_VERSION = '2026-11-08';

/** 월 AI 사용 한도 (서버 private.ai_monthly_limit과 같게 유지) */
export const AI_MONTHLY_LIMITS = {
  FREE: { organize: 100, analyze: 30, query: 50, stt: 30, ocr: 30, image: 30 },
  PRO: { organize: 1000, analyze: 300, query: 500, stt: 300, ocr: 300, image: 300 },
} as const;
