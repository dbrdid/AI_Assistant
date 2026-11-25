export function projectTaskSection(task) {
  if (task?.kind === 'event') return 'events';
  if (task?.kind === 'task') return 'todos';
  return task?.start ? 'events' : 'todos';
}
