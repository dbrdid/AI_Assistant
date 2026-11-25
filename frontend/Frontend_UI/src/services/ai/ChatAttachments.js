// 채팅 첨부 파일을 AI가 읽을 수 있는 텍스트로 변환합니다.
//   사진(JPEG/PNG/WebP): AI 게이트웨이의 클라우드 OCR 사용(AI 동의 필요, 월간 OCR 한도에 포함).
//   PDF / Word / PowerPoint: 서버에서 텍스트 추출(doc-extract). 파일은 저장하지 않으며 AI에 전송하지 않습니다.
//   일반 텍스트 / Markdown / CSV: 이 기기에서 읽습니다.
// 추출한 텍스트만 질문과 함께 전송하며 파일 자체는 보관하지 않습니다.
import { Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { createAudioPlayer } from 'expo-audio';
import { supabase } from '../../lib/stella/supabase';
import { DOCUMENT_LIMITS, documentErrorMessage, extractDocumentText, isExtractableDocument, toBase64 } from '../../lib/stella/documents';
import { OCR_LIMITS, aiErrorMessage } from '../../lib/stella/ai';
import { STT_MAX_BYTES, STT_MAX_SECONDS } from '../../lib/stella/transcribe';
import { newTranscribeJob, ocrForChat, transcribeForDevice } from '../../integration/runtime';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const TEXT_TYPES = /^(text\/|application\/(json|csv))/;
const TEXT_EXT = /\.(txt|md|csv|json)$/i;
const AUDIO_EXT = /\.(flac|mp3|mp4|mpeg|mpga|m4a|ogg|wav|webm)$/i;
const AUDIO_MIMES = new Set(['audio/flac', 'audio/mp3', 'audio/mpeg', 'audio/mpga', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'audio/x-flac', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/webm']);

function isAudio(asset) {
  const mime = String(asset.mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('video/')) return false;
  return AUDIO_MIMES.has(mime) || ((!mime || mime === 'application/octet-stream') && AUDIO_EXT.test(asset.name ?? asset.uri ?? ''));
}

function readAudioDuration(uri) {
  const player = createAudioPlayer(uri, { updateInterval: 250 });
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription;
    const timer = setTimeout(() => finish(new Error('음성 파일의 길이를 확인하지 못했어요')), 15000);
    const finish = (error, duration) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      player.remove();
      if (error) reject(error);
      else resolve(duration);
    };
    const check = status => {
      const duration = Number(status?.duration ?? player.duration);
      if ((status?.isLoaded || player.isLoaded) && Number.isFinite(duration) && duration > 0) finish(null, duration);
    };
    subscription = player.addListener('playbackStatusUpdate', check);
    check();
  });
}

