// Metro resolves the native implementation on iOS and Android.
export async function listMobileModels() { return []; }
export async function installMobileModel() { throw new Error('모바일 네이티브 앱이 필요합니다.'); }
export async function askMobileModel() { throw new Error('모바일 네이티브 앱이 필요합니다.'); }
export function pendingMobileModelDownload() { return null; }
export function cancelMobileModelDownload() {}
