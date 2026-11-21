import { LIMITS } from '../../../../../../backend/local/src/validate.js';

const reservedFileName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const untitledMarker = '<!-- stella:untitled -->';
const firstHeadingPattern = /^# +([^\n]+)(?:\n+|$)/;
export const MAX_MARKDOWN_BYTES = 4 * (LIMITS.body + LIMITS.memoTitle + 8);

export function memoMarkdown({ title, body }) {
  const heading = title.trim().replace(/[\r\n]+/g, ' ');
  let base = heading.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80).replace(/[. ]+$/g, '');
  if (!base || reservedFileName.test(base)) base = '메모';
  const needsUntitledMarker = firstHeadingPattern.test(body) || body.startsWith(untitledMarker);
  const header = heading ? `# ${heading}` : needsUntitledMarker ? untitledMarker : '';
  return {
    name: `${base}.md`,
    content: header ? `${header}\n\n${body}` : body,
  };
}

export function readMemoMarkdown(name, text) {
  if (!/\.(?:md|markdown)$/i.test(name)) throw new Error('Markdown 파일(.md 또는 .markdown)을 선택해 주세요.');
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!source || source.includes('\u0000')) throw new Error('내용이 비었거나 텍스트로 읽을 수 없는 파일이에요.');
  const untitled = source.startsWith(`${untitledMarker}\n\n`);
  const firstHeading = firstHeadingPattern.exec(source);
  const fallbackTitle = name.replace(/\.(?:md|markdown)$/i, '').slice(0, LIMITS.memoTitle);
  const title = untitled ? '' : firstHeading?.[1].trim() ?? fallbackTitle;
  const body = untitled ? source.slice(untitledMarker.length + 2) : source.slice(firstHeading?.[0].length ?? 0);
  if (title.length > LIMITS.memoTitle || body.length > LIMITS.body) {
    throw new Error('메모에 저장할 수 있는 길이를 넘었어요. 파일을 나누어 가져와 주세요.');
  }
  return { title, body };
}
