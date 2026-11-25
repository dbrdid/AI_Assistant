// ============================================================
// ShareExport.js — 메모를 파일로 내보내기 (저장·공유)
//   글 형식(txt·md·html·json·docx)은 MeetingExport.mjs가 만들고, PDF는 lib/stella/pdf-export(expo-print)가 만듭니다.
//   웹: 파일을 내려받음. PDF는 브라우저 인쇄 창에서 "PDF로 저장"을 고름 (expo-print가 웹에서 파일을 만들지 못함)
//   휴대폰: 앱 임시 폴더에 파일을 만들고 공유 창(메일·드라이브·카카오톡·파일에 저장 등)을 띄움
// ============================================================
import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { exportPdf, renderPdfHtml } from '../../lib/stella/pdf-export';
import { buildExport, formatDate, formatOf, normalizeRecord, safeFileName } from './MeetingExport.mjs';

const WEB = Platform.OS === 'web';
const TIME_ZONE = 'Asia/Seoul';

/** 메모 → PDF 문서 모양 (손글씨가 있으면 그림으로 함께) */
function pdfDocumentOf(memo) {
  const r = normalizeRecord(memo);
  const meta = [];
  const created = formatDate(r.createdAt, TIME_ZONE);
  const updated = formatDate(r.updatedAt, TIME_ZONE);
  if (created) meta.push(['작성', created]);
  if (updated && updated !== created) meta.push(['수정', updated]);
  if (r.project) meta.push(['프로젝트', r.project]);
  const blocks = [];
  if (r.body.trim()) blocks.push({ type: 'paragraph', text: r.body });
  if (Array.isArray(memo.strokes) && memo.strokes.length) blocks.push({ type: 'strokes', strokes: memo.strokes, caption: '손글씨' });
  return { title: r.title, meta, sections: [{ blocks }] };
}

// ---------------------------------------------------------------------
// 웹
// ---------------------------------------------------------------------
function downloadInBrowser({ data, mimeType, fileName }) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 보이지 않는 틀에 문서만 그려 인쇄 창을 띄움 (앱 화면 전체가 인쇄되지 않게) */
function printHtmlInBrowser(html) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', visibility: 'hidden' });
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        win.addEventListener('afterprint', cleanup, { once: true });
        win.focus();
        win.print();
        resolve();
      } catch (error) {
        frame.remove();
        reject(error);
      }
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

// ---------------------------------------------------------------------
// 휴대폰
// ---------------------------------------------------------------------
/**
 * 이번 내보내기만의 임시 폴더 (같은 이름의 파일이 겹치지 않게).
 * 공유 창이 닫힌 뒤에도 받는 앱(Android)이 파일을 늦게 읽을 수 있어 바로 지우지 않고, 다음 내보내기 때 지난 것을 지움
 */
function exportFolder() {
  const root = new Directory(Paths.cache, 'exports');
  try { if (root.exists) root.delete(); } catch { /* 다음에 */ }
  const dir = new Directory(root, randomUUID());
  dir.create({ intermediates: true });
  return dir;
}

async function shareFile(file, { mimeType, fileName, uti }) {
  if (!(await Sharing.isAvailableAsync())) throw Object.assign(new Error('이 기기에서는 공유 창을 열 수 없어요'), { code: 'SHARE_UNAVAILABLE' });
  await Sharing.shareAsync(file.uri, { mimeType: mimeType.split(';')[0], dialogTitle: fileName, ...(uti ? { UTI: uti } : {}) });
}

const UTI = { pdf: 'com.adobe.pdf', txt: 'public.plain-text', md: 'net.daringfireball.markdown', html: 'public.html', json: 'public.json', docx: 'org.openxmlformats.wordprocessingml.document' };

/**
 * 메모 하나를 고른 형식으로 내보냄.
 *   memo: { title, body, strokes?, createdAt?, updatedAt?, project? }
 *   반환: { fileName, via: 'download' | 'print' | 'share' }
 */
export async function exportMemo(memo, formatId) {
  const format = formatOf(formatId);
  if (!format) throw Object.assign(new Error('지원하지 않는 파일 형식이에요'), { code: 'UNSUPPORTED_FORMAT' });
  const r = normalizeRecord(memo);
  if (!r.body.trim() && !(memo.strokes?.length)) throw Object.assign(new Error('내보낼 내용이 없어요'), { code: 'EMPTY' });

  if (format.id === 'pdf') {
    const doc = pdfDocumentOf(memo);
    const fileName = `${safeFileName(r.title)}.pdf`;
    if (WEB) {
      await printHtmlInBrowser(renderPdfHtml(doc, { timeZone: TIME_ZONE }));
      return { fileName, via: 'print' };
    }
    const pdf = await exportPdf(doc, { printToFileAsync: Print.printToFileAsync }, { timeZone: TIME_ZONE });
    const dir = exportFolder();
    const target = new File(dir, fileName);
    try {
      await new File(pdf.uri).copy(target, { overwrite: true });   // 공유 창에 보일 이름으로
    } finally {
      try { new File(pdf.uri).delete(); } catch { /* 이미 없음 */ }
    }
    await shareFile(target, { mimeType: format.mimeType, fileName, uti: UTI.pdf });
    return { fileName, via: 'share' };
  }

  const out = buildExport(memo, format.id, { timeZone: TIME_ZONE });
  if (WEB) {
    downloadInBrowser(out);
    return { fileName: out.fileName, via: 'download' };
  }
  const file = new File(exportFolder(), out.fileName);
  file.create({ overwrite: true });
  await file.write(out.data);
  await shareFile(file, { mimeType: out.mimeType, fileName: out.fileName, uti: UTI[format.id] });
  return { fileName: out.fileName, via: 'share' };
}
