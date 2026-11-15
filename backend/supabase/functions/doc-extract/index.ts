// =====================================================================
// 문서 글자 추출 (Supabase Edge Function `doc-extract`)
//   규칙 설명은 handler.ts 맨 위. PDF·DOCX·PPTX 해석은 extract.ts
//   첨부 읽기는 사용자 토큰으로 → assets·storage.objects RLS가 권한을 판단 (service_role로 읽지 않음)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { createHandler } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const userClient = (token: string) =>
  createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

Deno.serve(createHandler({
  async getUserId(token) {
    const { data, error } = await userClient(token).auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  async getAsset(token, assetId) {
    const { data, error } = await userClient(token).from("assets")
      .select("purpose, bucket_id, object_path, mime_type, original_name, actual_size_bytes, declared_size_bytes, status")
      .eq("id", assetId).maybeSingle();
    if (error || !data || data.status !== "AVAILABLE") return null;
    return {
      purpose: data.purpose, bucket: data.bucket_id, path: data.object_path, mime: data.mime_type,
      name: data.original_name ?? null, sizeBytes: Number(data.actual_size_bytes ?? data.declared_size_bytes),
    };
  },
  async download(token, bucket, path) {
    const { data, error } = await userClient(token).storage.from(bucket).download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  },
  log: (msg, extra) => console.error(msg, JSON.stringify(extra ?? {})),
}));
