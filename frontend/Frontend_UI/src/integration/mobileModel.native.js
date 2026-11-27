import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { Directory, File, Paths } from 'expo-file-system';
import { checkAbort, COMMAND_MAX_CHARS, deviceModels, GENERAL_MAX_CHARS, GENERAL_MAX_TOKENS, heavyTaskBlock, inferenceLimits, loadCandidates, outputLimit, STANDARD_LIMITS } from './mobileModelPolicy.mjs';
import { metrics } from './s22Gate';

const DOCUMENTS_SAFE = ' 문서 기능은 계속 사용할 수 있습니다.';
let installing = false;
let generating = false;
let loadedBefore = false;

function device() {
  const module = requireOptionalNativeModule('StellaModelDevice');
  if (!module) throw new Error('로컬 추론 모듈이 포함된 네이티브 앱을 설치해 주세요.');
  return module;
}
function directory() { return new Directory(device().directoryUri()); }
function installedFile(model) { return new File(directory(), deviceModels[model].file); }

export async function listMobileModels() {
  return Object.keys(deviceModels).filter(model => installedFile(model).size === deviceModels[model].bytes);
}

const backgroundDownloads = () => Platform.OS === 'android' && typeof device().startDownload === 'function';
const DOWNLOAD_FAILED = '모델을 내려받지 못했습니다. 네트워크와 저장 공간을 확인한 뒤 다시 시도해 주세요.';

async function waitForDownload(profile, { signal, onProgress }) {
  let state = device().startDownload(profile.url, profile.label + ' 내려받는 중');
  while (state.state !== 'done') {
    if (state.state === 'failed' || state.state === 'none') { device().cancelDownload(); throw new Error(DOWNLOAD_FAILED); }
    onProgress?.(Math.min(1, (state.bytes || 0) / profile.bytes), state.state === 'paused');
    await new Promise(resolve => setTimeout(resolve, 1000));
    checkAbort(signal);
    state = device().downloadStatus();
  }
  onProgress?.(1, false);
}

/** 진행 중이거나 끝난 백그라운드 다운로드가 있으면 그 모델 id를 돌려준다(화면을 다시 열 때 이어 보기). */
export function pendingMobileModelDownload() {
  if (Platform.OS !== 'android') return null;
  try {
    if (!backgroundDownloads()) return null;
    const { state, url } = device().downloadStatus();
    if (!['running', 'paused', 'done'].includes(state)) return null;
    return Object.keys(deviceModels).find(model => deviceModels[model].url === url) ?? null;
  } catch { return null; }
}

/** 백그라운드 다운로드를 취소하고 받던 파일을 지운다. */
export function cancelMobileModelDownload() {
  if (Platform.OS === 'android' && backgroundDownloads()) device().cancelDownload();
}

export async function installMobileModel(model, { signal, onProgress } = {}) {
  checkAbort(signal);
  if (!Object.hasOwn(deviceModels, model)) throw new Error('지원하지 않는 모델입니다.');
  if (installing) throw new Error('다른 모델을 설치 중입니다.');
  installing = true;
  let partial;
  try {
    const profile = deviceModels[model];
    const folder = directory();
    folder.create({ intermediates: true, idempotent: true });
    const destination = installedFile(model);
    if (destination.size === profile.bytes) return;
    partial = new File(folder, 'install.partial');
    if (partial.exists) partial.delete();
    // 백그라운드 다운로드는 받은 파일을 앱 내부 폴더로 복사하므로 새로 시작할 때 두 배의 공간이 필요하다. 이어 받기는 이미 자리를 잡았다.
    const resuming = pendingMobileModelDownload() === model;
    const needed = (backgroundDownloads() ? 2 : 1) * profile.bytes + 256 * 1024 ** 2;
    if (!resuming && Paths.availableDiskSpace < needed) throw new Error('모델을 설치할 저장 공간이 부족합니다.');
    if (backgroundDownloads()) {
      // Android: 시스템 다운로드 관리자가 받는다. 화면을 나가거나(signal 중단) 앱을 닫아도 다운로드는 계속되고,
      // 다시 열면 같은 다운로드의 진행률을 이어서 보여 준다. 취소는 cancelMobileModelDownload만 한다.
      await waitForDownload(profile, { signal, onProgress });
      await device().takeDownload();
    } else {
      await File.downloadFileAsync(profile.url, partial, {
        signal, onProgress: ({ bytesWritten }) => onProgress?.(Math.min(1, bytesWritten / profile.bytes)),
      });
    }
    checkAbort(signal);
    if (partial.size !== profile.bytes || await device().digestStagingFile() !== profile.sha256)
      throw new Error('모델 파일 무결성 검사에 실패했습니다.');
    checkAbort(signal);
    if (destination.exists) destination.delete();
    partial.moveSync(destination);
    partial = null;
  } finally {
    try { if (partial?.exists) partial.delete(); } finally { installing = false; }
  }
}

