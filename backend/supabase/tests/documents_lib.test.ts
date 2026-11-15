// 앱 documents.ts ↔ Edge Function doc-extract(handler.ts) 연결 확인
//   실행: deno test -A --no-check --config deno.test.json documents_lib.test.ts
//   앱 모듈 경로(아래 import)는 저장소에 둔 위치에 맞게 고치세요 (지금: ../../../frontend/Frontend_UI/src/lib/stella)
import nodeAssert from "node:assert/strict";
import { FunctionsFetchError, FunctionsHttpError } from "npm:@supabase/supabase-js@2";
import { createHandler } from "../functions/doc-extract/handler.ts";
import * as X from "../functions/doc-extract/extract.ts";
import * as D from "../../../frontend/Frontend_UI/src/lib/stella/documents.ts";

const eq = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepEqual(a, b, msg);
const DIR = new URL("./fixtures/docs/", import.meta.url);
const file = (n: string) => Deno.readFile(new URL(n, DIR));

Deno.test("documents.ts: 꺼내기·이어 읽기·오류 문구", async (t) => {
  const lecture = await file("lecture.pdf");
  const calls: Record<string, unknown>[] = [];
  let offline = false;
  const handler = createHandler({
    async getUserId(tok) { return tok === "tok" ? "u1" : null; },
    async getAsset(_tok, id) {
      return id === "11111111-1111-4111-8111-111111111111"
        ? { purpose: "ATTACHMENT", bucket: "attachments", path: "w/1", mime: "application/pdf", name: "a.pdf", sizeBytes: lecture.byteLength }
        : null;
    },
    async download() { return lecture; },
  });
  // supabase-js functions.invoke 흉내 (JSON 본문, 오류면 FunctionsHttpError)
  const client = {
    functions: {
      async invoke(name: string, { body }: { body: Record<string, unknown> }) {
        if (offline) return { data: null, error: new FunctionsFetchError(new Error("offline")) };
        calls.push(body);
        const res = await handler(new Request(`https://x/functions/v1/${name}`, {
          method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body),
        }));
        return res.ok ? { data: await res.json(), error: null } : { data: null, error: new FunctionsHttpError(res) };
      },
    },
  } as never;

  await t.step("base64는 서버 해석과 같음", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 1000]) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      eq(D.toBase64(b), btoa(String.fromCharCode(...b)), `길이 ${n}`);
    }
  });

  await t.step("첨부 PDF → 쪽 표시 넣은 글 (서버 joinPages와 같은 결과)", async () => {
    const r = await D.extractDocumentText(client, { assetId: "11111111-1111-4111-8111-111111111111" });
    eq([r.kind, r.totalPages, r.emptyPages, r.noText, r.truncated], ["PDF", 3, [2], false, false]);
    const server = await X.extractPdf(lecture);
    eq(r.text, X.joinPages(server.pageBasis, server.pages));
    eq(D.documentNoticeText(r), ["글자가 없는 쪽: 2쪽 (그림·스캔한 쪽이면 사진 글자 인식을 써 주세요)"]);
  });

  await t.step("긴 PDF: 50쪽씩 끝까지 이어 부르고 진행률", async () => {
    calls.length = 0;
    const big = await file("big.pdf");
    const progress: string[] = [];
    const r = await D.extractDocumentText(client, { bytes: big, mimeType: "application/pdf" }, { onProgress: (p) => progress.push(`${p.done}/${p.total}`) });
    const total = r.totalPages;
    eq(r.pages.map((p) => p.number), Array.from({ length: total }, (_, i) => i + 1), "빠짐·겹침 없이 전부");
    eq(calls.map((c) => c.from_page ?? 1), Array.from({ length: Math.ceil(total / 50) }, (_, i) => 1 + i * 50));
    eq(progress[0], `50/${total}`);
    eq(progress.at(-1), `${total}/${total}`);
    nodeAssert.ok(!r.truncated);
  });

  await t.step("maxPages에서 멈추면 truncated", async () => {
    calls.length = 0;
    const r = await D.extractDocumentText(client, { bytes: await file("big.pdf") }, { maxPages: 60 });
    eq([r.pages.length, r.truncated, calls.map((c) => c.max_pages)], [60, true, [50, 10]]);
    eq(D.documentNoticeText(r), ["문서가 길어서 앞부분만 가져왔어요"]);
  });

  await t.step("Word·PowerPoint (기기 파일)", async () => {
    const w = await D.extractDocumentText(client, { bytes: await file("meeting.docx"), fileName: "회의.docx" });
    eq([w.kind, w.pageBasis, w.text.split("\n")[0]], ["DOCX", "DOCX_EXPLICIT", "--- 약 1쪽 ---"]);
    eq(D.documentNoticeText(w), ["Word 문서의 쪽 번호는 대략이에요"]);
    const p = await D.extractDocumentText(client, { bytes: (await file("slides.pptx")).buffer as ArrayBuffer }, { notes: false });
    eq([p.kind, p.totalPages, p.pages.some((x) => x.notes)], ["PPTX", 3, false]);
    nodeAssert.ok(p.text.startsWith("--- 슬라이드 1 ---\n1장 소개"));
  });

  await t.step("스캔본 → noText 안내", async () => {
    const r = await D.extractDocumentText(client, { bytes: await file("scanned.pdf") });
    eq([r.noText, D.documentNoticeText(r)[0]], [true, "글자를 찾지 못했어요. 스캔한 문서라면 쪽을 사진으로 찍어 글자 인식을 써 주세요"]);
  });

  await t.step("오류: 서버 코드 → 한국어 문구", async () => {
    const err = (p: Promise<unknown>) => p.then(() => null, (e) => e as D.DocumentError);
    const enc = await err(D.extractDocumentText(client, { bytes: await file("encrypted.pdf") }));
    eq([enc?.code, enc?.status, enc?.message], ["FILE_ENCRYPTED", 422, "암호가 걸린 PDF는 읽을 수 없어요"]);
    const nf = await err(D.extractDocumentText(client, { assetId: "99999999-9999-4999-8999-999999999999" }));
    eq([nf?.code, nf?.message], ["ASSET_NOT_FOUND", "파일을 찾을 수 없거나 볼 권한이 없어요"]);
    const txt = await err(D.extractDocumentText(client, { bytes: new TextEncoder().encode("hello"), mimeType: "text/plain" }));
    eq(txt?.code, "UNSUPPORTED_TYPE");
    calls.length = 0;
    const big = await err(D.extractDocumentText(client, { bytes: new Uint8Array(D.DOCUMENT_LIMITS.maxInlineBytes + 1) }));
    eq([big?.code, big?.message, calls.length], ["TOO_LARGE", "10MB 넘는 파일은 공유 공간에 첨부로 올린 뒤 읽을 수 있어요", 0], "보내기 전에 거름");
    eq((await err(D.extractDocumentText(client, { bytes: new Uint8Array(0) })))?.code, "INVALID_REQUEST");
    offline = true;
    const net = await err(D.extractDocumentText(client, { bytes: lecture }));
    offline = false;
    eq([net?.code, D.documentErrorMessage(net)], ["NETWORK", "서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요"]);
    const stop = await err(D.extractDocumentText(client, { bytes: lecture }, { signal: { aborted: true } }));
    eq(stop?.code, "CANCELED");
  });

  await t.step("파일 고르기 미리 거르기", () => {
    eq([D.isExtractableDocument("application/pdf"), D.isExtractableDocument(null, "발표.PPTX"), D.isExtractableDocument("application/msword", "old.doc"),
        D.isExtractableDocument("image/png", "a.png")], [true, true, false, false]);
  });
});
