// Explicit development-only mode. It never reuses a signed-in account or its database.
export const LOCAL_PREVIEW = typeof __DEV__ !== 'undefined' && __DEV__
  && process.env.EXPO_PUBLIC_LOCAL_PREVIEW === '1';
export const PREVIEW_USER = Object.freeze({ id: '00000000-0000-4000-8000-000000000087', email: '', user_metadata: { display_name: '로컬 미리보기' } });
