import test from 'node:test';
import assert from 'node:assert/strict';
import { isVerticalDrag, pageStep, swipeIntent } from '../../frontend/Frontend_UI/src/features/stella/swipeIntent.mjs';
import { projectsInDragRange } from '../../frontend/Frontend_UI/src/features/project/projectDragSelection.mjs';

test('hold then swipe opens the tab bar; a plain sideways swipe changes page; vertical scroll is left alone', () => {
  assert.equal(swipeIntent({ heldMs: 500, movedEarly: false, dx: 20, dy: 3 }), 'tabs');
  assert.equal(swipeIntent({ heldMs: 500, movedEarly: true, dx: 80, dy: 3 }), 'page'); // 바로 밀기 시작했으면 쪽 이동
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 80, dy: 10 }), 'page');
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 20, dy: 90 }), null); // 세로 스크롤
  assert.equal(swipeIntent({ heldMs: 100, movedEarly: false, dx: 25, dy: 0 }), null);  // 아직 짧음
  assert.deepEqual([pageStep(-80), pageStep(80), pageStep(20)], [1, -1, 0]);           // 왼쪽으로 밀면 다음 쪽
});

test('a selected row or an established vertical drag cannot turn into tab navigation', () => {
  const hold = { heldMs: 500, movedEarly: false };
  assert.equal(swipeIntent({ ...hold, dx: 0, dy: 0 }), null);
  assert.equal(swipeIntent({ ...hold, dx: 18, dy: 60 }), null);
  assert.equal(swipeIntent({ ...hold, dx: 100, dy: 0, claimed: true }), null);
  assert.equal(swipeIntent({ ...hold, dx: 100, dy: 0, startedVertically: true }), null);
  assert.equal(isVerticalDrag({ dx: 6, dy: 18 }), true);
  assert.equal(isVerticalDrag({ dx: 18, dy: 6 }), false);
});

test('a project drag selects crossed rows and shrinks when the finger reverses', () => {
  const ids = ['first', 'second', 'third'];
  const layouts = new Map(ids.map((id, index) => [id, { y: index * 50, height: 40 }]));
  assert.deepEqual(projectsInDragRange(ids, layouts, 'first', 115), ids);
  assert.deepEqual(projectsInDragRange(ids, layouts, 'first', 60), ids.slice(0, 2));
  assert.deepEqual(projectsInDragRange(ids, layouts, 'third', 10), ids);
  assert.deepEqual(projectsInDragRange(ids, layouts, 'removed', 10), []);
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
