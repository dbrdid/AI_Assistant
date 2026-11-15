// 로그인 규칙 (프론트 화면 기준, 2026-11-15 결정) — React Native 의존 없음
//   비밀번호: 영문 + 숫자 + 특수문자를 모두 포함, 8자 이상 (앱 AuthApi.checkPasswordRule과 같은 식)
//             서버(Supabase Auth)는 "8자 이상 · 영문+숫자"까지만 강제해요. Supabase 설정에는
//             "영문+숫자+특수문자" 조합이 없어서(특수문자를 넣으면 대소문자도 강제됨) 특수문자는 앱에서 검사합니다.
//   로그인 잠금: 같은 이메일로 비밀번호를 5번 틀리면 10분 잠금. 이 기기 안에서만 셈 (서버는 IP 기준 요청 제한만)
//             잠금이 풀린 뒤에는 처음부터 다시 셈, 로그인 성공·비밀번호 재설정이면 바로 풀림

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RULE_HINT = '영문 + 숫자 + 특수문자를 포함해 8자 이상';
export const PASSWORD_RULE_MESSAGE = '비밀번호는 영문과 숫자, 특수문자를\n반드시 포함시켜야 합니다 (8자 이상).';

/** 앱 규칙: 영문 + 숫자 + 특수문자(공백 제외) 모두 포함, 8자 이상 */
export function checkPasswordRule(pw: string | null | undefined): boolean {
  const s = String(pw ?? '');
  return s.length >= PASSWORD_MIN_LENGTH && /[A-Za-z]/.test(s) && /[0-9]/.test(s) && /[^A-Za-z0-9\s]/.test(s);
}

export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MS = 10 * 60 * 1000;

/** 잠금 기록을 둘 곳 (앱: AsyncStorage, 테스트: 메모리) */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

type Attempt = { count: number; lockedUntil: number };
const STORE_KEY = 'stella.auth.attempts.v1';
export const normEmail = (e: string | null | undefined) => String(e ?? '').trim().toLowerCase();

/** 로그인 실패 횟수·잠금 관리 (이메일별) */
export function createLoginGuard(store: KeyValueStore, now: () => number = Date.now) {
  const read = async (): Promise<Record<string, Attempt>> => {
    try { return JSON.parse((await store.getItem(STORE_KEY)) ?? '{}') as Record<string, Attempt>; } catch { return {}; }
  };
  const write = (all: Record<string, Attempt>) => store.setItem(STORE_KEY, JSON.stringify(all)).catch(() => undefined);

  return {
    /** 잠겨 있으면 풀리는 시각(ms), 아니면 null */
    async lockedUntil(email: string): Promise<number | null> {
      const a = (await read())[normEmail(email)];
      return a?.lockedUntil && now() < a.lockedUntil ? a.lockedUntil : null;
    },
    /** 비밀번호가 틀렸을 때. 5번째면 잠그고 풀리는 시각을 돌려줌 */
    async recordFailure(email: string): Promise<{ count: number; lockedUntil: number | null }> {
      const all = await read();
      const key = normEmail(email);
      const a = all[key] ?? { count: 0, lockedUntil: 0 };
      const count = (a.lockedUntil && now() >= a.lockedUntil ? 0 : a.count) + 1;
      if (count >= LOGIN_MAX_FAILS) {
        const until = now() + LOGIN_LOCK_MS;
        all[key] = { count: 0, lockedUntil: until };
        await write(all);
        return { count, lockedUntil: until };
      }
      all[key] = { count, lockedUntil: 0 };
      await write(all);
      return { count, lockedUntil: null };
    },
    /** 로그인 성공·비밀번호 재설정 → 기록 지움 (잠금도 풀림) */
    async clear(email: string): Promise<void> {
      const all = await read();
      const key = normEmail(email);
      if (!(key in all)) return;
      delete all[key];
      await write(all);
    },
  };
}
export type LoginGuard = ReturnType<typeof createLoginGuard>;

/** 잠금 오류 (authErrorMessage가 "비밀번호 5회 불일치" 문구로 바꿈) */
export function loginLockedError(lockedUntil: number): Error & { code: 'login_locked'; lockedUntil: number } {
  return Object.assign(new Error('비밀번호 5회 불일치. 10분 후 다시 시도해주세요'), { code: 'login_locked' as const, lockedUntil });
}
