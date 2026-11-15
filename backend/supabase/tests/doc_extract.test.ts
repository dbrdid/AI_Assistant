// 문서 글자 추출 (Edge Function doc-extract) — 해석(extract.ts) + 요청 처리(handler.ts)
//   실행: deno test -A --no-check --config deno.test.json doc_extract.test.ts
//   테스트 파일: fixtures/docs (make_fixtures.py로 다시 만들 수 있음)
import nodeAssert from "node:assert/strict";
import { strToU8, zipSync } from "npm:fflate@0.8";
import * as X from "../functions/doc-extract/extract.ts";
import { type AssetMeta, createHandler } from "../functions/doc-extract/handler.ts";

const eq = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepEqual(a, b, msg);
const DIR = new URL("./fixtures/docs/", import.meta.url);
const file = (n: string) => Deno.readFile(new URL(n, DIR));

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const docxOf = (body: string) =>
  zipSync({ "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`) });

Deno.test("extract.ts: PDF", async (t) => {
  await t.step("쪽마다 글자, 빈 쪽 표시, 특수문자 그대로", async () => {
    const r = await X.extractPdf(await file("lecture.pdf"));
    eq([r.kind, r.pageBasis, r.totalPages, r.nextFromPage, r.noText], ["PDF", "PDF_PAGE", 3, null, false]);
    eq(r.pages.map((p) => p.number), [1, 2, 3]);
    eq(r.pages[0].text.split("\n")[0], "1쪽 제목: 정규화와 트랜잭션");
    nodeAssert.ok(r.pages[0].text.includes("본문 1-3: 데이터베이스 설계에서 중복을 줄이는 방법 & <태그> 예시"));
    eq(r.pages[1].text, "", "2쪽은 빈 쪽");
    const joined = X.joinPages(r.pageBasis, r.pages);
    nodeAssert.match(joined, /^--- 1쪽 ---\n1쪽 제목/);
    nodeAssert.ok(joined.includes("--- 2쪽 ---\n(글자 없음)\n\n--- 3쪽 ---\n3쪽 제목"));
  });

  await t.step("긴 PDF: 한 번에 50쪽 → 이어서 부르기", async () => {
    const big = await file("big.pdf");
    const a = await X.extractPdf(big);
    eq([a.totalPages > 100, a.fromPage, a.pages.length, a.nextFromPage], [true, 1, 50, 51]);
    const b = await X.extractPdf(big, { fromPage: 51, maxPages: 10 });
    eq([b.fromPage, b.pages[0].number, b.pages.length, b.nextFromPage], [51, 51, 10, 61]);
    const last = await X.extractPdf(big, { fromPage: a.totalPages });
    eq([last.pages.length, last.nextFromPage], [1, null]);
    await nodeAssert.rejects(X.extractPdf(big, { fromPage: a.totalPages + 1 }), (e: X.ExtractError) => e.code === "PAGE_OUT_OF_RANGE");
  });

  await t.step("시간 예산을 넘으면 그 자리에서 멈춤 (최소 1쪽은 진행)", async () => {
    let clock = 0;
    const r = await X.extractPdf(await file("big.pdf"), { now: () => (clock += 700) });
    // 시작 700 → 1쪽 뒤 1400(예산 1200 안 넘음, 경과 700) → 2쪽 뒤 경과 1400 > 1200 → 멈춤
    eq([r.pages.length, r.nextFromPage], [2, 3]);
    let c2 = 0;
    const one = await X.extractPdf(await file("big.pdf"), { now: () => (c2 += 5000) });
    eq([one.pages.length, one.nextFromPage], [1, 2], "예산을 이미 넘어도 1쪽은 읽음 (무한 반복 방지)");
  });

  await t.step("글자 수 한도에서도 멈춤", async () => {
    const r = await X.extractPdf(await file("big.pdf"), { maxChars: 100 });
    eq([r.pages.length, r.nextFromPage], [1, 2]);
  });

  await t.step("스캔본(글자층 없음) → noText", async () => {
    const r = await X.extractPdf(await file("scanned.pdf"));
    eq([r.totalPages, r.noText, r.pages.map((p) => p.text)], [2, true, ["", ""]]);
  });

  await t.step("암호 PDF·깨진 PDF", async () => {
    await nodeAssert.rejects(X.extractPdf(await file("encrypted.pdf")), (e: X.ExtractError) => e.code === "FILE_ENCRYPTED");
    const broken = (await file("lecture.pdf")).slice(0, 400);
    await nodeAssert.rejects(X.extractPdf(broken), (e: X.ExtractError) => e.code === "FILE_DAMAGED");
  });

  await t.step("글자 조각 잇기: 떨어진 조각은 띄어 쓰고, 줄이 바뀌면 줄바꿈", () => {
    const it = (str: string, x: number, y: number, w: number, eol = false) => ({ str, transform: [10, 0, 0, 10, x, y], width: w, hasEOL: eol });
    eq(X.joinPdfItems([it("데이터", 0, 100, 30), it("베이스", 30, 100, 30), it("설계", 70, 100, 20), it("다음 줄", 0, 80, 40)]),
       "데이터베이스 설계\n다음 줄");
    eq(X.joinPdfItems([it("끝", 0, 100, 10, true), it("새 줄", 0, 80, 20)]), "끝\n새 줄");
    // 유니코드 대응이 없는 글리프(사용자 영역 글자)는 네모로 보이지 않게 뺌
    eq(X.joinPdfItems([it("14", 0, 100, 10), it("\uE092", 10, 100, 3), it("30", 13, 100, 10)]), "1430");
  });
});

Deno.test("extract.ts: DOCX", async (t) => {
  await t.step("본문·탭·줄바꿈·표·쪽 나눔", async () => {
    const r = X.extractDocx(await file("meeting.docx"));
    eq([r.kind, r.pageBasis, r.totalPages], ["DOCX", "DOCX_EXPLICIT", 2]);
    eq(r.pages[0].text, "회의록: 스텔라 2주차\n참석: 병욱, 주원\n결정: 구간은 2분\t탭 뒤 & 기호 <a>\n줄바꿈 앞\n줄바꿈 뒤\n다음 쪽으로");
    eq(r.pages[1].text, "2쪽 내용: 할 일 정리\n담당 | 마감\n병욱 | 11/20");
    nodeAssert.match(X.joinPages(r.pageBasis, r.pages), /^--- 약 1쪽 ---\n회의록/);
  });

  await t.step("쪽 정보 없으면 나누지 않고 표시도 안 함", () => {
    const r = X.extractDocx(docxOf(`<w:p><w:r><w:t>한 문단</w:t></w:r></w:p><w:p/><w:p><w:r><w:t xml:space="preserve">둘째 </w:t></w:r></w:p>`));
    eq([r.pageBasis, r.totalPages, r.pages[0].text], ["NONE", 1, "한 문단\n\n둘째"]);
    eq(X.joinPages(r.pageBasis, r.pages), "한 문단\n\n둘째");
  });

  await t.step("저장 당시 쪽 표시 + 직접 쪽 나눔이 겹쳐도 빈 쪽 안 생김", () => {
    const r = X.extractDocx(docxOf(
      `<w:p><w:r><w:t>1쪽</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>` +
      `<w:p><w:r><w:lastRenderedPageBreak/><w:t>2쪽</w:t></w:r></w:p>` +
      `<w:p><w:r><w:lastRenderedPageBreak/><w:t>3쪽</w:t></w:r></w:p>`));
    eq([r.pageBasis, r.pages.map((p) => p.text)], ["DOCX_RENDERED", ["1쪽", "2쪽", "3쪽"]]);
  });

  await t.step("지운 글자(변경 추적)·필드 코드·글상자 옛 형식 중복은 뺌, 엔티티 풀기", () => {
    const r = X.extractDocx(docxOf(
      `<w:p><w:r><w:t>남김</w:t></w:r><w:del><w:r><w:delText>지움</w:delText></w:r></w:del>` +
      `<w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>&lt;a&gt; &amp; &#xAC00;&#44032;</w:t></w:r></w:p>` +
      `<w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>글상자</w:t></w:r></w:p></w:txbxContent></mc:Choice>` +
      `<mc:Fallback><w:txbxContent><w:p><w:r><w:t>글상자</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>`));
    eq(r.pages[0].text, "남김<a> & 가가\n글상자");
  });

  await t.step("zip 폭탄·깨진 파일·다른 종류", () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(X.EXTRACT_LIMITS.maxZipEntryBytes + 1) }, { level: 9 });
    nodeAssert.ok(bomb.byteLength < 200_000, "압축하면 작음");
    nodeAssert.throws(() => X.extractDocx(bomb), (e: X.ExtractError) => e.code === "TOO_LARGE" && e.status === 413);
    nodeAssert.throws(() => X.extractDocx(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])), (e: X.ExtractError) => e.code === "FILE_DAMAGED");
    nodeAssert.throws(() => X.extractDocx(zipSync({ "a.txt": strToU8("x") })), (e: X.ExtractError) => e.code === "UNSUPPORTED_TYPE");
  });

  await t.step("글자 수 한도", () => {
    const r = X.docxPages(`<w:body><w:p><w:r><w:t>${"가".repeat(50)}</w:t></w:r></w:p></w:body>`, 10);
    eq([r.truncated, r.pages[0]], [true, "가".repeat(10)]);
  });
});