// commandRequest is the user's original text for app commands; other requests use the general limit.
export async function askMobileModel({ model, prompt, signal, commandRequest, grammar }) {
  checkAbort(signal);
  if (!Object.hasOwn(deviceModels, model) || typeof prompt !== 'string' || !prompt.trim())
    throw new Error('모델과 질문을 확인해 주세요.');
  if (commandRequest == null ? prompt.trim().length > GENERAL_MAX_CHARS : commandRequest.trim().length > COMMAND_MAX_CHARS)
    throw new Error('입력이 너무 깁니다. 내용을 나눠 주세요.' + DOCUMENTS_SAFE);
  if (generating) throw new Error('이전 모델 작업을 정리 중입니다.');
  generating = true;
  const controller = new AbortController();
  let context, completion, stopping, stateListener, memoryListener, memoryPressure = false;
  const availableMemory = () => { try { return device().memory().available; } catch { return undefined; } };
  const run = metrics && { startedAt: Date.now(), availableBefore: availableMemory(), outcome: 'error' };
  function abort() {
    if (run) run.abortedAt ??= Date.now();
    controller.abort();
    if (completion && !stopping) stopping = context.stopCompletion().catch(error => {
      console.warn('로컬 추론 중지 실패', error.name);
    });
  }
  try {
    signal?.addEventListener('abort', abort);
    stateListener = AppState.addEventListener('change', state => { if (state !== 'active') abort(); });
    memoryListener = Platform.OS === 'android'
      ? device().addListener('memoryWarning', () => { memoryPressure = true; abort(); })
      : AppState.addEventListener('memoryWarning', () => { memoryPressure = true; abort(); });
    if (AppState.currentState === 'background') abort();
    const installed = await listMobileModels();
    const memory = device().memory();
    const candidates = loadCandidates(model, installed, memory, Platform.OS);
    checkAbort(controller.signal);
    if (!candidates.length) throw new Error('추론 메모리가 부족합니다. 다른 앱을 닫거나 내 서버나 클라우드 AI를 사용해 주세요.' + DOCUMENTS_SAFE);
    const { initLlama } = require('llama.rn');
    let used, limits;
    for (const candidate of candidates) {
      checkAbort(controller.signal);
      try {
        const loadStart = Date.now();
        limits = inferenceLimits(candidate, memory, Platform.OS);
        const sizes = limits === STANDARD_LIMITS ? { n_ctx: 4096, n_batch: 128, n_ubatch: 64 }
          : { n_ctx: limits.context, n_batch: limits.batch, n_ubatch: limits.microbatch };
        context = await initLlama({ model: installedFile(candidate).uri, ...sizes, n_gpu_layers: Platform.OS === 'ios' ? 99 : 0,
          use_mmap: true, use_mlock: false, ctx_shift: false });
        metrics?.record('model_load', { model: candidate, ms: Date.now() - loadStart, reload: loadedBefore });
        loadedBefore = true;
        used = candidate;
        break;
      } catch (error) {
        if (candidate === candidates[candidates.length - 1]) {
          checkAbort(controller.signal);
          console.warn('로컬 모델 로드 실패', error?.name);
          throw new Error('모델을 불러오지 못했습니다. 다른 앱을 닫고 다시 시도해 주세요.' + DOCUMENTS_SAFE);
        }
      }
    }
    checkAbort(controller.signal);
    const messages = [{ role: 'user', content: prompt.trim() }];
    const formatted = await context.getFormattedChat(messages, null, { jinja: true, enable_thinking: false });
    const { tokens } = await context.tokenize(formatted.prompt);
    const inputTokens = commandRequest == null ? tokens.length : (await context.tokenize(commandRequest.trim())).tokens.length;
    const maxTokens = Math.min(limits.output, commandRequest == null ? GENERAL_MAX_TOKENS : outputLimit(inputTokens));
    checkAbort(controller.signal);
    if (tokens.length + maxTokens + 1 > limits.context) throw new Error('질문이 모델 컨텍스트를 초과했습니다. 내용을 줄여 주세요.');
    const read = get => { try { return get(); } catch { return undefined; } };
    const limited = heavyTaskBlock(inputTokens, { thermal: read(() => device().thermalRestricted()), memory: read(() => device().memory()) });
    if (limited) throw new Error(limited + DOCUMENTS_SAFE);
    if (run) Object.assign(run, { model: used, task: commandRequest == null ? 'general' : 'command', maxTokens, promptTokens: tokens.length });
    completion = context.completion({ prompt: formatted.prompt, n_predict: maxTokens, temperature: 0.2, ...(grammar ? { grammar } : {}),
      stop: [...(formatted.additional_stops ?? []), '<|im_end|>', '<|endoftext|>'] },
    run ? () => { run.firstTokenAt ??= Date.now(); } : undefined);
    const result = await completion;
    checkAbort(controller.signal);
    if (run) Object.assign(run, { predicted: result.tokens_predicted, tokensPerSecond: result.timings?.predicted_per_second,
      promptMs: result.timings?.prompt_ms, cachedTokens: result.timings?.cache_n, outcome: result.stopped_limit ? 'limit' : 'error' });
    // A cut-off command can still look valid, so it must never reach review or storage.
    if (result.interrupted || result.context_full || result.truncated || result.stopped_limit)
      throw new Error('모델이 완전한 응답을 생성하지 못했습니다. 짧은 질문으로 다시 시도해 주세요.');
    const text = (result.content || result.text || '').trim();
    if (!text) throw new Error('모델 응답이 비어 있습니다.');
    if (run) run.outcome = 'ok';
    return { text, model: used };
  } catch (error) {
    if (run && controller.signal.aborted) run.outcome = 'cancelled';
    if (memoryPressure) throw Object.assign(new Error('메모리가 부족해 AI 응답을 중단했습니다. 다른 앱을 닫고 다시 시도해 주세요.' + DOCUMENTS_SAFE), { name: 'AbortError' });
    checkAbort(controller.signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    stateListener?.remove();
    memoryListener?.remove();
    try {
      await stopping;
      if (run?.abortedAt) metrics.record('cancel', { ms: Date.now() - run.abortedAt });
      await context?.release();
    } finally {
      generating = false;
      if (run) metrics.record('inference', { ...run, totalMs: Date.now() - run.startedAt,
        firstTokenMs: run.firstTokenAt ? run.firstTokenAt - run.startedAt : undefined, availableAfter: availableMemory() });
    }
  }
}
