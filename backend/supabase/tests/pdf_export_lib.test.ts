// 앱 pdf-export.ts — HTML 만들기·이스케이프·손글씨 SVG·Stella 데이터 구역·expo-print 호출·첨부 보관
//   실행: deno test -A --no-check --config deno.test.json pdf_export_lib.test.ts
//   실제 인쇄 확인: google-chrome(안드로이드 WebView와 같은 Chromium)으로 PDF를 만들고 doc-extract로 글자를 다시 읽음
//   (chrome이 없으면 그 단계만 건너뜀)
//   앱 모듈 경로(아래 import)는 저장소에 둔 위치에 맞게 고치세요 (지금: ../../../frontend/Frontend_UI/src/lib/stella)
import nodeAssert from "node:assert/strict";
import * as P from "../../../frontend/Frontend_UI/src/lib/stella/pdf-export.ts";
import { extractPdf, joinPages } from "../functions/doc-extract/extract.ts";

const eq = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepEqual(a, b, msg);
const has = (s: string, sub: string, msg?: string) => nodeAssert.ok(s.includes(sub), msg ?? `포함 안 됨: ${sub}`);
const hasNot = (s: string, sub: string, msg?: string) => nodeAssert.ok(!s.includes(sub), msg ?? `들어 있으면 안 됨: ${sub}`);

const STROKES = [
  { id: "a", c: "#1d4ed8", w: 3, p: [[10, 20], [110, 20], [110, 70]] as [number, number][] },
  { id: "b", c: "red\" onload=\"alert(1)", w: 2, p: [[60, 40]] as [number, number][] },
];

function sampleDoc(): P.PdfDocument {
  return {
    title: "스텔라 2주차 정리 <script>alert(1)</script>",
    subtitle: "DB 설계 & 동기화",
    meta: [["공간", "캡스톤 팀"]],
    sections: [
      P.notePdfSection({ title: "회의 메모", body: "결정: 구간은 2분\n다음 주: PDF 내보내기", strokes: STROKES, updated_at: "2026-11-15T05:30:00Z" }),
      P.tasksPdfSection([
        { title: "PDF 테스트", status: "DONE", due_at: "2026-11-16T09:00:00Z" },
        { title: "문서 추출 배포", status: "TODO", due_at: "2026-11-15T09:00:00Z", priority: 3, assignee_name: "병욱" },
        { title: "취소된 일", status: "CANCELED" },
      ]),
      P.eventsPdfSection([
        { title: "중간 발표", start_at: "2026-11-20T05:00:00Z", end_at: "2026-11-20T06:30:00Z", location: "공학관 301" },
        { title: "MT", start_at: "2026-11-21T00:00:00+09:00", end_at: "2026-11-22T00:00:00+09:00", all_day: true },
      ]),
      P.meetingPdfSection({ title: "정기 회의", starts_at: "2026-11-15T01:00:00Z", ends_at: "2026-11-15T02:00:00Z", status: "DONE" },
        [{ title: "구간 길이", status: "CLOSED", position: 2 }, { title: "PDF 범위", description: "메모·할 일·일정", status: "DISCUSSED", position: 1 }],
        { minutes: "PDF는 기기에서 만들기로 함", newPage: true }),
      P.transcriptPdfSection({ text: "[00:00] 오늘은 정규화를 다룹니다.\n\n[02:00] 1정규형부터 봅시다.\n\n[구간 3 (04:00~06:00) 변환 실패]" },
        { summary: "정규화 1~3정규형 설명" }),
    ],
  };
}

