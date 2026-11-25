export const revision = '4168f45a16a1290d65a4ec0fa312ae917a4c15d6';
export const profiles = Object.freeze({
  Q4_K_M: { bytes: 3013027808, sha256: '13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983' },
  Q5_K_M: { bytes: 3443763168, sha256: '21c4643259ce62ffd979848e5819ce03823fd9e9902279ab54cc0d572d83d33e' },
});
// `profiles` and `revision` stay as the frozen Qwen evaluation records. The app default is Gemma 4 E2B.
export const DEFAULT_DEVICE_MODEL = 'gemma-4-E2B';
const GEMMA_REVISION = '2a8538c2e2d4687953a86c422c7c623cfd022880';
const QWEN_URL = 'https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/' + revision + '/Qwen_Qwen3.5-4B-';
export const deviceModels = Object.freeze({
  // ggml-org/gemma-4-E2B-it-GGUF, Apache-2.0. Text model only; the vision projector is not downloaded.
  // S22 (8 GB) usually reports ~1.5-2 GB available after the OS reserve, so 1.5 GiB refused every request.
  // Weights are mmap'd file pages; only KV cache and compute buffers need anonymous memory. memoryWarning still aborts.
  [DEFAULT_DEVICE_MODEL]: { label: 'Gemma 4 E2B', bytes: 2841481184, sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
    url: 'https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/' + GEMMA_REVISION + '/gemma-4-E2B-it-Q4_0.gguf',
    file: GEMMA_REVISION + '-gemma-4-E2B-it-Q4_0.gguf', minTotal: 6e9, minAvailable: 1024 ** 3 },
  ...Object.fromEntries(Object.entries(profiles).map(([key, profile]) => [key, { label: 'Qwen3.5 4B ' + key, ...profile,
    url: QWEN_URL + key + '.gguf', file: revision + '-Qwen_Qwen3.5-4B-' + key + '.gguf' }])),
});
export const GENERAL_MAX_TOKENS = 512;
// mobileModel.native.js keeps the standard values as literals (the frozen S22 settings, checked by s22-metrics.test).
export const STANDARD_LIMITS = Object.freeze({ context: 4096, batch: 128, microbatch: 64, output: GENERAL_MAX_TOKENS });
const COMPACT_Q5_LIMITS = Object.freeze({ context: 2048, batch: 64, microbatch: 32, output: 256 });
export const COMPACT_Q5_MIN_AVAILABLE_BYTES = 4e9;
/** Context and batch limits for a Qwen model on this device, or null when it cannot load. Other models are gated by loadCandidates. */
export function inferenceLimits(model, memory, platform) {
  if (!Object.hasOwn(profiles, model)) return STANDARD_LIMITS;
  // Device classes use marketed RAM. OS-reported totals exclude firmware reservations.
  if (memory.total >= (model === 'Q5_K_M' ? 11 : 7) * 1e9 && memory.available >= profiles[model].bytes + 700 * 1024 ** 2) return STANDARD_LIMITS;
  // Android 8 GB class: Q5 with a halved context when 4 GB is free before the OS low-memory reserve.
  if (platform === 'android' && model === 'Q5_K_M' && memory.total >= 7e9
    && memory.rawAvailable >= COMPACT_Q5_MIN_AVAILABLE_BYTES && memory.available >= profiles[model].bytes) return COMPACT_Q5_LIMITS;
  return null;
}
export function loadCandidates(model, installed, memory, platform) {
  if (!installed.includes(model)) throw new Error('먼저 선택한 모델을 설치해 주세요.');
  if (!Object.hasOwn(profiles, model)) {
    const entry = deviceModels[model];
    return entry && memory.total >= entry.minTotal && memory.available >= entry.minAvailable ? [model] : [];
  }
  return (model === 'Q5_K_M' ? [model, 'Q4_K_M'] : [model]).filter(key => installed.includes(key) && inferenceLimits(key, memory, platform));
}
// Commands copy their values from the request, so only the fixed command text is extra.
// Bounded by UTF-8 bytes because a token decodes to at least one byte; tests check every command form.
export const COMMAND_OVERHEAD_TOKENS = 64;
export function outputLimit(requestTokens) {
  return requestTokens == null ? GENERAL_MAX_TOKENS : Math.min(GENERAL_MAX_TOKENS, requestTokens + COMMAND_OVERHEAD_TOKENS);
}
// Same bounds as the request inputs on the command and local AI screens.
export const COMMAND_MAX_CHARS = 2000;
export const GENERAL_MAX_CHARS = 12000;
// The "long input" class from s22-performance-goal.md. Device state limits only these requests.
export const HEAVY_INPUT_TOKENS = 512;
// thermal is the platform's own severe-or-worse flag. Anything unreadable counts as restricted.
export function heavyTaskBlock(inputTokens, { thermal, memory } = {}) {
  if (inputTokens <= HEAVY_INPUT_TOKENS) return '';
  if (thermal === true) return '기기 온도가 높아 긴 요약 같은 무거운 작업을 제한했습니다. 기기가 식은 뒤 다시 시도하거나 내용을 나눠 주세요.';
  if (memory?.lowMemory === true) return '메모리가 부족해 긴 요약 같은 무거운 작업을 제한했습니다. 다른 앱을 닫거나 내용을 나눠 주세요.';
  if (thermal !== false || typeof memory?.available !== 'number') return '기기 상태를 확인할 수 없어 긴 요약 같은 무거운 작업을 제한했습니다. 내용을 나눠 주세요.';
  return '';
}
export function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('작업이 취소되었습니다.'), { name: 'AbortError' });
}
