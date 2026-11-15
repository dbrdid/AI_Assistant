// PDF 내보내기 — 기기에서 만들기 (서버로 내용을 보내지 않음)
//
//  흐름: 고른 항목(메모·할 일·일정·회의·녹음 전사문·문서 글자) → toPdf…Section으로 구역 만들기
//        → exportPdf({ title, sections }, { printToFileAsync: Print.printToFileAsync })  (expo-print)
//        → ① 공유: Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' })  (expo-sharing)
//          ② 공유 공간에 보관: savePdfAttachment(supabase, { workspaceId, uri, title, readFile })
//             → 받은 asset.id를 메모에 붙이려면 saveLocal(ctx, [{ kind: 'link', entity: 'note_attachments', ... }])
//          개인 공간은 서버에 올리지 않아요 (백업은 기기에서 암호화한 파일만 받음) → 기기에 두거나 공유
//
//  화면에 보이는 글자는 모두 HTML 이스케이프. 그림은 data:image/… 또는 file:// 주소만 넣어요
//  손글씨(strokes)는 SVG로 그려서 확대해도 깨지지 않아요
//  이 파일은 react-native를 쓰지 않아요 (expo-print·파일 읽기는 앱이 함수로 넘김)
import type { SupabaseClient } from '@supabase/supabase-js';
import { uploadAttachment, type AttachmentRow } from './attachments';
import type { Stroke } from './types';

// ---------------------------------------------------------------------
// 문서 모양
// ---------------------------------------------------------------------
export type PdfBlock =
  | { type: 'heading'; text: string; level?: 2 | 3 }
  | { type: 'paragraph'; text: string }                       // 줄바꿈 그대로
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'checklist'; items: { text: string; done: boolean; note?: string }[] }
  | { type: 'table'; header?: string[]; rows: string[][] }
  | { type: 'meta'; items: [string, string][] }               // "날짜: …" 같은 작은 정보 줄
  | { type: 'strokes'; strokes: Stroke[]; caption?: string }
  | { type: 'image'; src: string; caption?: string }
  | { type: 'quote'; text: string }
  | { type: 'divider' }
  | { type: 'pageBreak' };

export interface PdfSection {
  title?: string;
  /** 구역마다 새 쪽에서 시작 */
  newPage?: boolean;
  blocks: PdfBlock[];
}

export interface PdfDocument {
  title: string;
  subtitle?: string;
  meta?: [string, string][];
  sections: PdfSection[];
}

export interface PdfOptions {
  paper?: 'A4' | 'LETTER';
  landscape?: boolean;
  /** 글자 크기 배율 (0.8~1.5) */
  fontScale?: number;
  /** 날짜 표시 시간대 (기본 Asia/Seoul) */
  timeZone?: string;
  /** 머리말 "만든 날짜" (기본 지금) */
  generatedAt?: Date;
  /** 아래쪽 문구 (기본 "Stella에서 만든 문서") */
  footer?: string;
}

export const PDF_PAPER = {
  A4: { width: 595, height: 842 },        // pt (1/72 inch) — expo-print width/height 단위
  LETTER: { width: 612, height: 792 },
} as const;
const MARGIN_PT = 42;                       // 약 15mm

export class PdfExportError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
    this.name = 'PdfExportError';
  }
}

