import assert from 'node:assert/strict';
import test from 'node:test';
import { inAppScheduleReminderAt } from '../../frontend/Frontend_UI/src/services/notify/NotificationSchedule.mjs';

const at = (hour, minute = 0) => new Date(2026, 10, 23, hour, minute).getTime();

test('uses the daily briefing time for a timed schedule when it is before the schedule', () => {
  assert.equal(inAppScheduleReminderAt(at(14), at(9), false), at(9));
});

test('falls back to one hour before when no daily briefing time is configured', () => {
  assert.equal(inAppScheduleReminderAt(at(14), null, false), at(13));
});

test('falls back to one hour before when the briefing would be after the schedule', () => {
  assert.equal(inAppScheduleReminderAt(at(9), at(10), false), at(8));
});

test('uses the daily briefing time for an all-day schedule', () => {
  assert.equal(inAppScheduleReminderAt(at(9), at(8), true), at(8));
});
