export const makeRedirectUri = (o?: { path?: string }) => `stella://${o?.path ?? ''}`;
