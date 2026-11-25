const HOUR_MS = 60 * 60 * 1000;

export function inAppScheduleReminderAt(eventAt, briefingAt, allDay) {
  if (Number.isFinite(briefingAt) && (allDay || briefingAt < eventAt)) return briefingAt;
  return eventAt - HOUR_MS;
}
