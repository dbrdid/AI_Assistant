export function selectHomeScheduleEvents(events, nowHM) {
  const timed = events
    .filter((event) => event.kind === 'event' && event.start)
    .sort((a, b) => a.start.localeCompare(b.start));
  const active = timed.filter((event) => event.end && event.start <= nowHM && nowHM < event.end);
  const activeIds = new Set(active.map((event) => event.id));
  const upcoming = timed.filter((event) => !activeIds.has(event.id) && event.start >= nowHM);
  const nextStart = upcoming[0]?.start;
  const next = nextStart ? upcoming.filter((event) => event.start === nextStart) : [];

  return [
    ...active.map((event) => ({ event, state: 'ongoing' })),
    ...next.map((event) => ({ event, state: 'upcoming' })),
  ].sort((a, b) => a.event.start.localeCompare(b.event.start));
}
