import test from 'node:test';
import assert from 'node:assert/strict';
import { pageStep, swipeIntent } from '../../frontend/Frontend_UI/src/features/stella/swipeIntent.mjs';

test('hold then swipe opens the tab bar; a plain sideways swipe changes page; vertical scroll is left alone', () => {
  assert.equal(swipeIntent({ heldMs: 500, movedEarly: false, dx: 20, dy: 3 }), 'tabs');
  assert.equal(swipeIntent({ heldMs: 500, movedEarly: true, dx: 80, dy: 3 }), 'page'); // 바로 밀기 시작했으면 쪽 이동
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 80, dy: 10 }), 'page');
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 20, dy: 90 }), null); // 세로 스크롤
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 25, dy: 0 }), null);  // 아직 짧음
  assert.deepEqual([pageStep(-80), pageStep(80), pageStep(20)], [1, -1, 0]);           // 왼쪽으로 밀면 다음 쪽
});

test('menu pick follows movement from the first swipe point and drags that point past the ends', async () => {
  const { relativePick } = await import('../../frontend/Frontend_UI/src/features/stella/swipeIntent.mjs');
  const at = (y, anchor = 500) => relativePick({ anchor, y, start: 1, count: 4, row: 56 });
  assert.deepEqual(at(500), { pick: 1, anchor: 500 });      // 시작점 = 지금 탭
  assert.equal(at(500 + 56).pick, 2);                       // 한 칸 아래
  assert.equal(at(500 - 56).pick, 0);                       // 한 칸 위
  const over = at(300);                                     // 맨 위를 넘어 더 올림
  assert.deepEqual(over, { pick: 0, anchor: 356 });         // 시작점이 위로 따라 옴
  assert.equal(at(300 + 56, over.anchor).pick, 1);          // 되돌아 내리면 바로 다음 칸
  assert.equal(at(900).pick, 3);                            // 맨 아래도 같은 방식
});
