import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import {
  EXPORT_FORMATS, buildExport, formatOf, normalizeRecord, safeFileName, storedZip,
} from '../../frontend/Frontend_UI/src/services/export/MeetingExport.mjs';

const memo = {
  title: '주간 회의: 3/4분기 <계획> & "정리"',
  body: '1. 발표 순서 정하기\r\n2. 예산 <확인>\n\n다음 회의: 금요일',
  createdAt: Date.UTC(2026, 10, 25, 4, 40),   // 2026-11-25 13:40 KST
  updatedAt: Date.UTC(2026, 10, 25, 5, 0),
  project: '모바일 프로젝트',
};
const text = out => (typeof out.data === 'string' ? out.data : new TextDecoder().decode(out.data));

/** 압축하지 않은 zip 읽기: 이름 → 바이트 (CRC는 node:zlib로 따로 확인) */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    assert.equal(view.getUint16(at + 8, true), 0, '압축 방식: stored');
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    assert.equal(crc32(data) >>> 0, crc, `${name} CRC`);
    files.set(name, data);
    at += 30 + nameLen + size;
  }
  // 중앙 목록·끝 표시
  let count = 0;
  while (view.getUint32(at, true) === 0x02014b50) { count++; at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true); }
  assert.equal(view.getUint32(at, true), 0x06054b50, '끝 표시');
  assert.equal(view.getUint16(at + 10, true), count);
  assert.equal(at + 22, bytes.length);
  return files;
}

test('내보내기: 형식 목록과 이름 찾기', () => {
  assert.deepEqual(EXPORT_FORMATS.map(f => f.id), ['pdf', 'docx', 'txt', 'md', 'html', 'json']);
  assert.equal(formatOf('DOCX').extension, 'docx');
  assert.equal(formatOf('rtf'), null);
  assert.throws(() => buildExport(memo, 'rtf'), e => e.code === 'UNSUPPORTED_FORMAT');
  assert.throws(() => buildExport(memo, 'pdf'), e => e.code === 'USE_PDF_EXPORT');   // PDF는 기기(expo-print)에서
});

test('내보내기: 파일 이름은 쓸 수 없는 글자를 바꾸고 비면 "메모"', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeFileName('  ..  '), '메모');
  assert.equal(safeFileName(''), '메모');
  assert.equal(safeFileName('가'.repeat(100)).length, 80);
  assert.equal(buildExport({ title: '', body: '내용' }, 'txt').fileName, '메모.txt');
  assert.equal(buildExport(memo, 'md').fileName, '주간 회의_ 3_4분기 _계획_ & _정리_.md');
});

test('내보내기: txt·md는 제목·날짜·프로젝트·본문을 그대로 (줄바꿈은 \\n)', () => {
  const txt = text(buildExport(memo, 'txt'));
  assert.match(txt, /^주간 회의: 3\/4분기 <계획> & "정리"\n작성: 2026년 11월 25일 (오후 )?1:40/);
  assert.match(txt, /\n수정: 2026년 11월 25일 (오후 )?2:00/);
  assert.match(txt, /\n프로젝트: 모바일 프로젝트\n\n1\. 발표 순서 정하기\n2\. 예산 <확인>\n\n다음 회의: 금요일$/);
  assert.ok(!txt.includes('\r'));
  const md = text(buildExport(memo, 'md'));
  assert.ok(md.startsWith('# 주간 회의: 3/4분기 <계획> & "정리"\n\n- 작성: '));
  assert.ok(md.includes('\n## 내용\n\n1. 발표 순서 정하기\n'));
  // 날짜가 없으면 날짜 줄도 없음
  assert.equal(text(buildExport({ title: 'T', body: 'B' }, 'txt')), 'T\n\nB');
});

test('내보내기: html은 사용자가 쓴 글을 모두 이스케이프', () => {
  const html = text(buildExport({ ...memo, body: '<script>alert(1)</script>\n"따옴표" & \'작은\'' }, 'html'));
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('<title>주간 회의: 3/4분기 &lt;계획&gt; &amp; &quot;정리&quot;</title>'));
  assert.ok(html.includes('&quot;따옴표&quot; &amp; &#39;작은&#39;'));
});

test('내보내기: json은 ISO 날짜와 원문', () => {
  const j = JSON.parse(text(buildExport(memo, 'json')));
  assert.deepEqual(j, {
    title: memo.title, createdAt: '2026-11-25T04:40:00.000Z', updatedAt: '2026-11-25T05:00:00.000Z',
    project: '모바일 프로젝트', body: '1. 발표 순서 정하기\n2. 예산 <확인>\n\n다음 회의: 금요일',
  });
  assert.equal(JSON.parse(text(buildExport({ body: 'x', createdAt: 'not a date' }, 'json'))).createdAt, null);
});

test('내보내기: docx는 올바른 zip이고 문서에 제목·본문 줄이 이스케이프되어 들어감', () => {
  const out = buildExport(memo, 'docx');
  assert.ok(out.data instanceof Uint8Array);
  assert.equal(out.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const files = readZip(out.data);
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  const doc = new TextDecoder().decode(files.get('word/document.xml'));
  assert.ok(doc.includes('<w:t xml:space="preserve">주간 회의: 3/4분기 &lt;계획&gt; &amp; &quot;정리&quot;</w:t>'));
  assert.ok(doc.includes('<w:t xml:space="preserve">2. 예산 &lt;확인&gt;</w:t>'));
  assert.equal((doc.match(/<w:p\/>/g) ?? []).length, 2);   // 머리 아래 빈 줄 + 본문의 빈 줄
  // XML에 쓸 수 없는 제어 문자는 빠짐
  const ctrl = new TextDecoder().decode(readZip(buildExport({ title: 'A\u0001B', body: 'C\u0008D' }, 'docx').data).get('word/document.xml'));
  assert.ok(ctrl.includes('>AB<') && ctrl.includes('>CD<'));
});

test('내보내기: zip은 한글 파일 이름과 빈 파일도 담음', () => {
  const enc = new TextEncoder();
  const files = readZip(storedZip([{ name: '한글.txt', data: enc.encode('안녕') }, { name: 'empty', data: new Uint8Array(0) }]));
  assert.equal(new TextDecoder().decode(files.get('한글.txt')), '안녕');
  assert.equal(files.get('empty').length, 0);
});

test('내보내기: 기록 정리 (제목 200자, transcript도 본문으로)', () => {
  const r = normalizeRecord({ title: `  ${'x'.repeat(300)}  `, transcript: '녹음 글' });
  assert.equal(r.title.length, 200);
  assert.equal(r.body, '녹음 글');
});
