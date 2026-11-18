// Chat attachments → text the AI can read.
//   Photo (JPEG/PNG/WebP): cloud OCR through the AI gateway (needs AI consent, counts toward the monthly OCR limit).
//   PDF / Word / PowerPoint: server text extraction (doc-extract). Files are not stored and do not go to the AI.
//   Plain text / Markdown / CSV: read on this device.
// Only the extracted text is sent with the question; the files themselves are not kept.
import { Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { supabase } from '../../lib/stella/supabase';
import { documentErrorMessage, extractDocumentText, isExtractableDocument, toBase64 } from '../../lib/stella/documents';
import { OCR_LIMITS, aiErrorMessage } from '../../lib/stella/ai';
import { ocrForChat } from '../../integration/runtime';

export const MAX_ATTACHMENTS = 3;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const TEXT_TYPES = /^(text\/|application\/(json|csv))/;
const TEXT_EXT = /\.(txt|md|csv|json)$/i;

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
  if (isExtractableDocument(asset.mimeType, asset.name)) return 'document';
  if (TEXT_TYPES.test(type) || TEXT_EXT.test(asset.name ?? '')) return 'text';
  return null;
};

export async function pickAttachments(mode) {
  const r = await DocumentPicker.getDocumentAsync({
    multiple: true, copyToCacheDirectory: true,
    type: mode === 'image' ? IMAGE_TYPES : ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/*', 'application/json'],
  });
  return r.canceled ? [] : r.assets;
}

/** One picked file → { id, name, kind } for the chip; then `extract` fills text or error. */
export function describe(asset) {
  return { id: randomUUID(), name: asset.name ?? '첨부', kind: kindOf(asset), status: 'reading', text: '', error: '', asset };
}

export async function extract(item, signal) {
  const { asset } = item;
  if (!item.kind) return { ...item, status: 'error', error: '읽을 수 없는 형식이에요 (사진·PDF·Word·PowerPoint·텍스트)' };
  try {
    // item.bytes: already in memory (e.g. a cloud file downloaded by the file vault)
    const bytes = item.bytes ?? await readBytes(asset);
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
      ? (error.code === 'CONSENT_REQUIRED' ? 'AI 설정에서 외부 AI로 보내기를 허용해야 사진을 읽을 수 있어요' : error.message)
      : item.kind === 'document' ? documentErrorMessage(error)
        // gateway() errors carry the server's own Korean message; aiErrorMessage only knows AiError instances
        : (error?.code && error.message) || aiErrorMessage(error);
    return { ...item, status: 'error', error: message };
  }
}
