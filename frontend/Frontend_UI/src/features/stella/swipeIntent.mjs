// 탭 화면의 좌우 제스처 판별.
// 'tabs': 길게 누른 뒤 좌우로 밀기 → 이웃 탭
// 'page': 그냥 좌우로 밀기 → 같은 탭 안의 이웃 화면
export const HOLD_MS = 350;
export function swipeIntent({ heldMs, movedEarly, dx, dy }) {
  const horizontal = Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) * 2;
  if (!horizontal) return null;
  if (heldMs >= HOLD_MS && !movedEarly) return 'tabs';
  if (Math.abs(dx) > 30) return 'page';
  return null;
}
// 놓았을 때: 쪽 이동 방향 (-1 이전, 1 다음, 0 그대로)
export const pageStep = dx => (dx <= -60 ? 1 : dx >= 60 ? -1 : 0);
