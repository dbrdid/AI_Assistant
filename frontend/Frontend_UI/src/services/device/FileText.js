// ============================================================
// FileText.js — 파일에서 "검색용 글자" 뽑기
// ============================================================
// 지금 가능한 것: 글자 파일(txt, md, csv, json, html, xml, log 등) 은 앱 안에서 바로 내용을 읽음.
// 아직 안 되는 것: PDF / Word / PowerPoint / 한글 / 이미지(글자 인식).
//   → 이런 파일은 백엔드(서버)가 준비되면 이 파일의 extractFromBackend 만 채우면 검색·AI 에 바로 반영됩니다.
//   그 전까지는 "파일 이름"으로만 검색됩니다.

const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'html', 'htm', 'xml', 'yml', 'yaml', 'ini'];
const MAX_BYTES = 2 * 1024 * 1024; // 2MB 넘는 글자 파일은 읽지 않음
export const MAX_TEXT = 30000;      // 저장하는 글자 수 상한 (저장 공간 보호)

export const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

export function isTextFile(name, mime, size) {
  if (size && size > MAX_BYTES) return false;
  return (mime || '').startsWith('text/') || TEXT_EXT.includes(extOf(name));
}

// TODO(백엔드): PDF/DOCX/PPTX/이미지 파일을 서버로 보내 글자를 받아오는 함수. 지금은 null (= 이름으로만 검색)
async function extractFromBackend(/* file */) {
  return null;
}

// 반환: { text: '검색용 글자', indexed: 내용이 검색에 포함되는지 }
export async function extractText({ uri, name, mime, size }) {
  try {
    if (isTextFile(name, mime, size)) {
      // 별도 패키지 없이 fetch 로 파일 주소(file://)를 읽음
      const raw = await (await fetch(uri)).text();
      const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      return { text, indexed: true };
    }
    const fromServer = await extractFromBackend({ uri, name, mime, size });
    if (fromServer) return { text: String(fromServer).slice(0, MAX_TEXT), indexed: true };
  } catch (e) {
    // 읽기에 실패해도 파일 자체는 저장 (이름으로 검색 가능)
  }
  return { text: '', indexed: false };
}