export async function readBytes(asset) {
  if (Platform.OS === 'web') {
    const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new File(asset.uri).bytes();
}

const kindOf = asset => {
  const type = asset.mimeType ?? '';
  if (IMAGE_TYPES.includes(type) || /\.(jpe?g|png|webp)$/i.test(asset.name ?? '')) return 'image';
  if (isAudio(asset)) return 'audio';
  if (isExtractableDocument(asset.mimeType, asset.name)) return 'document';
  if (TEXT_TYPES.test(type) || TEXT_EXT.test(asset.name ?? '')) return 'text';
  return null;
};

export async function pickAttachments(mode) {
  const r = await DocumentPicker.getDocumentAsync({
    multiple: true, copyToCacheDirectory: true,
    type: mode === 'image' ? IMAGE_TYPES : '*/*',
  });
  return r.canceled ? [] : r.assets;
}

/** 선택한 파일 하나를 칩에 표시할 { id, name, kind }로 설명합니다. 이후 `extract`가 텍스트 또는 오류를 채웁니다. */
export function describe(asset) {
  return { id: randomUUID(), name: asset.name ?? '첨부', kind: kindOf(asset), status: 'reading', text: '', error: '', asset };
}

export async function extract(item, signal) {
  const { asset } = item;
  if (!item.kind) return { ...item, status: 'error', error: '읽을 수 없는 형식이에요 (사진·PDF·Word·PowerPoint·텍스트)' };
  try {
    const declaredSize = Number(asset.size);
    if (item.kind === 'audio' && declaredSize > STT_MAX_BYTES) return { ...item, status: 'error', error: '녹음 파일은 25MB까지 처리할 수 있어요' };
    if (item.kind === 'image' && declaredSize > OCR_LIMITS.maxImageBytes) return { ...item, status: 'error', error: '사진은 5MB까지 처리할 수 있어요' };
    if (item.kind === 'document' && declaredSize > DOCUMENT_LIMITS.maxInlineBytes) return { ...item, status: 'error', error: '문서는 10MB까지 처리할 수 있어요' };
    if (item.kind === 'text' && declaredSize > DOCUMENT_LIMITS.maxInlineBytes) return { ...item, status: 'error', error: '텍스트 파일은 10MB까지 처리할 수 있어요' };
    // item.bytes: 이미 메모리에 있는 데이터(예: 파일 보관소에서 내려받은 클라우드 파일)
    const bytes = item.bytes ?? await readBytes(asset);
    if (item.kind === 'audio') {
      if (bytes.byteLength > STT_MAX_BYTES) return { ...item, status: 'error', error: '녹음 파일은 25MB까지 처리할 수 있어요' };
      const duration = await readAudioDuration(asset.uri);
      if (duration > STT_MAX_SECONDS) return { ...item, status: 'error', error: '한 번에 30분까지 처리할 수 있어요' };
      const result = await transcribeForDevice(
        newTranscribeJob(asset.uri, duration, { fileName: asset.name, mimeType: asset.mimeType }),
        { signal },
      );
      if (!result.text.trim()) return { ...item, status: 'error', error: '음성에서 알아들을 수 있는 말을 찾지 못했어요' };
      return { ...item, status: 'ready', text: result.text };
    }
    if (item.kind === 'image') {
      if (bytes.byteLength > OCR_LIMITS.maxImageBytes) return { ...item, status: 'error', error: '사진이 5MB보다 커요. 줄여서 올려 주세요' };
      const draft = await ocrForChat(toBase64(bytes), signal);
      if (!draft?.has_text) return { ...item, status: 'error', error: '사진에서 읽을 글자를 찾지 못했어요' };
      return { ...item, status: 'ready', text: draft.text };
    }
    if (item.kind === 'document') {
      const doc = await extractDocumentText(supabase, { bytes, mimeType: asset.mimeType, fileName: asset.name }, { signal });
      if (doc.noText || !doc.text.trim()) return { ...item, status: 'error', error: '글자가 없는 문서예요 (스캔본이면 사진으로 올려 주세요)' };
      return { ...item, status: 'ready', text: doc.text };
    }
    const text = new TextDecoder().decode(bytes);
    return text.trim() ? { ...item, status: 'ready', text } : { ...item, status: 'error', error: '빈 파일이에요' };
  } catch (error) {
    const message = error?.code === 'ROUTE_UNSUPPORTED' || error?.code === 'CONSENT_REQUIRED' || error?.name === 'AIPolicyError'
      ? (error.code === 'CONSENT_REQUIRED'
        ? item.kind === 'audio' ? '음성을 글자로 바꾸려면 AI 설정에서 클라우드 AI 전송을 허용해 주세요'
          : item.kind === 'image' ? '사진을 읽으려면 AI 설정에서 클라우드 AI 전송을 허용해 주세요'
            : 'AI 설정에서 클라우드 AI 전송을 허용해 주세요'
        : error.message)
      : item.kind === 'document' ? documentErrorMessage(error)
        // gateway() 오류에는 서버의 한국어 메시지가 들어 있지만 aiErrorMessage는 AiError 인스턴스만 처리합니다.
        : (error?.code && error.message) || aiErrorMessage(error);
    return { ...item, status: 'error', error: message };
  }
}
