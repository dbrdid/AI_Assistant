// 테스트용 react-native 대역 (auth.ts → supabase.ts가 쓰는 것만)
export const Platform = { OS: 'ios' };
export const AppState = { addEventListener: () => ({ remove() {} }) };
