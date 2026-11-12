// ============================================================
// handwriting.js — 손글씨 → 글자 인식 (이 파일 하나만 바꾸면 인식 방식을 교체할 수 있음)
// ============================================================
// recognizeHandwriting(strokes, width, height) : 획 목록을 보내면 인식된 글자(문자열)를 돌려줌.
//   strokes : [{ p: [[x, y], ...] }, ...]   (inkUtils.js 의 획 모양)
//   width/height : 글씨를 쓴 영역의 크기(px)
//
// ★ 지금 방식: Google 의 손글씨 입력 서버(Input Tools)에 획 좌표를 보내서 인식합니다.
//   - 별도 가입/키가 필요 없지만 "공식 문서화된 API" 는 아니라서 언젠가 바뀌거나 막힐 수 있어요.
//   - 인터넷이 있어야 동작합니다. 쓴 획의 좌표가 Google 서버로 전송됩니다.
//   - 정식 서비스로 낼 때는 이 함수 안쪽만 "우리 서버 → 손글씨 인식(AI) 호출"로 바꾸면 됩니다.
//     (화면 쪽 코드는 그대로 두면 됨)

import { groupIntoLines, strokeBounds } from '../../features/memo/utils/InkUtils';

const ENDPOINT = 'https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8';
const TIMEOUT_MS = 8000;

export async function recognizeHandwriting(strokes, width, height, language = 'ko') {
  // 획마다 [x 목록, y 목록, 시간 목록] 형태로 바꿈 (시간은 점 순서대로 12ms 간격이라고 가정)
  const ink = strokes.map((s) => {
    const xs = [];
    const ys = [];
    const ts = [];
    s.p.forEach((pt, i) => {
      xs.push(Math.round(pt[0]));
      ys.push(Math.round(pt[1]));
      ts.push(i * 12);
    });
    return [xs, ys, ts];
  });

  const body = {
    options: 'enable_pre_space',
    requests: [
      {
        writing_guide: { writing_area_width: Math.round(width), writing_area_height: Math.round(height) },
        ink,
        language,
      },
    ],
  };

  // 일정 시간 안에 답이 없으면 실패로 처리
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const data = await res.json();
    // 성공 응답 모양: ["SUCCESS", [[ "요청번호", ["1순위 글자", "2순위 글자", ...] ]]]
    if (!Array.isArray(data) || data[0] !== 'SUCCESS') throw new Error('recognize failed');
    const candidates = data[1] && data[1][0] && data[1][0][1];
    return candidates && candidates.length > 0 ? String(candidates[0]).trim() : '';
  } finally {
    clearTimeout(timer);
  }
}

// 여러 획(여러 줄일 수 있음)을 글자로 바꿈.
//  1) 획을 줄 단위로 나눔  2) 줄마다 왼쪽 위 모서리를 기준으로 좌표를 옮겨서 인식  3) 줄바꿈으로 이어 붙임
// 한 줄이라도 인식 요청이 실패하면 전체가 실패(throw)합니다 → 호출한 쪽이 필기를 지우지 않고 그대로 둘 수 있게.
export async function recognizeStrokes(strokes) {
  const lines = groupIntoLines(strokes);
  const texts = await Promise.all(
    lines.map((lineStrokes) => {
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
      return recognizeHandwriting(shifted, maxX - minX + pad * 2, maxY - minY + pad * 2);
    }),
  );
  return texts.filter(Boolean).join('\n');
}