Deno.test("extract.ts: PPTX", async (t) => {
  await t.step("슬라이드 글자 + 발표자 메모 (쪽 번호·그림 자리 빼고)", async () => {
    const r = X.extractPptx(await file("slides.pptx"));
    eq([r.kind, r.pageBasis, r.totalPages], ["PPTX", "SLIDE", 3]);
    eq(r.pages.map((p) => [p.number, p.text, p.notes ?? null]), [
      [1, "1장 소개\n스텔라는 메모 앱", null],
      [2, "2장 구조\n서버: Supabase\n기기: SQLite", "발표자 메모: 동기화 설명"],
      [3, "3장 마무리", null],
    ]);
    eq(X.joinPages(r.pageBasis, r.pages).split("\n\n")[1], "--- 슬라이드 2 ---\n2장 구조\n서버: Supabase\n기기: SQLite\n[발표자 메모] 발표자 메모: 동기화 설명");
    eq(X.extractPptx(await file("slides.pptx"), { notes: false }).pages[1].notes, undefined, "메모 빼기");
  });

  await t.step("표시 순서는 파일 이름이 아니라 presentation.xml 순서", async () => {
    const r = X.extractPptx(await file("slides_reordered.pptx"));
    eq(r.pages.map((p) => p.text.split("\n")[0]), ["2장 구조", "3장 마무리", "1장 소개"]);
  });

  await t.step("숨긴 슬라이드 표시, 표는 칸을 | 로", () => {
    const pptx = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide9.xml"/></Relationships>`),
      "ppt/slides/slide9.xml": strToU8(`<p:sld show="0"><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc>` +
        `<a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl><a:p><a:r><a:t>줄1</a:t></a:r><a:br/><a:r><a:t>줄2</a:t></a:r></a:p></p:sld>`),
    });
    const r = X.extractPptx(pptx);
    eq(r.pages, [{ number: 1, text: "A | B\n줄1\n줄2", hidden: true }]);
    nodeAssert.match(X.joinPages(r.pageBasis, r.pages), /^--- 슬라이드 1 ---\n\(숨긴 슬라이드\)\nA \| B/);
  });
});