Deno.test("pdf-export.ts: 이스케이프·안전", () => {
  eq(P.escapeHtml(`<a href="x">'&'</a>\u0001`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  const html = P.renderPdfHtml(sampleDoc(), { generatedAt: new Date("2026-11-15T06:00:00Z") });
  hasNot(html, "<script>", "제목의 script가 그대로 들어가면 안 됨");
  has(html, "스텔라 2주차 정리 &lt;script&gt;alert(1)&lt;/script&gt;");
  hasNot(html, 'onload="alert(1)"', "획 색으로 속성 주입 못 함");
  has(html, 'fill="#000"', "이상한 색은 검정으로");
  const img = (src: string) => P.renderPdfHtml({ title: "t", sections: [{ blocks: [{ type: "image", src, caption: "c" }] }] });
  has(img("data:image/png;base64,iVBORw0KGgo="), '<img src="data:image/png;base64,iVBORw0KGgo="');
  has(img("file:///data/user/0/app/cache/a.jpg"), '<img src="file:///data/user/0/app/cache/a.jpg"');
  for (const bad of ["javascript:alert(1)", "https://evil.example/x.png", "data:text/html;base64,PHNjcmlwdD4=", 'file:///a.jpg" onerror="x']) {
    const h = img(bad);
    hasNot(h, "<img", `막아야 함: ${bad}`);
    has(h, "[그림을 넣을 수 없어요: c]");
  }
});

Deno.test("pdf-export.ts: 손글씨 SVG", () => {
  const svg = P.strokesToSvg(STROKES as never)!;
  // 상자: x 10~110, y 20~70, 여백 = 굵기/2 + 2 = 3.5
  has(svg, 'viewBox="6.5 16.5 107 57"');
  has(svg, 'width="107pt" height="57pt"', "작으면 그대로 (확대 안 함)");
  has(svg, '<path d="M10 20L110 20L110 70" fill="none" stroke="#1d4ed8" stroke-width="3"');
  has(svg, '<circle cx="60" cy="40" r="1" fill="#000"/>', "점 하나는 원");
  const big = P.strokesToSvg([{ id: "x", c: "black", w: 1, p: [[0, 0], [2000, 1000]] }], 500, 640)!;
  nodeAssert.match(big, /width="500pt" height="250\.\d+pt"/, "큰 그림은 폭에 맞춰 줄임");
  eq(P.strokesToSvg([]), null);
  eq(P.strokesToSvg([{ id: "n", c: "#000", w: 1, p: [[NaN, 1]] }]), null);
});

Deno.test("pdf-export.ts: 날짜", () => {
  eq(P.formatDateTime("2026-11-15T05:30:00Z"), "2026. 11. 15. (일) 14:30", "기본 서울 시간");
  eq(P.formatDateTime("2026-11-15T05:30:00Z", { timeZone: "America/New_York" }), "2026. 11. 15. (일) 00:30");
  eq(P.formatDateTime("2026-11-15T05:30:00Z", { allDay: true }), "2026. 11. 15. (일)");
  eq(P.formatRange("2026-11-20T05:00:00Z", "2026-11-20T06:30:00Z"), "2026. 11. 20. (금) 14:00 ~ 15:30");
  eq(P.formatRange("2026-11-20T14:00:00Z", "2026-11-20T16:00:00Z"), "2026. 11. 20. (금) 23:00 ~ 2026. 11. 21. (토) 01:00", "날짜가 바뀌면 둘 다");
  eq(P.formatRange("2026-11-21T00:00:00+09:00", "2026-11-23T00:00:00+09:00", { allDay: true }), "2026. 11. 21. (토) ~ 2026. 11. 23. (월)");
  eq([P.formatDateTime(null), P.formatDateTime("nope")], ["", "nope"]);
});

Deno.test("pdf-export.ts: Stella 데이터 → 구역", () => {
  const d = sampleDoc();
  const tasks = d.sections[1].blocks[0] as Extract<P.PdfBlock, { type: "checklist" }>;
  eq(tasks.items.map((i) => [i.text, i.done]), [["문서 추출 배포", false], ["PDF 테스트", true]], "안 끝난 일 먼저, 취소는 뺌");
  eq(tasks.items[0].note, "마감 2026. 11. 15. (일) 18:00 · 병욱 · 중요도 높음");
  const byDue = P.tasksPdfSection([{ title: "나중", due_at: "2026-12-01T00:00:00Z" }, { title: "마감 없음" }, { title: "먼저", due_at: "2026-11-20T00:00:00Z" }]);
  eq((byDue.blocks[0] as Extract<P.PdfBlock, { type: "checklist" }>).items.map((i) => i.text), ["먼저", "나중", "마감 없음"], "마감 빠른 순, 마감 없는 일은 뒤");
  const ev = d.sections[2].blocks[0] as Extract<P.PdfBlock, { type: "table" }>;
  eq(ev.rows, [
    ["2026. 11. 20. (금) 14:00 ~ 15:30", "중간 발표", "공학관 301", "할 일"],
    ["2026. 11. 21. (토) ~ 2026. 11. 22. (일) (하루 종일)", "MT", "", "할 일"],
  ]);
  const meeting = d.sections[3];
  eq(meeting.blocks[0], { type: "meta", items: [["일시", "2026. 11. 15. (일) 10:00 ~ 11:00"], ["상태", "끝남"]] });
  eq((meeting.blocks[2] as Extract<P.PdfBlock, { type: "table" }>).rows, [["1", "PDF 범위\n메모·할 일·일정", "논의함"], ["2", "구간 길이", "종료"]], "안건은 순서대로");
  const tr = d.sections[4];
  eq(tr.blocks.map((b) => b.type), ["heading", "quote", "heading", "paragraph", "paragraph", "paragraph"], "요약 → 전사문 구간마다 문단");
  const doc = P.documentTextPdfSection({ kind: "PPTX", pageBasis: "SLIDE", pages: [{ number: 1, text: "소개", notes: "인사" }, { number: 2, text: "" }] });
  eq(doc.blocks, [
    { type: "heading", text: "슬라이드 1", level: 3 }, { type: "paragraph", text: "소개" }, { type: "quote", text: "발표자 메모: 인사" },
    { type: "heading", text: "슬라이드 2", level: 3 }, { type: "paragraph", text: "(글자 없음)" },
  ]);
  eq(P.notePdfSection({ title: "  ", body: "" }).title, "제목 없는 메모");
  eq([P.pdfFileName('회의/정리: "최종"?'), P.pdfFileName("   "), P.pdfFileName("a", new Date(2026, 10, 5))], ["회의 정리 최종.pdf", "Stella 내보내기.pdf", "a 2026-11-05.pdf"]);
});

Deno.test("pdf-export.ts: exportPdf (expo-print 호출)", async () => {
  const calls: Parameters<P.PrintToFile>[0][] = [];
  const print: P.PrintToFile = async (o) => { calls.push(o); return { uri: "file:///cache/Print/abc.pdf", numberOfPages: 3 }; };
  const r = await P.exportPdf(sampleDoc(), { printToFileAsync: print });
  eq([r.uri, r.pages, r.fileName], ["file:///cache/Print/abc.pdf", 3, "스텔라 2주차 정리 script alert(1) script.pdf"]);
  eq([calls[0].width, calls[0].height, calls[0].margins], [595, 842, { left: 42, top: 42, right: 42, bottom: 42 }], "A4 pt, iOS용 여백");
  await P.exportPdf(sampleDoc(), { printToFileAsync: print }, { paper: "LETTER", landscape: true });
  eq([calls[1].width, calls[1].height], [792, 612], "가로면 폭·높이 바꿈");
  has(calls[1].html, "@page { size: letter landscape;");
  const err = (p: Promise<unknown>) => p.then(() => null, (e) => e as P.PdfExportError);
  eq((await err(P.exportPdf({ title: "", sections: [{ blocks: [] }] }, { printToFileAsync: print })))?.code, "INVALID_REQUEST");
  eq((await err(P.exportPdf({ title: "t", sections: [] }, { printToFileAsync: print })))?.message, "내보낼 내용을 골라 주세요");
  const failed = await err(P.exportPdf(sampleDoc(), { printToFileAsync: async () => { throw new Error("webview crashed"); } }));
  eq([failed?.code, failed?.message], ["PRINT_FAILED", "PDF를 만들지 못했어요. 다시 시도해 주세요"]);
});

Deno.test("pdf-export.ts: 공유 공간 첨부로 보관", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n...fake...");
  const sent: Record<string, unknown>[] = [];
  let uploaded: { path: string; type?: string } | null = null;
  const client = {
    functions: {
      async invoke(name: string, { body }: { body: Record<string, unknown> }) {
        sent.push({ name, ...body });
        if (name === "assets/prepare") return { data: { ok: true, status: "PENDING", asset_id: body.asset_id, bucket: "attachments", path: `w/${body.asset_id}`, token: "t", signed_url: "u", reused: false }, error: null };
        return { data: { ok: true, status: "AVAILABLE", asset: { id: body.asset_id, mime_type: "application/pdf", status: "AVAILABLE" } }, error: null };
      },
    },
    storage: { from: () => ({ async uploadToSignedUrl(path: string, _t: string, _b: Uint8Array, o: { contentType?: string }) { uploaded = { path, type: o.contentType }; return { error: null }; } }) },
  } as never;
  const asset = await P.savePdfAttachment(client, {
    workspaceId: "w1", assetId: "a1", uri: "file:///cache/x.pdf", title: "주간 보고", readFile: async () => pdf.buffer as ArrayBuffer,
  });
  eq(asset.id, "a1");
  eq(sent.map((s) => s.name), ["assets/prepare", "assets/complete"]);
  eq([sent[0].mime_type, sent[0].original_name, sent[0].purpose, sent[0].workspace_id, sent[0].size_bytes], ["application/pdf", "주간 보고.pdf", "ATTACHMENT", "w1", pdf.byteLength]);
  eq(uploaded, { path: "w/a1", type: "application/pdf" });
  const err = (p: Promise<unknown>) => p.then(() => null, (e) => e as P.PdfExportError);
  eq((await err(P.savePdfAttachment(client, { workspaceId: "", assetId: "a", uri: "u", title: "t", readFile: async () => pdf })))?.code, "INVALID_REQUEST", "개인 공간은 안 올림");
  eq((await err(P.savePdfAttachment(client, { workspaceId: "w", assetId: "a", uri: "u", title: "t", readFile: async () => new TextEncoder().encode("<html>") })))?.code, "NOT_PDF");
});

Deno.test({
  name: "pdf-export.ts: 실제 인쇄 (Chromium) → PDF → 글자 다시 읽기",
  ignore: !(await Deno.stat("/usr/bin/google-chrome").then(() => true, () => false)),
  async fn() {
    const dir = await Deno.makeTempDir();
    const print: P.PrintToFile = async ({ html }) => {
      // expo-print(안드로이드)는 WebView로 HTML을 그려 인쇄 → 같은 Chromium 엔진으로 흉내
      await Deno.writeTextFile(`${dir}/in.html`, html);
      const out = `${dir}/out.pdf`;
      const c = await new Deno.Command("google-chrome", {
        args: ["--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${out}`, `file://${dir}/in.html`],
        stdout: "null", stderr: "null",
        signal: AbortSignal.timeout(30_000),   // 막힌 경우(예: 알림 창) 테스트가 멈추지 않게
      }).output().catch(() => ({ success: false }));
      if (!c.success) throw new Error("chrome failed");
      return { uri: `file://${out}` };
    };
    const r = await P.exportPdf(sampleDoc(), { printToFileAsync: print }, { generatedAt: new Date("2026-11-15T06:00:00Z") });
    const bytes = await Deno.readFile(r.uri.replace("file://", ""));
    await Deno.writeFile("/tmp/stella_pdf_sample.pdf", bytes);
    eq(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");
    const x = await extractPdf(bytes);
    nodeAssert.ok(x.totalPages >= 2, "회의 구역은 새 쪽에서 시작 → 2쪽 이상");
    const text = joinPages(x.pageBasis, x.pages);
    for (const s of ["스텔라 2주차 정리 <script>alert(1)</script>", "결정: 구간은 2분", "문서 추출 배포", "공학관 301", "PDF 범위",
      "[02:00] 1정규형부터 봅시다.", "[구간 3 (04:00~06:00) 변환 실패]", "Stella에서 만든 문서", "2026. 11. 15. (일) 15:00"]) {
      has(text, s, `PDF 안에 "${s}"가 없음`);
    }
    // 회의는 새 쪽에서 시작
    const meetingPage = x.pages.find((p) => p.text.includes("정기 회의"))!;
    nodeAssert.ok(meetingPage.number >= 2 && meetingPage.text.trimStart().startsWith("정기 회의"), "회의 구역이 쪽 맨 위에서 시작");
  },
});
