import { Platform } from 'react-native';
import { printToFileAsync } from 'expo-print';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { exportPdf, notePdfSection, renderPdfHtml } from '../../../lib/stella/pdf-export';
import { readMemoBlocks } from './memoBlocks.mjs';
import { readMemoReference } from './memoReferences.mjs';

export function memoPdfDocument({ title, body, strokes }) {
  const section = notePdfSection({ strokes });
  const blocks = [];
  for (const block of body.trim() ? readMemoBlocks(body) : []) {
    const previous = blocks.at(-1);
    if (block.type === 'heading') {
      blocks.push({ type: 'heading', text: block.text });
    } else if (block.type === 'bullet' || block.type === 'todo') {
      const type = block.type === 'todo' ? 'checklist' : 'list';
      const item = block.type === 'todo' ? { text: block.text, done: block.checked } : block.text;
      if (previous?.type === type) previous.items.push(item);
      else blocks.push({ type, items: [item] });
    } else {
      const text = readMemoReference(block.text)?.label ?? block.text;
      if (previous?.type === 'paragraph') previous.text += '\n' + text;
      else blocks.push({ type: 'paragraph', text });
    }
  }
  return {
    title: title.trim() || '제목 없는 메모',
    sections: [{ blocks: [...blocks, ...section.blocks] }],
  };
}

export async function shareMemoPdf(memo) {
  const doc = memoPdfDocument(memo);
  if (Platform.OS === 'web') {
    const html = renderPdfHtml(doc);
    const preview = window.open('', '_blank');
    if (!preview) throw new Error('인쇄 창이 차단됐어요. 이 사이트에서 팝업을 허용해 주세요.');
    preview.opener = null;
    preview.document.open();
    preview.document.write(html);
    preview.document.close();
    await preview.document.fonts?.ready;
    if (!preview.closed) {
      preview.focus();
      preview.print();
    }
    return;
  }
  if (!(await isAvailableAsync())) throw new Error('이 기기에서는 파일 공유를 사용할 수 없어요.');
  const pdf = await exportPdf(doc, { printToFileAsync });
  await shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: '메모 PDF 내보내기' });
}
