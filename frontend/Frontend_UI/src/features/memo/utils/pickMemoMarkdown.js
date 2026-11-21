import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import { MAX_MARKDOWN_BYTES, readMemoMarkdown } from './memoMarkdown.mjs';

export async function pickMemoMarkdown() {
  const result = await getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: '*/*', base64: false });
  if (result.canceled || !result.assets.length) return null;
  const asset = result.assets[0];
  try {
    if (!/\.(?:md|markdown)$/i.test(asset.name)) throw new Error('Markdown 파일(.md 또는 .markdown)을 선택해 주세요.');
    const file = asset.file ?? (Platform.OS === 'web' ? await (await fetch(asset.uri)).blob() : new File(asset.uri));
    if ((asset.size ?? file.size) > MAX_MARKDOWN_BYTES) throw new Error('파일이 너무 커요. 나누어 가져와 주세요.');
    return readMemoMarkdown(asset.name, await file.text());
  } finally {
    if (Platform.OS === 'web' && asset.uri.startsWith('blob:')) URL.revokeObjectURL(asset.uri);
  }
}
