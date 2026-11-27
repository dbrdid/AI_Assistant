import test from 'node:test';
import assert from 'node:assert/strict';
import { pageStep, swipeIntent } from '../../frontend/Frontend_UI/src/features/stella/swipeIntent.mjs';

test('a deliberate hold and horizontal swipe changes tabs; a plain sideways swipe changes page', () => {
  assert.equal(swipeIntent({ heldMs: 500, movedEarly: false, dx: 80, dy: 3 }), 'tabs');
  assert.equal(swipeIntent({ heldMs: 500, movedEarly: true, dx: 80, dy: 3 }), 'page'); // 바로 밀기 시작했으면 쪽 이동
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 80, dy: 10 }), 'page');
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 20, dy: 90 }), null); // 세로 스크롤
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 25, dy: 0 }), null);  // 아직 짧음
  assert.deepEqual([pageStep(-80), pageStep(80), pageStep(20)], [1, -1, 0]);           // 왼쪽으로 밀면 다음 쪽
});
