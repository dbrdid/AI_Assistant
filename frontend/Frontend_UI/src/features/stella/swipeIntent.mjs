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
