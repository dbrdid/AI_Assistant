/**
 * AI 결과 피드백 (기기 전용). 사용자가 AI 답·명령을 받아들였는지·거절했는지·실행이 실패했는지 남겨 ai/eval 자료로 씀.
 *   surface: block (블록 AI 답 수용·거절) | command (AI 앱 명령 승인·취소·실패)
 *   서버로 보내지 않고 백업에도 넣지 않음. 공간마다 최근 KEEP개만 남김.
 */
import { fail } from './errors.js';

const SURFACES = new Set(['block', 'command']);
const DECISIONS = new Set(['accepted', 'rejected', 'failed']);
const KEEP = 500;
const MAX_TEXT = 4000;

const text = (value, field) => {
  if (value == null) return '';
  if (typeof value !== 'string') fail('invalid_input', field);
  return value.slice(0, MAX_TEXT);
};

export function recordAiFeedback(ctx, { surface, decision, request, output, detail } = {}) {
  if (!SURFACES.has(surface)) fail('invalid_input', 'surface');
  if (!DECISIONS.has(decision)) fail('invalid_input', 'decision');
  const ws = ctx.ws();
  ctx.db.runSync('insert into ai_feedback(workspace_id,surface,decision,request,output,detail,created_at) values(?,?,?,?,?,?,?)',
    [ws, surface, decision, text(request, 'request'), text(output, 'output'), text(detail, 'detail'), ctx.now()]);
  ctx.db.runSync('delete from ai_feedback where workspace_id=? and id not in (select id from ai_feedback where workspace_id=? order by id desc limit ?)', [ws, ws, KEEP]);
}

export function listAiFeedback(ctx) {
  return ctx.db.getAllSync('select surface,decision,request,output,detail,created_at as createdAt from ai_feedback where workspace_id=? order by id desc', [ctx.ws()]);
}