Deno.test("extract.ts: PPTX 메모는 메모 칸만", () => {
  const notes = `<p:notes><p:cSld><p:spTree>` +
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>` +
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>진짜 메모</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:notes>`;
  eq(X.notesText(notes), "진짜 메모");
  const pptx = zipSync({
    "ppt/presentation.xml": strToU8(`<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships><Relationship Id="rId2" Type="x/slide" Target="/ppt/slides/slide1.xml"/></Relationships>`),
    "ppt/slides/slide1.xml": strToU8(`<p:sld><a:p><a:r><a:t>본문</a:t></a:r></a:p></p:sld>`),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(`<Relationships><Relationship Id="rId9" Type="http://x/relationships/notesSlide" Target="../notesSlides/notesSlide3.xml"/></Relationships>`),
    "ppt/notesSlides/notesSlide3.xml": strToU8(notes),
  });
  eq(X.extractPptx(pptx).pages, [{ number: 1, text: "본문", notes: "진짜 메모" }], "절대 경로·../ 상대 경로 모두 따라감");
});

Deno.test("extract.ts: 종류 판단", async () => {
  const pdf = await file("lecture.pdf"), docx = await file("meeting.docx"), pptx = await file("slides.pptx");
  eq([X.detectKind(pdf), X.detectKind(docx), X.detectKind(pptx)], ["PDF", "DOCX", "PPTX"], "형식·이름 없이 내용으로");
  eq(X.detectKind(docx, X.EXTRACT_MIME.PPTX), "PPTX", "형식을 믿되 (열 때 실패하면 UNSUPPORTED_TYPE)");
  eq([X.detectKind(strToU8("hello"), "application/pdf", "a.pdf"), X.detectKind(zipSync({ "a.txt": strToU8("x") }))], [null, null], "PDF라고 해도 내용이 아니면 거절");
});

