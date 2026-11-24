// ============================================================
// handwriting.js — 손글씨 획을 인증된 게이트웨이로 보내 글자로 인식
// ============================================================


import { handwritingForMemo } from '../../integration/runtime';
import { groupIntoLines, strokeBounds } from '../../features/memo/utils/InkUtils';

async function recognizeLines(lines, options) {
  const texts = await handwritingForMemo(lines, options?.sourceId, options?.signal);
  return texts.filter(Boolean).join('\n');
}

export async function recognizeHandwriting(strokes, width, height, language = 'ko', options = {}) {
  const texts = await handwritingForMemo([{ strokes, width, height, language }], options.sourceId, options.signal);
  return texts[0] ?? '';
}

// 여러 획(여러 줄일 수 있음)을 글자로 바꿈.
//  1) 획을 줄 단위로 나눔  2) 줄마다 왼쪽 위 모서리를 기준으로 좌표를 옮겨서 인식  3) 줄바꿈으로 이어 붙임
// 한 줄이라도 인식 요청이 실패하면 전체가 실패(throw)합니다 → 호출한 쪽이 필기를 지우지 않고 그대로 둘 수 있게.
export async function recognizeStrokes(strokes, options = {}) {
  const lines = groupIntoLines(strokes);
  const inputs = lines.map((lineStrokes) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      lineStrokes.forEach((s) => {
        const b = strokeBounds(s);
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
      });
      const pad = 10;
      const shifted = lineStrokes.map((s) => ({ p: s.p.map(([x, y]) => [x - minX + pad, y - minY + pad]) }));
      return { strokes: shifted, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2, language: 'ko' };
  });
  return recognizeLines(inputs, options);
}
