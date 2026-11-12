// ============================================================
// AuthApi.js — 로그인·회원가입·인증번호·비밀번호 재설정 "서버 역할" (★ 지금은 이 기기 안에서 흉내내는 임시 버전)
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const ACCOUNTS_KEY = 'myapp.accounts.v1';
const ATTEMPTS_KEY = 'myapp.auth.attempts.v1';

export const CODE_SECONDS = 180; // 인증번호 유효시간 3분
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const isEmailFormat = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());

// 영문 + 숫자 + 특수문자를 모두 포함, 8자 이상
export function checkPasswordRule(pw) {
  const s = String(pw || '');
  return s.length >= 8 && /[A-Za-z]/.test(s) && /[0-9]/.test(s) && /[^A-Za-z0-9\s]/.test(s);
}

// ---- 임시 해시 (실서비스용 아님) ----
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const hashPw = (pw, salt) => fnv(`${salt}:${pw}`, 2166136261) + fnv(`${pw}:${salt}`, 5381) + fnv(`${salt}${pw}${salt}`, 99991);
const makeSalt = () => Math.random().toString(36).slice(2, 10);

// ---- 저장소 ----
async function readJson(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
const loadAccounts = () => readJson(ACCOUNTS_KEY, {});
const saveAccounts = (a) => AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a)).catch(() => {});

const fail = (type, title, message) => ({ ok: false, error: { type, title, message } });

// ---- 인증번호 (메모리에만 보관) ----
const codes = {}; // { [email]: { code, expiresAt } }

export async function sendCode(email) {
  const key = normEmail(email);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  codes[key] = { code, expiresAt: Date.now() + CODE_SECONDS * 1000 };
  // TODO(백엔드): 서버가 이 이메일로 인증번호를 발송. devCode 는 서버 연결 후 제거.
  return { ok: true, expiresAt: codes[key].expiresAt, devCode: code };
}

export function verifyCode(email, input) {
  const c = codes[normEmail(email)];
  if (!c || Date.now() > c.expiresAt) return fail('expired', '제한시간 초과', '제한 시간을 초과했습니다\n다시 시도해주세요');
  if (String(input).trim() !== c.code) return fail('mismatch', '인증코드 불일치', '인증코드가 일치하지 않습니다');
  delete codes[normEmail(email)];
  return { ok: true };
}

// ---- 회원가입 ----
// 1단계(이메일 인증 전): 입력값 검사. 문제가 있으면 스토리보드 6~9장의 오류 문구를 돌려줌
export async function precheckSignup({ email, name, password, confirm, affiliation, requiredTerms }) {
  if (!email.trim() || !name.trim() || !password || !confirm) return fail('empty', '입력 확인', '이메일, 이름, 비밀번호를 모두 입력해 주세요');
  if (!isEmailFormat(email)) return fail('email', '이메일 확인 실패', '존재하지 않는 이메일입니다\n다시 한번 확인해주세요.');
  if (!checkPasswordRule(password)) return fail('rule', '보안 규칙 위반', '비밀번호는 영문과 숫자, 특수문자를\n반드시 포함시켜야 합니다 (8자 이상).');
  if (password !== confirm) return fail('mismatch', '비밀번호 불일치', '비밀번호가 일치하지 않습니다.');
  if (!requiredTerms) return fail('terms', '약관 동의', '필수 약관에 동의해 주세요');
  const accounts = await loadAccounts();
  if (accounts[normEmail(email)]) return fail('exists', '이미 가입된 이메일입니다', '기존 계정으로 로그인해주세요');
  return { ok: true };
}

// 2단계(인증 완료 후): 계정 만들기
export async function completeSignup({ email, name, password, affiliation, optionalTerms }) {
  const accounts = await loadAccounts();
  const key = normEmail(email);
  if (accounts[key]) return fail('exists', '이미 가입된 이메일입니다', '기존 계정으로 로그인해주세요');
  const salt = makeSalt();
  accounts[key] = { email: key, name: name.trim(), affiliation: (affiliation || '').trim(), salt, hash: hashPw(password, salt), optionalTerms: !!optionalTerms, createdAt: Date.now() };
  await saveAccounts(accounts);
  return { ok: true };
}

// ---- 임시 테스트 계정 (★ 개발용. 서버를 연결하거나 출시하기 전에 이 블록과 아래 getAccount 의 DUMMY 줄을 지우세요) ----
const DUMMY = { email: '1234', password: '1234', name: '테스트', affiliation: '' };