// ---------------------------------------------------------------------
// 이스케이프·날짜
// ---------------------------------------------------------------------
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    // 제어 문자는 빼고(줄바꿈·탭은 둠)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** 날짜·시각 나눠서 { date: "2026. 11. 15. (일)", time: "14:30" } — Intl이 없거나 시간대를 모르면 ISO 앞부분 */
export function dateTimeParts(iso: string, timeZone = 'Asia/Seoul'): { date: string; time: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const f = new Intl.DateTimeFormat('ko-KR', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    return { date: `${p.year}. ${p.month}. ${p.day}. (${p.weekday})`, time: `${p.hour}:${p.minute}` };
  } catch {
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
}

/** "2026. 11. 15. (일) 14:30" (allDay면 날짜만) */
export function formatDateTime(iso: string | null | undefined, opts: { timeZone?: string; allDay?: boolean } = {}): string {
  if (!iso) return '';
  const p = dateTimeParts(iso, opts.timeZone);
  if (!p) return String(iso);
  return opts.allDay ? p.date : `${p.date} ${p.time}`;
}

/** 시작~끝: 같은 날이면 "2026. 11. 15. (일) 14:00 ~ 15:30", 하루 종일이면 날짜만 */
export function formatRange(start: string, end: string | null | undefined, opts: { timeZone?: string; allDay?: boolean } = {}): string {
  const a = dateTimeParts(start, opts.timeZone);
  if (!a) return String(start);
  const b = end ? dateTimeParts(end, opts.timeZone) : null;
  if (opts.allDay) return b && b.date !== a.date ? `${a.date} ~ ${b.date}` : a.date;
  if (!b) return `${a.date} ${a.time}`;
  return b.date === a.date ? `${a.date} ${a.time} ~ ${b.time}` : `${a.date} ${a.time} ~ ${b.date} ${b.time}`;
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)|[a-zA-Z]{3,20})$/;
const SAFE_IMAGE = /^(data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+|file:\/\/[^"'<>\s]+)$/;

// ---------------------------------------------------------------------
// 손글씨 → SVG
// ---------------------------------------------------------------------
/** 획들을 감싸는 상자에 맞춘 SVG (빈 획이면 null) */
export function strokesToSvg(strokes: Stroke[], maxWidthPt = 500, maxHeightPt = 640): string | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0;
  for (const s of strokes) {
    for (const [x, y] of s.p) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    maxW = Math.max(maxW, Number(s.w) || 0);
  }
  if (!Number.isFinite(minX)) return null;
  const pad = maxW / 2 + 2;
  const vx = minX - pad, vy = minY - pad;
  const vw = Math.max(1, maxX - minX + pad * 2), vh = Math.max(1, maxY - minY + pad * 2);
  const scale = Math.min(1, maxWidthPt / vw, maxHeightPt / vh);
  const r = (n: number) => Math.round(n * 100) / 100;
  const paths = strokes.map((s) => {
    const pts = s.p.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pts.length === 0) return '';
    const color = SAFE_COLOR.test(s.c) ? s.c : '#000';
    const w = Math.min(100, Math.max(0.1, Number(s.w) || 1));
    if (pts.length === 1) {
      return `<circle cx="${r(pts[0][0])}" cy="${r(pts[0][1])}" r="${r(w / 2)}" fill="${escapeHtml(color)}"/>`;
    }
    const d = 'M' + pts.map(([x, y]) => `${r(x)} ${r(y)}`).join('L');
    return `<path d="${d}" fill="none" stroke="${escapeHtml(color)}" stroke-width="${r(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(vx)} ${r(vy)} ${r(vw)} ${r(vh)}" ` +
    `width="${r(vw * scale)}pt" height="${r(vh * scale)}pt">${paths}</svg>`;
}

// ---------------------------------------------------------------------
// HTML 만들기
// ---------------------------------------------------------------------
function renderBlock(b: PdfBlock): string {
  switch (b.type) {
    case 'heading': return `<h${(b.level ?? 2) + 1}>${escapeHtml(b.text)}</h${(b.level ?? 2) + 1}>`;
    case 'paragraph': return b.text.trim() ? `<p class="pre">${escapeHtml(b.text.trim())}</p>` : '';
    case 'quote': return `<blockquote class="pre">${escapeHtml(b.text.trim())}</blockquote>`;
    case 'list': {
      if (b.items.length === 0) return '';
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`;
    }
    case 'checklist':
      if (b.items.length === 0) return '<p class="muted">없음</p>';
      return `<ul class="check">${b.items.map((i) =>
        `<li class="${i.done ? 'done' : ''}"><span class="box">${i.done ? '&#10003;' : ''}</span>` +
        `<span class="t">${escapeHtml(i.text)}</span>${i.note ? `<span class="note">${escapeHtml(i.note)}</span>` : ''}</li>`).join('')}</ul>`;
    case 'table': {
      if (b.rows.length === 0 && !b.header) return '';
      const head = b.header ? `<thead><tr>${b.header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` : '';
      const body = b.rows.map((r) => `<tr>${r.map((c) => `<td class="pre">${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
      return `<table>${head}<tbody>${body}</tbody></table>`;
    }
    case 'meta':
      if (b.items.length === 0) return '';
      return `<dl class="meta">${b.items.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
    case 'strokes': {
      const svg = strokesToSvg(b.strokes);
      if (!svg) return '';
      return `<figure class="ink">${svg}${b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''}</figure>`;
    }
    case 'image': {
      const src = b.src.trim();
      if (!SAFE_IMAGE.test(src)) return `<p class="muted">[그림을 넣을 수 없어요${b.caption ? `: ${escapeHtml(b.caption)}` : ''}]</p>`;
      return `<figure><img src="${escapeHtml(src.replace(/\s+/g, ''))}" alt="${escapeHtml(b.caption ?? '')}"/>` +
        `${b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''}</figure>`;
    }
    case 'divider': return '<hr/>';
    case 'pageBreak': return '<div class="page-break"></div>';
  }
}

/** expo-print에 넘길 HTML 한 장 (글꼴: 기기 기본 한글 글꼴) */
export function renderPdfHtml(doc: PdfDocument, opts: PdfOptions = {}): string {
  const paper = opts.paper ?? 'A4';
  const scale = Math.min(1.5, Math.max(0.8, opts.fontScale ?? 1));
  const generated = formatDateTime((opts.generatedAt ?? new Date()).toISOString(), { timeZone: opts.timeZone });
  const footer = opts.footer ?? 'Stella에서 만든 문서';
  const sections = doc.sections.map((s, i) => {
    const blocks = s.blocks.map(renderBlock).filter(Boolean).join('\n');
    const cls = s.newPage && i > 0 ? 'section new-page' : 'section';
    return `<section class="${cls}">${s.title ? `<h2>${escapeHtml(s.title)}</h2>` : ''}${blocks || '<p class="muted">내용 없음</p>'}</section>`;
  }).join('\n');
  const meta = [...(doc.meta ?? []), ['만든 날짜', generated] as [string, string]];

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(doc.title)}</title>
<style>
  @page { size: ${paper === 'A4' ? 'A4' : 'letter'} ${opts.landscape ? 'landscape' : 'portrait'}; margin: ${MARGIN_PT}pt; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: #1d1d1f; font-size: ${(10.5 * scale).toFixed(1)}pt; line-height: 1.6;
         font-family: -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic", Roboto, sans-serif;
         word-break: keep-all; overflow-wrap: anywhere;
         /* 대체 글리프·합자를 끄면 PDF에서 글자 복사·검색이 정확해짐 (예: 숫자 사이 ':'가 다른 모양으로 바뀌는 글꼴) */
         font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0, "clig" 0, "dlig" 0; }
  header.doc { border-bottom: 1.5pt solid #1d1d1f; padding-bottom: 8pt; margin-bottom: 14pt; }
  h1 { font-size: ${(19 * scale).toFixed(1)}pt; line-height: 1.3; margin: 0 0 4pt; }
  .subtitle { color: #555; margin: 0 0 6pt; }
  h2 { font-size: ${(14 * scale).toFixed(1)}pt; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 0.5pt solid #ccc; break-after: avoid; }
  h3 { font-size: ${(12 * scale).toFixed(1)}pt; margin: 12pt 0 4pt; break-after: avoid; }
  h4 { font-size: ${(11 * scale).toFixed(1)}pt; margin: 10pt 0 4pt; break-after: avoid; }
  p { margin: 0 0 6pt; }
  .pre { white-space: pre-wrap; }
  .muted { color: #888; }
  ul, ol { margin: 0 0 6pt; padding-left: 16pt; }
  li { margin: 1pt 0; break-inside: avoid; }
  ul.check { list-style: none; padding-left: 0; }
  ul.check li { display: flex; gap: 6pt; align-items: baseline; }
  ul.check .box { flex: none; width: 9pt; height: 9pt; border: 0.8pt solid #444; border-radius: 2pt; font-size: 8pt; line-height: 9pt; text-align: center; }
  ul.check li.done .t { color: #777; text-decoration: line-through; }
  ul.check .note { color: #666; font-size: 0.9em; margin-left: auto; padding-left: 8pt; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; margin: 4pt 0 8pt; font-size: 0.95em; }
  th, td { border: 0.5pt solid #bbb; padding: 3pt 5pt; text-align: left; vertical-align: top; }
  th { background: #f2f2f4; }
  tr { break-inside: avoid; }
  dl.meta { display: flex; flex-wrap: wrap; gap: 2pt 14pt; margin: 0 0 6pt; color: #555; font-size: 0.9em; }
  dl.meta div { display: flex; gap: 4pt; } dl.meta dt { font-weight: 600; } dl.meta dd { margin: 0; }
  blockquote { margin: 0 0 6pt; padding: 4pt 8pt; border-left: 2pt solid #bbb; color: #444; background: #fafafa; }
  figure { margin: 6pt 0 10pt; break-inside: avoid; text-align: center; }
  figure img { max-width: 100%; max-height: 640pt; }
  figure.ink svg { max-width: 100%; height: auto; border: 0.5pt solid #e3e3e3; border-radius: 3pt; background: #fff; }
  figcaption { color: #666; font-size: 0.85em; margin-top: 3pt; }
  hr { border: 0; border-top: 0.5pt solid #ccc; margin: 10pt 0; }
  .page-break, .new-page { break-before: page; page-break-before: always; }
  footer.doc { margin-top: 18pt; padding-top: 6pt; border-top: 0.5pt solid #ddd; color: #999; font-size: 0.8em; }
</style></head>
<body>
<header class="doc">
  <h1>${escapeHtml(doc.title)}</h1>
  ${doc.subtitle ? `<p class="subtitle">${escapeHtml(doc.subtitle)}</p>` : ''}
  ${renderBlock({ type: 'meta', items: meta })}
</header>
${sections}
<footer class="doc">${escapeHtml(footer)}</footer>
</body></html>`;
}

// ---------------------------------------------------------------------
// Stella 데이터 → 구역
// ---------------------------------------------------------------------
const STATUS_KO: Record<string, string> = { TODO: '할 일', IN_PROGRESS: '진행 중', DONE: '완료', CANCELED: '취소', ON_HOLD: '보류' };
const PRIORITY_KO = ['', '낮음', '보통', '높음'];
const AGENDA_KO: Record<string, string> = { OPEN: '논의 전', DISCUSSED: '논의함', DEFERRED: '보류', CARRIED_OVER: '다음 회의로', CLOSED: '종료' };

export function notePdfSection(note: { title?: string | null; body?: string | null; strokes?: Stroke[] | null; updated_at?: string | null },
  opts: { timeZone?: string; newPage?: boolean } = {}): PdfSection {
  const blocks: PdfBlock[] = [];
  if (note.updated_at) blocks.push({ type: 'meta', items: [['수정', formatDateTime(note.updated_at, opts)]] });
  if (note.body?.trim()) blocks.push({ type: 'paragraph', text: note.body });
  if (note.strokes && note.strokes.length > 0) blocks.push({ type: 'strokes', strokes: note.strokes, caption: '손글씨' });
  return { title: note.title?.trim() || '제목 없는 메모', newPage: opts.newPage, blocks };
}

export function tasksPdfSection(tasks: Array<{ title: string; status?: string | null; due_at?: string | null; all_day?: boolean | null;
  priority?: number | null; assignee_name?: string | null; description?: string | null }>,
  opts: { title?: string; timeZone?: string } = {}): PdfSection {
  const sorted = [...tasks].sort((a, b) => Number(a.status === 'DONE' || a.status === 'CANCELED') - Number(b.status === 'DONE' || b.status === 'CANCELED')
    || String(a.due_at ?? '9999').localeCompare(String(b.due_at ?? '9999')));
  return {
    title: opts.title ?? '할 일',
    blocks: [{
      type: 'checklist',
      items: sorted.filter((t) => t.status !== 'CANCELED').map((t) => ({
        text: t.title + (t.description?.trim() ? ` — ${t.description.trim()}` : ''),
        done: t.status === 'DONE',
        note: [t.due_at ? `마감 ${formatDateTime(t.due_at, { timeZone: opts.timeZone, allDay: !!t.all_day })}` : '',
          t.assignee_name ?? '', t.priority ? `중요도 ${PRIORITY_KO[t.priority] ?? t.priority}` : ''].filter(Boolean).join(' · ') || undefined,
      })),
    }],
  };
}

export function eventsPdfSection(events: Array<{ title: string; start_at: string; end_at?: string | null; all_day?: boolean | null;
  location?: string | null; status?: string | null; timezone?: string | null }>, opts: { title?: string; timeZone?: string } = {}): PdfSection {
  const rows = [...events].sort((a, b) => a.start_at.localeCompare(b.start_at)).map((e) => {
    const tz = opts.timeZone ?? e.timezone ?? undefined;
    const when = formatRange(e.start_at, e.end_at, { timeZone: tz, allDay: !!e.all_day }) + (e.all_day ? ' (하루 종일)' : '');
    return [when, e.title, e.location ?? '', STATUS_KO[e.status ?? 'TODO'] ?? ''];
  });
  return { title: opts.title ?? '일정', blocks: [{ type: 'table', header: ['언제', '일정', '장소', '상태'], rows }] };
}

export function meetingPdfSection(meeting: { title: string; starts_at?: string | null; ends_at?: string | null; status?: string | null },
  agenda: Array<{ title: string; description?: string | null; status?: string | null; position?: number | null }>,
  opts: { timeZone?: string; minutes?: string | null; newPage?: boolean } = {}): PdfSection {
  const blocks: PdfBlock[] = [{
    type: 'meta',
    items: [
      ...(meeting.starts_at ? [['일시', formatRange(meeting.starts_at, meeting.ends_at, opts)] as [string, string]] : []),
      ...(meeting.status ? [['상태', meeting.status === 'DONE' ? '끝남' : meeting.status === 'CANCELED' ? '취소' : '예정'] as [string, string]] : []),
    ],
  }];
  const items = [...agenda].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (items.length > 0) {
    blocks.push({ type: 'heading', text: '안건' });
    blocks.push({ type: 'table', header: ['#', '안건', '상태'],
      rows: items.map((a, i) => [String(i + 1), a.title + (a.description?.trim() ? `\n${a.description.trim()}` : ''), AGENDA_KO[a.status ?? 'OPEN'] ?? '']) });
  }
  if (opts.minutes?.trim()) {
    blocks.push({ type: 'heading', text: '회의록' });
    blocks.push({ type: 'paragraph', text: opts.minutes });
  }
  return { title: meeting.title, newPage: opts.newPage, blocks };
}

/**
 * 녹음 전사문 (recordings.ts getRecordingTranscript의 결과 또는 저장해 둔 글)
 *   "[12:00] …" 시각 표시는 그대로 두고, 구간마다 문단으로 나눔
 */
export function transcriptPdfSection(transcript: { text: string } | string, opts: { title?: string; summary?: string | null; newPage?: boolean } = {}): PdfSection {
  const text = typeof transcript === 'string' ? transcript : transcript.text;
  const blocks: PdfBlock[] = [];
  if (opts.summary?.trim()) {
    blocks.push({ type: 'heading', text: '요약' });
    blocks.push({ type: 'quote', text: opts.summary });
    blocks.push({ type: 'heading', text: '전사문' });
  }
  for (const part of text.split(/\n{2,}/)) if (part.trim()) blocks.push({ type: 'paragraph', text: part });
  return { title: opts.title ?? '녹음 전사문', newPage: opts.newPage, blocks };
}

/** 문서 글자 추출 결과 (documents.ts extractDocumentText의 pages) → 쪽마다 소제목 */
export function documentTextPdfSection(d: { pages: { number: number; text: string; notes?: string }[]; kind: string; pageBasis: string },
  opts: { title?: string; newPage?: boolean } = {}): PdfSection {
  const label = (n: number) => d.pageBasis === 'SLIDE' ? `슬라이드 ${n}` : d.pageBasis === 'PDF_PAGE' ? `${n}쪽` : d.pageBasis === 'NONE' ? '' : `약 ${n}쪽`;
  const blocks: PdfBlock[] = [];
  for (const p of d.pages) {
    const l = label(p.number);
    if (l) blocks.push({ type: 'heading', text: l, level: 3 });
    blocks.push({ type: 'paragraph', text: p.text || '(글자 없음)' });
    if (p.notes) blocks.push({ type: 'quote', text: `발표자 메모: ${p.notes}` });
  }
  return { title: opts.title ?? '문서 글자', newPage: opts.newPage, blocks };
}

// ---------------------------------------------------------------------
// 만들기·보관
// ---------------------------------------------------------------------
/** 파일 이름: 쓸 수 없는 글자 빼고 80자, ".pdf" */
export function pdfFileName(title: string, date?: Date): string {
  const base = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Stella 내보내기';
  const stamp = date ? ` ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
  return `${base}${stamp}.pdf`;
}

export type PrintToFile = (o: {
  html: string; width?: number; height?: number; base64?: boolean;
  margins?: { left: number; top: number; right: number; bottom: number };
}) => Promise<{ uri: string; numberOfPages?: number; base64?: string }>;

/**
 * 기기에서 PDF 만들기 (expo-print)
 *   import * as Print from 'expo-print'
 *   const pdf = await exportPdf(doc, { printToFileAsync: Print.printToFileAsync })
 *   → pdf.uri (앱 캐시 폴더의 임시 파일. 공유·보관 뒤 지워도 돼요)
 */
export async function exportPdf(doc: PdfDocument, deps: { printToFileAsync: PrintToFile }, opts: PdfOptions = {}) {
  if (!doc.title?.trim()) throw new PdfExportError('INVALID_REQUEST', '제목이 필요해요');
  if (doc.sections.length === 0) throw new PdfExportError('INVALID_REQUEST', '내보낼 내용을 골라 주세요');
  const html = renderPdfHtml(doc, opts);
  const size = PDF_PAPER[opts.paper ?? 'A4'];
  const [width, height] = opts.landscape ? [size.height, size.width] : [size.width, size.height];
  try {
    const r = await deps.printToFileAsync({
      html, width, height,
      // iOS는 @page 여백을 무시해서 여백을 따로 넘김 (Android는 @page를 씀)
      margins: { left: MARGIN_PT, top: MARGIN_PT, right: MARGIN_PT, bottom: MARGIN_PT },
    });
    if (!r?.uri) throw new Error('no uri');
    return { uri: r.uri, pages: r.numberOfPages ?? null, fileName: pdfFileName(doc.title), html };
  } catch (e) {
    throw new PdfExportError('PRINT_FAILED', 'PDF를 만들지 못했어요. 다시 시도해 주세요', e);
  }
}

/**
 * 만든 PDF를 공유 공간 첨부로 보관 (attachments.ts uploadAttachment 사용 → 다른 멤버 기기에 동기화)
 *   readFile: expo-file-system  (uri) => new File(uri).bytes()
 *   digest  : expo-crypto        (b) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, b)
 *   같은 assetId로 다시 부르면 이어서 올려요 (attachments.ts 규칙)
 */
export async function savePdfAttachment(client: SupabaseClient, input: {
  workspaceId: string;
  assetId: string;
  uri: string;
  title: string;
  readFile: (uri: string) => Promise<Uint8Array | ArrayBuffer>;
  digest?: (bytes: Uint8Array) => Promise<ArrayBuffer>;
}): Promise<AttachmentRow> {
  if (!input.workspaceId) throw new PdfExportError('INVALID_REQUEST', '보관할 공유 공간을 골라 주세요 (개인 공간은 기기에 저장하거나 공유해 주세요)');
  const raw = await input.readFile(input.uri);
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw new PdfExportError('NOT_PDF', 'PDF 파일이 아니에요');
  }
  return uploadAttachment(client, {
    workspaceId: input.workspaceId, purpose: 'ATTACHMENT', assetId: input.assetId,
    bytes, mimeType: 'application/pdf', name: pdfFileName(input.title), digest: input.digest,
  });
}