// ---------------------------------------------------------------------
// 요청 처리
// ---------------------------------------------------------------------
Deno.test("handler.ts: 요청 처리·권한·한도", async (t) => {
  const TOKEN = "user-token";
  const lecture = await file("lecture.pdf");
  const assets = new Map<string, AssetMeta & { bytes?: Uint8Array }>([
    ["11111111-1111-4111-8111-111111111111", { purpose: "ATTACHMENT", bucket: "attachments", path: "w/1", mime: "application/pdf", name: "강의.pdf", sizeBytes: lecture.byteLength, bytes: lecture }],
    ["22222222-2222-4222-8222-222222222222", { purpose: "BACKUP", bucket: "backups", path: "u/2", mime: "application/octet-stream", name: null, sizeBytes: 10 }],
    ["33333333-3333-4333-8333-333333333333", { purpose: "ATTACHMENT", bucket: "attachments", path: "w/3", mime: "application/pdf", name: null, sizeBytes: 21 * 1024 * 1024 }],
    ["44444444-4444-4444-8444-444444444444", { purpose: "ATTACHMENT", bucket: "attachments", path: "w/4", mime: "application/pdf", name: null, sizeBytes: 10 }],
  ]);
  let downloads = 0;
  const logs: string[] = [];
  const h = createHandler({
    async getUserId(tok) { return tok === TOKEN ? "u1" : null; },
    async getAsset(tok, id) { return tok === TOKEN ? assets.get(id) ?? null : null; },
    async download(_tok, _b, path) {
      downloads++;
      if (path === "w/4") throw new Error("storage down");
      return [...assets.values()].find((a) => a.path === path)?.bytes ?? null;
    },
    log: (m) => logs.push(m),
  });
  const call = async (body: unknown, token: string | null = TOKEN, method = "POST") => {
    const res = await h(new Request("https://x/functions/v1/doc-extract", {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }));
    return { status: res.status, json: method === "OPTIONS" ? null : await res.json() };
  };

  await t.step("첨부(asset_id)로 PDF 읽기", async () => {
    const r = await call({ asset_id: "11111111-1111-4111-8111-111111111111" });
    eq([r.status, r.json.ok, r.json.kind, r.json.page_basis, r.json.total_pages, r.json.next_from_page, r.json.no_text], [200, true, "PDF", "PDF_PAGE", 3, null, false]);
    eq(r.json.pages.length, 3);
  });

  await t.step("기기 파일(file_base64)로 DOCX·PPTX 읽기", async () => {
    const d = await call({ file_base64: b64(await file("meeting.docx")), file_name: "회의.docx" });
    eq([d.status, d.json.kind, d.json.total_pages], [200, "DOCX", 2]);
    const p = await call({ file_base64: "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64," + b64(await file("slides.pptx")), notes: false });
    eq([p.status, p.json.kind, p.json.pages[1].notes], [200, "PPTX", undefined]);
  });

  await t.step("PDF 이어 읽기 (from_page, max_pages)", async () => {
    const big = b64(await file("big.pdf"));
    const r = await call({ file_base64: big, from_page: 51, max_pages: 5 });
    eq([r.status, r.json.from_page, r.json.pages.map((p: { number: number }) => p.number), r.json.next_from_page], [200, 51, [51, 52, 53, 54, 55], 56]);
    eq((await call({ file_base64: big, from_page: 100000 })).json.code, "PAGE_OUT_OF_RANGE");
  });

  await t.step("로그인·방식·형식 확인", async () => {
    eq((await call({ asset_id: "11111111-1111-4111-8111-111111111111" }, null)).status, 401);
    eq((await call({ asset_id: "11111111-1111-4111-8111-111111111111" }, "bad")).json.code, "AUTH_REQUIRED");
    eq((await call(null, TOKEN, "GET")).status, 405);
    eq((await call(null, TOKEN, "OPTIONS")).status, 200);
    eq((await call("{not json")).json.code, "INVALID_REQUEST");
    eq((await call({})).json.code, "INVALID_REQUEST", "둘 다 없음");
    eq((await call({ asset_id: "11111111-1111-4111-8111-111111111111", file_base64: "QQ==" })).json.code, "INVALID_REQUEST", "둘 다 있음");
    eq((await call({ asset_id: "nope" })).json.code, "INVALID_REQUEST");
    eq((await call({ file_base64: "***" })).json.code, "INVALID_REQUEST");
    eq((await call({ file_base64: b64(lecture), max_pages: 51 })).json.code, "INVALID_REQUEST", "한 번에 50쪽까지");
    eq((await call({ file_base64: b64(lecture), from_page: 0 })).json.code, "INVALID_REQUEST");
    eq((await call({ file_base64: b64(await file("meeting.docx")), from_page: 2 })).json.code, "INVALID_REQUEST", "from_page는 PDF만");
    eq((await call({ file_base64: b64(lecture), notes: "yes" })).json.code, "INVALID_REQUEST");
  });

  await t.step("권한 없는·없는 첨부, 백업, 큰 파일", async () => {
    const before = downloads;
    const missing = await call({ asset_id: "99999999-9999-4999-8999-999999999999" });
    eq([missing.status, missing.json.code], [404, "ASSET_NOT_FOUND"]);
    const backup = await call({ asset_id: "22222222-2222-4222-8222-222222222222" });
    eq([backup.status, backup.json.code], [415, "UNSUPPORTED_TYPE"], "암호화된 백업은 못 읽음");
    const big = await call({ asset_id: "33333333-3333-4333-8333-333333333333" });
    eq([big.status, big.json.code, big.json.max_bytes], [413, "TOO_LARGE", 20 * 1024 * 1024]);
    eq(downloads, before, "크기·종류가 안 맞으면 내려받지도 않음");
    const tooBigInline = await call({ file_base64: b64(new Uint8Array(X.EXTRACT_LIMITS.maxInlineBytes + 1)) });
    eq([tooBigInline.status, tooBigInline.json.code], [413, "TOO_LARGE"]);
  });

  await t.step("지원 안 하는 종류·암호·깨진 파일", async () => {
    eq((await call({ file_base64: b64(strToU8("그냥 글")), mime_type: "text/plain" })).json.code, "UNSUPPORTED_TYPE");
    const enc = await call({ file_base64: b64(await file("encrypted.pdf")) });
    eq([enc.status, enc.json.code], [422, "FILE_ENCRYPTED"]);
    const scan = await call({ file_base64: b64(await file("scanned.pdf")) });
    eq([scan.status, scan.json.no_text], [200, true], "스캔본은 성공 + no_text (앱이 사진 OCR 안내)");
  });

  await t.step("예상 못 한 오류는 내용 숨김", async () => {
    const r = await call({ asset_id: "44444444-4444-4444-8444-444444444444" });
    eq([r.status, r.json.code, r.json.message.includes("storage")], [500, "INTERNAL", false]);
    eq(logs, ["doc-extract failed"]);
  });
});
