// 앱 모듈 recordings.ts ↔ 로컬 DB(진짜 SQL 함수·Storage 정책) ↔ 진짜 stt-worker (Deno)
//   가짜 Supabase 클라이언트: rpc → 로그인 사용자 역할로 SQL 함수, storage.upload → storage.objects(정책 적용) + 메모리
//   실행: ./reset.sh ../migrations/*.sql && deno test -A --no-check --config deno.test.json recordings_lib.test.ts
//   앱 모듈 경로(아래 import)는 저장소에 둔 위치에 맞게 고치세요 (지금: ../../../frontend/Frontend_UI/src/lib/stella)
import nodeAssert from "node:assert/strict";
import pg from "npm:pg@8";
import { createWorker } from "../functions/stt-worker/handler.ts";
import * as R from "../../../frontend/Frontend_UI/src/lib/stella/recordings.ts";

const PG = { host: "127.0.0.1", port: 54329, user: "postgres", database: "stella" };
const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
async function client() { const c = new pg.Client(PG); await c.connect(); return c; }

Deno.test("recordings.ts: 계획·등록·업로드(끊겼다 이어서)·서버 전사·진행 문구·재시도·전사문·ack·취소", async (t) => {
  const db = await client();
  const svc = await client(); await svc.query("set role service_role");
  const me = crypto.randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [me, `${me}@t.dev`]);
  await db.query(`insert into public.consents (account_id, consent_type, policy_version) values ($1, 'EXTERNAL_AI', 'v1')`, [me]);
  const secret = (await db.query(`select decrypted_secret from vault.decrypted_secrets where name = 'stt_cleanup_secret'`)).rows[0].decrypted_secret;

  const files = new Map<string, Uint8Array>();
  let failUploadAt = -1, uploads = 0;
  const asUser = async (sql: string, params: unknown[]) => {
    const c = await client();
    try {
      await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: me, role: "authenticated" })]);
      await c.query("set role authenticated");
      return await c.query(sql, params);
    } finally { await c.end(); }
  };
  const fake = {
    async rpc(fn: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      try {
        const r = await asUser(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
          keys.map((k) => (Array.isArray(args[k]) && typeof (args[k] as unknown[])[0] === "object") ? JSON.stringify(args[k]) : args[k]));
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, body: Uint8Array, o: { contentType: string; upsert: boolean }) {
            uploads++;
            if (uploads === failUploadAt) return { data: null, error: { message: "network lost" } };
            try {   // Storage가 하는 일: 정책 확인 후 객체 행 기록(크기 포함)
              await asUser(`insert into storage.objects (bucket_id, name, metadata) values ($1, $2, jsonb_build_object('size', $3::bigint, 'mimetype', $4::text))
                            on conflict (bucket_id, name) do update set metadata = excluded.metadata`, [bucket, path, body.byteLength, o.contentType]);
            } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
            files.set(path, new Uint8Array(body));
            return { data: { path }, error: null };
          },
        };
      },
    },
  } as any;

  const worker = createWorker({
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      try { return { data: (await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]))).rows[0].r, error: null }; }
      catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    openai: async (form) => {
      const tag = new Uint8Array(await (form.get("file") as Blob).arrayBuffer())[0];
      if (tag === 99) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ text: `구간 ${tag} 내용입니다.`, usage: { type: "duration", seconds: 290 } }), { status: 200 });
    },
    storage: {
      async download(_b, p) { return files.get(p) ?? null; },
      async remove(_b, ps) { for (const p of ps) { files.delete(p); await db.query(`delete from storage.objects where name = $1`, [p]); } },
    },
    configured: true, model: "gpt-transcribe", budgetMs: 10_000, callTimeoutMs: 2000,
  });
  const runWorker = async () => (await worker(new Request("https://x", { method: "POST", headers: { "x-cleanup-secret": secret } }))).json();

  try {
    await t.step("구간 계획·녹음 시간", async () => {
      eq(R.planSegments(10800).length, 90, "3시간 → 기본 2분 90개");
      eq(R.planSegments(10800, 60).length, 180, "1분 구간이면 180개 (서버 한도 200 안)");
      eq(R.planSegments(255).map((s) => s.durationSeconds), [120, 135], "마지막 15초는 앞 구간에 붙임");
      eq(R.planSegments(615, 300).map((s) => s.durationSeconds), [300, 315], "5분 구간도 설정 가능");
      eq(R.planSegments(640, 300).map((s) => [s.startSeconds, s.durationSeconds]), [[0, 300], [300, 300], [600, 40]]);
      eq([R.normalizeSegmentSeconds(90), R.normalizeSegmentSeconds(10), R.normalizeSegmentSeconds(3600), R.normalizeSegmentSeconds(NaN), R.normalizeSegmentSeconds(-5)],
         [120, 60, 900, 120, 120], "구간 길이는 1~15분, 분 단위 (90초 → 2분)");
      eq(R.planSegments(600, 90).length, 5, "90초 설정은 2분으로 맞춤");
      eq([R.segmentTimeLabel(0), R.segmentTimeLabel(720), R.segmentTimeLabel(3720)], ["[00:00]", "[12:00]", "[1:02:00]"]);
      const many = Array.from({ length: 201 }, (_, i) => ({ seq: i, durationSeconds: 50, sizeBytes: 10 }));
      const tooMany = await R.createRecording(fake, { recordingId: crypto.randomUUID(), segments: many }).then(() => null, (e) => e as R.RecordingError);
      eq([tooMany?.code, tooMany?.message], ["TOO_MANY_SEGMENTS", "구간이 너무 많아요 (200개까지)"], "201개는 서버에 보내기 전에 거절");
      eq([R.formatClock(3725), R.formatClock(65), R.shouldStopRecording(10800 * 1000), R.shouldStopRecording(10799 * 1000)], ["1:02:05", "01:05", true, false]);
    });

    const rec = crypto.randomUUID();
    // 구간 내용: 첫 바이트 = 구간 번호 + 1 (가짜 OpenAI가 글에 넣음). 셋째 구간은 99 → 400 오류
    const segBytes = (seq: number) => new Uint8Array(1500 + seq).fill(seq === 2 ? 99 : seq + 1);
    const plan = R.planSegments(4 * 300, 300);   // 5분 구간 4개 (아래 차감·시각 계산을 단순하게)
    const deletedLocal: number[] = [];

    await t.step("등록 → 업로드 도중 끊김 → 같은 녹음으로 이어서 (남은 구간만)", async () => {
      const created = await R.createRecording(fake, {
        recordingId: rec, keywords: ["정규화", "a<b"],
        segments: plan.map((s) => ({ seq: s.seq, durationSeconds: s.durationSeconds, sizeBytes: segBytes(s.seq).byteLength })),
      });
      eq([created.state, created.total, created.minutesNeeded, created.remainingMinutes, created.existing], ["UPLOADING", 4, 20, 60, false]);
      failUploadAt = 3;   // 세 번째 업로드에서 네트워크 끊김
      const err = await R.uploadRecordingSegments(fake, {
        recordingId: rec, readSegment: async (seq) => segBytes(seq), onSegmentConfirmed: (seq, i) => { if (!i.already) deletedLocal.push(seq); },
      }).then(() => null, (e) => e as R.RecordingError);
      eq(err?.code, "UPLOAD_FAILED");
      eq(deletedLocal, [0, 1], "확인된 구간만 기기에서 지움");
      const again = await R.createRecording(fake, { recordingId: rec, segments: plan.map((s) => ({ seq: s.seq, durationSeconds: s.durationSeconds, sizeBytes: segBytes(s.seq).byteLength })) });
      eq([again.existing, again.counts.pendingUpload], [true, 2], "앱을 다시 열어도 같은 녹음");
      const progress: number[] = [];
      const before = uploads;
      const r = await R.uploadRecordingSegments(fake, {
        recordingId: rec, readSegment: async (seq) => segBytes(seq),
        onSegmentConfirmed: (seq, i) => { if (!i.already) deletedLocal.push(seq); },
        onProgress: (p) => progress.push(p.uploaded),
      });
      eq([r.allUploaded, r.uploadedNow, uploads - before, deletedLocal, progress], [true, [2, 3], 2, [0, 1, 2, 3], [2, 3, 4]],
         "남은 2개만 올림 → 전부 확인되면 원본 삭제 가능");
      eq(R.recordingProgressText(r.status).lines, ["음성 변환 중 · 4개 중 0개 완료"]);
    });

    await t.step("서버 전사 → 진행 문구 → 실패 구간 재시도", async () => {
      const w = await runWorker();
      eq([w.done, w.failed], [3, 1], JSON.stringify(w));
      const st = await R.getRecordingStatus(fake, rec);
      eq([st.state, st.counts.done, st.counts.failed, st.chargedMinutes], ["NEEDS_RETRY", 3, 1, 15]);
      const txt = R.recordingProgressText(st, new Date());
      eq(txt.lines[0], "음성 변환 · 4개 중 3개 완료");
      nodeAssert.match(txt.lines[1], /^실패한 구간 1개 · 재시도 가능 \(.+까지\)$/);
      eq(txt.canRetry, true);
      eq(R.segmentErrorMessage(st.segments[2].errorCode), "음성을 읽지 못함");
      eq(await R.retryRecordingSegments(fake, rec, [2]), 1);
      const st2 = await R.getRecordingStatus(fake, rec);
      eq([st2.state, R.isRecordingSettled(st2.state)], ["PROCESSING", false]);
      await runWorker();   // 또 실패 (400) → FAILED
    });

    await t.step("전사문: 순서대로, 빠진 구간 표시 → (Terra 정리) → 저장 후 ack", async () => {
      const tr = await R.getRecordingTranscript(fake, rec);
      eq(tr.text, "[00:00] 구간 1 내용입니다.\n\n[05:00] 구간 2 내용입니다.\n\n[구간 3 (10:00~15:00) 변환 실패]\n\n[15:00] 구간 4 내용입니다.",
         "구간마다 녹음 시각 표시");
      eq(tr.plainText, "구간 1 내용입니다.\n\n구간 2 내용입니다.\n\n[구간 3 (10:00~15:00) 변환 실패]\n\n구간 4 내용입니다.");
      eq(tr.segments.map((s) => s.timeLabel), ["[00:00]", "[05:00]", "[10:00]", "[15:00]"]);
      eq([tr.complete, tr.missing.map((m) => m.seq)], [false, [2]]);
      eq(await R.ackRecordingTranscript(fake, rec), 3);
      eq((await R.getRecordingTranscript(fake, rec)).segments.filter((s) => s.text).length, 0, "ack 뒤엔 서버에 전사문 없음");
      eq([...files.keys()].filter((p) => p.includes(rec)).length, 1, "서버엔 실패 구간 음성 1개만 (3일 보관)");
    });

    await t.step("watchRecording: 끝난 상태면 한 번 알리고 멈춤", async () => {
      const seen: string[] = [];
      await new Promise<void>((resolve) => {
        R.watchRecording(fake, rec, { intervalMs: 10, onUpdate: (s) => { seen.push(s.state); resolve(); } });
      });
      await new Promise((r) => setTimeout(r, 50));
      eq(seen, ["NEEDS_RETRY"]);
    });

    await t.step("취소: 남은 처리 중단, 이후 업로드 거절, 오류 문구", async () => {
      await R.cancelRecording(fake, rec);
      eq((await R.getRecordingStatus(fake, rec)).state, "CANCELED");
      const e = await R.uploadRecordingSegments(fake, { recordingId: rec, readSegment: async () => new Uint8Array(1) }).catch((x) => x);
      eq([e.code, R.recordingErrorMessage(e)], ["CANCELED", "취소된 녹음이에요"]);
      const e2 = await R.createRecording(fake, { recordingId: crypto.randomUUID(), segments: [{ seq: 0, durationSeconds: 10900, sizeBytes: 10 }] }).catch((x) => x);
      eq(e2.code, "RECORDING_TOO_LONG", "앱에서 먼저 거름");
      const e3 = await R.createRecording(fake, { recordingId: crypto.randomUUID(), segments: [{ seq: 0, durationSeconds: 60, sizeBytes: 10, mimeType: "audio/aac" }] }).catch((x) => x);
      eq(e3.code, "UNSUPPORTED_TYPE", "서버 거절 코드 그대로");
    });
    console.log("recordings.ts ↔ SQL ↔ stt-worker 확인 통과");
  } finally {
    await db.end(); await svc.end();
  }
});
