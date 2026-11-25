// ============================================================
// MeetingExport.mjs — 메모·회의록·강의 녹음 글을 파일로 만들기 (txt · md · html · json · docx)
//   react-native·expo를 쓰지 않아 Node 테스트(tests/integration)에서도 그대로 돕니다.
//   PDF는 기기 글꼴로 그려야 해서 lib/stella/pdf-export(expo-print)가 맡고, 저장·공유는 ShareExport.js가 맡습니다.
//   서버가 아니라 기기에서 만듭니다: 글이 서버를 거치지 않고, 추가 패키지·한글 폰트 경로 설정이 필요 없습니다.
// ============================================================

export const EXPORT_FORMATS = Object.freeze([
  { id: 'pdf', label: 'PDF', extension: 'pdf', mimeType: 'application/pdf' },
  { id: 'docx', label: 'Word', extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'txt', label: '텍스트', extension: 'txt', mimeType: 'text/plain;charset=utf-8' },
  { id: 'md', label: 'Markdown', extension: 'md', mimeType: 'text/markdown;charset=utf-8' },
  { id: 'html', label: 'HTML', extension: 'html', mimeType: 'text/html;charset=utf-8' },
  { id: 'json', label: 'JSON', extension: 'json', mimeType: 'application/json' },
]);
const BY_ID = new Map(EXPORT_FORMATS.map(f => [f.id, f]));
export const formatOf = id => BY_ID.get(String(id ?? '').toLowerCase()) ?? null;

const MAX_TITLE = 200;
const MAX_BODY = 1_000_000;
const DEFAULT_TITLE = '메모';

/** 파일 이름으로 쓸 수 없는 글자를 바꾸고 80자로 자름 */
export function safeFileName(title) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || DEFAULT_TITLE;
}

/** 날짜(ms·ISO·Date) → "2026년 11월 25일 오후 1:40" (보여 줄 수 없으면 '') */
export function formatDate(value, timeZone = 'Asia/Seoul') {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone, dateStyle: 'long', timeStyle: 'short' }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** 화면의 메모 → 내보낼 기록. 제목이 비면 '메모', 줄바꿈은 \n으로 통일 */
export function normalizeRecord(input = {}) {
  const title = String(input.title ?? '').trim().slice(0, MAX_TITLE) || DEFAULT_TITLE;
  const body = String(input.body ?? input.transcript ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_BODY);
  const createdAt = input.createdAt ?? null;
  const updatedAt = input.updatedAt ?? null;
  return { title, body, createdAt, updatedAt, project: input.project ? String(input.project).slice(0, MAX_TITLE) : null };
}

function metaLines(r, timeZone) {
  const lines = [];
  const created = formatDate(r.createdAt, timeZone);
  const updated = formatDate(r.updatedAt, timeZone);
  if (created) lines.push(['작성', created]);
  if (updated && updated !== created) lines.push(['수정', updated]);
  if (r.project) lines.push(['프로젝트', r.project]);
  return lines;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeXml = s => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')   // XML 1.0에서 쓸 수 없는 글자
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toTxt(r, tz) {
  return [r.title, ...metaLines(r, tz).map(([k, v]) => `${k}: ${v}`), '', r.body].join('\n');
}

function toMarkdown(r, tz) {
  const meta = metaLines(r, tz).map(([k, v]) => `- ${k}: ${v}`);
  // 제목 줄의 #·줄바꿈은 제목이 깨지지 않게 정리. 본문은 사용자가 쓴 그대로
  return [`# ${r.title.replace(/\s+/g, ' ')}`, '', ...(meta.length ? [...meta, ''] : []), '## 내용', '', r.body].join('\n');
}

function toHtml(r, tz) {
  const meta = metaLines(r, tz).map(([k, v]) => `<li><b>${escapeHtml(k)}</b> ${escapeHtml(v)}</li>`).join('');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(r.title)}</title>
<style>
body { font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #1f2a2a; }
h1 { font-size: 1.6em; margin-bottom: .3em; }
ul.meta { list-style: none; padding: 0; color: #5c6b6b; font-size: .9em; }
.body { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<h1>${escapeHtml(r.title)}</h1>
${meta ? `<ul class="meta">${meta}</ul>` : ''}
<hr>
<div class="body">${escapeHtml(r.body)}</div>
</body>
</html>
`;
}

function toJson(r) {
  const iso = v => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return `${JSON.stringify({ title: r.title, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt), project: r.project, body: r.body }, null, 2)}\n`;
}

// ---------------------------------------------------------------------
// Word(.docx): 꼭 필요한 파일 3개를 압축하지 않은 zip으로 묶음 (패키지 없이)
// ---------------------------------------------------------------------
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function wParagraph(text, { bold = false, size = null, color = null } = {}) {
  const rPr = [bold ? '<w:b/>' : '', color ? `<w:color w:val="${color}"/>` : '', size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''].join('');
  if (!text) return '<w:p/>';
  return `<w:p><w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}
function documentXml(r, tz) {
  const paragraphs = [
    wParagraph(r.title, { bold: true, size: 36 }),
    ...metaLines(r, tz).map(([k, v]) => wParagraph(`${k}: ${v}`, { size: 20, color: '5C6B6B' })),
    wParagraph(''),
    ...r.body.split('\n').map(line => wParagraph(line)),
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 압축하지 않은(stored) zip. files: [{ name, data: Uint8Array }] */
export function storedZip(files, date = new Date(Date.UTC(2026, 0, 1))) {
  const enc = new TextEncoder();
  const dosTime = ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()) & 0xffff;
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);   // UTF-8 이름
    lv.setUint16(8, 0, true); lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, f.data.length, true); lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

function toDocx(r, tz) {
  const enc = new TextEncoder();
  return storedZip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(ROOT_RELS) },
    { name: 'word/document.xml', data: enc.encode(documentXml(r, tz)) },
  ]);
}

/**
 * 내보낼 파일 만들기 (PDF 제외)
 *   반환: { fileName, mimeType, extension, data } — data는 글(string) 또는 바이트(Uint8Array, docx)
 *   알 수 없는 형식이면 code 'UNSUPPORTED_FORMAT', PDF면 'USE_PDF_EXPORT' (ShareExport가 expo-print로 처리)
 */
export function buildExport(input, formatId, { timeZone = 'Asia/Seoul' } = {}) {
  const format = formatOf(formatId);
  if (!format) throw Object.assign(new Error('지원하지 않는 파일 형식이에요'), { code: 'UNSUPPORTED_FORMAT' });
  if (format.id === 'pdf') throw Object.assign(new Error('PDF는 기기에서 따로 만들어요'), { code: 'USE_PDF_EXPORT' });
  const r = normalizeRecord(input);
  const data = format.id === 'txt' ? toTxt(r, timeZone)
    : format.id === 'md' ? toMarkdown(r, timeZone)
      : format.id === 'html' ? toHtml(r, timeZone)
        : format.id === 'json' ? toJson(r)
          : toDocx(r, timeZone);
  return { fileName: `${safeFileName(r.title)}.${format.extension}`, mimeType: format.mimeType, extension: format.extension, data };
}