// ---- 로그인 ----
export async function login({ email, password }) {
  const key = normEmail(email);
  if (key === DUMMY.email && password === DUMMY.password) {
    return { ok: true, user: { email: DUMMY.email, name: DUMMY.name, affiliation: DUMMY.affiliation } };
  }
  if (!key || !password) return fail('fail', '로그인에 실패하였습니다', '아이디 또는 비밀번호를 확인해주세요');

  const attempts = await readJson(ATTEMPTS_KEY, {});
  const a = attempts[key] || { count: 0, lockedUntil: 0 };
  if (a.lockedUntil && Date.now() < a.lockedUntil) return fail('locked', '비밀번호 5회 불일치', '10분 후 다시 시도해주세요');

  const accounts = await loadAccounts();
  const acc = accounts[key];
  if (acc && acc.hash === hashPw(password, acc.salt)) {
    delete attempts[key];
    await AsyncStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts)).catch(() => {});
    return { ok: true, user: { email: acc.email, name: acc.name, affiliation: acc.affiliation } };
  }
  // 실패 기록: 잠금이 풀린 뒤라면 처음부터 다시 셈
  const count = (a.lockedUntil && Date.now() >= a.lockedUntil ? 0 : a.count) + 1;
  attempts[key] = count >= MAX_FAILS ? { count: 0, lockedUntil: Date.now() + LOCK_MS } : { count, lockedUntil: 0 };
  await AsyncStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts)).catch(() => {});
  if (count >= MAX_FAILS) return fail('locked', '비밀번호 5회 불일치', '10분 후 다시 시도해주세요');
  return fail('fail', '로그인에 실패하였습니다', '아이디 또는 비밀번호를 확인해주세요');
}

export async function socialLogin() {
  return { ok: false, reason: 'backend' }; // TODO(백엔드): 네이버/카카오 인증 후 로그인
}

// ---- 비밀번호 재설정 ----
export async function precheckReset({ email, password, confirm }) {
  if (!email.trim() || !password || !confirm) return fail('empty', '입력 확인', '이메일과 새 비밀번호를 모두 입력해 주세요');
  if (!isEmailFormat(email)) return fail('email', '이메일 확인 실패', '존재하지 않는 이메일입니다\n다시 한번 확인해주세요.');
  if (!checkPasswordRule(password)) return fail('rule', '보안 규칙 위반', '비밀번호는 영문과 숫자, 특수문자를\n반드시 포함시켜야 합니다 (8자 이상).');
  if (password !== confirm) return fail('mismatch', '비밀번호 불일치', '비밀번호가 일치하지 않습니다.');
  const acc = (await loadAccounts())[normEmail(email)];
  if (!acc) return fail('email', '이메일 확인 실패', '존재하지 않는 이메일입니다\n다시 한번 확인해주세요.');
  if (acc.hash === hashPw(password, acc.salt)) return fail('same', '이미 사용중인 비밀번호입니다', '현재 입력한 비밀번호는\n지금 사용하는 비밀번호와 일치합니다');
  return { ok: true };
}
export async function completeReset({ email, password }) {
  const accounts = await loadAccounts();
  const key = normEmail(email);
  if (!accounts[key]) return fail('email', '이메일 확인 실패', '존재하지 않는 이메일입니다\n다시 한번 확인해주세요.');
  const salt = makeSalt();
  accounts[key] = { ...accounts[key], salt, hash: hashPw(password, salt) };
  await saveAccounts(accounts);
  const attempts = await readJson(ATTEMPTS_KEY, {});
  delete attempts[key]; // 재설정하면 잠금도 풀림
  await AsyncStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts)).catch(() => {});
  return { ok: true };
}

// ---- 회원탈퇴 (이 기기의 계정 정보 삭제) ----
export async function removeAccount(email) {
  const accounts = await loadAccounts();
  delete accounts[normEmail(email)];
  await saveAccounts(accounts);
  return { ok: true };
}
export async function getAccount(email) {
  if (normEmail(email) === DUMMY.email) return { email: DUMMY.email, name: DUMMY.name, affiliation: DUMMY.affiliation }; // 임시 테스트 계정(자동 로그인용)
  const acc = (await loadAccounts())[normEmail(email)];
  return acc ? { email: acc.email, name: acc.name, affiliation: acc.affiliation } : null;
}
