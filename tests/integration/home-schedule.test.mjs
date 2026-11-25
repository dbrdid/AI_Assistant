import assert from 'node:assert/strict';
import test from 'node:test';
import { selectHomeScheduleEvents } from '../../frontend/Frontend_UI/src/features/home/utils/HomeSchedule.mjs';

const event = (id, start, end = '') => ({ id, kind: 'event', start, end });

test('shows every active overlapping event and the nearest upcoming start time', () => {
  const rows = selectHomeScheduleEvents([
    event('past', '08:00', '09:00'),
    event('active-a', '09:00', '11:00'),
    event('active-b', '10:00', '12:00'),
    event('next-a', '11:00', '12:00'),
    event('next-b', '11:00', '13:00'),
    event('later', '14:00', '15:00'),
    event('untimed', ''),
  ], '10:30');

  assert.deepEqual(rows, [
    { event: event('active-a', '09:00', '11:00'), state: 'ongoing' },
    { event: event('active-b', '10:00', '12:00'), state: 'ongoing' },
    { event: event('next-a', '11:00', '12:00'), state: 'upcoming' },
    { event: event('next-b', '11:00', '13:00'), state: 'upcoming' },
  ]);
});

test('shows the nearest upcoming event when no event is currently active', () => {
  const rows = selectHomeScheduleEvents([
    event('early', '08:00', '09:00'),
    event('next', '10:00', '11:00'),
    event('later', '12:00', '13:00'),
  ], '09:30');

  assert.deepEqual(rows, [{ event: event('next', '10:00', '11:00'), state: 'upcoming' }]);
});
