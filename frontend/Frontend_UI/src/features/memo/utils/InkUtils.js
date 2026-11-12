// ============================================================
// inkUtils.js — 손글씨(펜) 계산 도구 모음
// ============================================================

// 점 목록 → SVG 경로 글자. 점 사이를 곡선으로 이어서 선이 각져 보이지 않게 합니다.
export function pointsToPath(p) {
  if (!p || p.length === 0) return '';
  const [x0, y0] = p[0];
  if (p.length === 1) return `M${x0} ${y0} L${x0 + 0.01} ${y0}`; // 점 하나 = 동그란 점
  let d = `M${x0} ${y0}`;
  // 각 점을 "조절점"으로, 다음 점과의 가운데를 "도착점"으로 삼아 이어 붙임
  for (let i = 1; i < p.length - 1; i += 1) {
    const mx = (p[i][0] + p[i + 1][0]) / 2;
    const my = (p[i][1] + p[i + 1][1]) / 2;
    d += ` Q${p[i][0]} ${p[i][1]} ${mx} ${my}`;
  }
  const last = p[p.length - 1];
  return `${d} L${last[0]} ${last[1]}`;
}

// 점(px,py) 과 선분(a→b) 사이의 가장 짧은 거리
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t)); // 선분 밖이면 끝점으로 고정
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 지우개(x, y, 반지름 r)가 이 획에 닿았나?
// 점이 듬성듬성해도 놓치지 않도록 "점"이 아니라 "점과 점 사이 선분"으로 검사합니다.
export function hitsStroke(stroke, x, y, r) {
  const reach = r + stroke.w / 2;
  const p = stroke.p;
  if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= reach;
  for (let i = 0; i < p.length - 1; i += 1) {
    if (distToSegment(x, y, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) <= reach) return true;
  }
  return false;
}

// 획마다 붙일 번호
let strokeSeq = 0;
export function newStrokeId() {
  strokeSeq += 1;
  return `s-${Date.now()}-${strokeSeq}`;
}

// ------------------------------------------------------------
// 손글씨 → 글자 변환용 도구
// ------------------------------------------------------------
// 획 하나를 감싸는 네모 { minX, minY, maxX, maxY }
export function strokeBounds(s) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  s.p.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  return { minX, minY, maxX, maxY };
}

// 선택한 네모 영역 {x1,y1,x2,y2} 안에 "중심"이 들어오는 획들만 골라냄
export function strokesInRect(strokes, r) {
  return strokes.filter((s) => {
    const b = strokeBounds(s);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2;
  });
}

// 획들을 "줄" 단위로 묶음 (위에서 아래로). 줄 안의 획은 왼쪽에서 오른쪽 순서.
// 같은 줄 판단: 획의 세로 중심이 현재 줄 높이 안에 있거나, 세로로 40% 이상 겹치면 같은 줄
export function groupIntoLines(strokes) {
  const items = strokes
    .map((s) => ({ s, b: strokeBounds(s) }))
    .sort((a, b) => a.b.minY + a.b.maxY - (b.b.minY + b.b.maxY));
  const lines = [];
  items.forEach((it) => {
    const last = lines[lines.length - 1];
    if (last) {
      const cy = (it.b.minY + it.b.maxY) / 2;
      const overlap = Math.min(last.bottom, it.b.maxY) - Math.max(last.top, it.b.minY);
      const minH = Math.max(1, Math.min(last.bottom - last.top, it.b.maxY - it.b.minY));
      if ((cy >= last.top && cy <= last.bottom) || overlap > 0.4 * minH) {
        last.items.push(it);
        last.top = Math.min(last.top, it.b.minY);
        last.bottom = Math.max(last.bottom, it.b.maxY);
        return;
      }
    }
    lines.push({ items: [it], top: it.b.minY, bottom: it.b.maxY });
  });
  return lines.map((ln) => ln.items.sort((a, b) => a.b.minX - b.b.minX).map((it) => it.s));
}
