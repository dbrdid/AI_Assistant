import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime } from '../../frontend/Frontend_UI/src/features/calendar/utils/relativeTime.mjs';

test('today events show time until start or time left', () => {
  const at = (h, m = 0) => h * 60 + m;
  assert.equal(relativeTime('15:00', '16:00', at(14, 30)), '30분 후');
  assert.equal(relativeTime('15:00', '16:00', at(13, 15)), '1시간 45분 후');
  assert.equal(relativeTime('15:00', '', at(12)), '3시간 후');
  assert.equal(relativeTime('15:00', '16:00', at(15, 40)), '진행 중, 20분 남음');
  assert.equal(relativeTime('15:00', '', at(15, 10)), '진행 중');
  assert.equal(relativeTime('15:00', '16:00', at(16, 1)), null);
  assert.equal(relativeTime('23:00', '', at(9)), null);
  assert.equal(relativeTime('', '', at(9)), null);
});
