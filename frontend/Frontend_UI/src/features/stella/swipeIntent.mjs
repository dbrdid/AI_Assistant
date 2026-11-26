// 탭 화면의 좌우 제스처 판별.
// 'tabs': 길게 누른 채(HOLD_MS 동안 거의 안 움직임) 좌우로 밀기 → 세로 탭 막대
// 'page': 그냥 좌우로 밀기 → 같은 탭의 이웃 쪽(오늘, 개요, 빠른 입력 등)
export const HOLD_MS = 350;
export function swipeIntent({ heldMs, movedEarly, dx, dy }) {
  if (heldMs >= HOLD_MS && !movedEarly && Math.abs(dx) > 12) return 'tabs';
  if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) * 2) return 'page';
  return null;
}
// 놓았을 때: 쪽 이동 방향 (-1 이전, 1 다음, 0 그대로)
export const pageStep = dx => (dx <= -60 ? 1 : dx >= 60 ? -1 : 0);

// 메뉴 항목 고르기: 처음 좌우로 민 높이(anchor)가 지금 탭(start). 위아래로 row만큼 움직일 때마다 한 칸.
// 맨 위(아래) 항목을 넘어 더 밀면 anchor도 함께 옮겨, 되돌아올 때 바로 다음 항목이 잡힌다.
export function relativePick({ anchor, y, start, count, row }) {
  let raw = start + Math.round((y - anchor) / row);
  if (raw < 0) { anchor = y + start * row; raw = 0; }
  if (raw > count - 1) { anchor = y - (count - 1 - start) * row; raw = count - 1; }
  return { pick: raw, anchor };
}
