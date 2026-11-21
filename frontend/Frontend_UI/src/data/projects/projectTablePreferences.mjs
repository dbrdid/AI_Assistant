export const projectViewKey = projectId => `project-items-view:${projectId}`;
export const projectTableKey = projectId => `project-table-settings:${projectId}`;

export function exportProjectTablePreferences(projects, read) {
  return projects.map(({ id }) => ({
    id,
    layout: read(projectViewKey(id), 'list'),
    table: read(projectTableKey(id), null),
  }));
}

export function prepareProjectTablePreferences(projects, snapshot) {
  if (snapshot === undefined) return [];
  if (!Array.isArray(snapshot)) throw new TypeError('Invalid project table preferences');
  const projectIds = new Set(projects.map(({ id }) => id));
  const entries = new Map();
  for (const entry of snapshot) {
    if (!entry || !projectIds.has(entry.id) || entries.has(entry.id) ||
        !['list', 'table', 'board'].includes(entry.layout) || !validTable(entry.table)) {
      throw new TypeError('Invalid project table preferences');
    }
    entries.set(entry.id, entry);
  }
  return projects.flatMap(({ id }) => [
    [projectViewKey(id), entries.get(id)?.layout ?? 'list'],
    [projectTableKey(id), entries.get(id)?.table ?? null],
  ]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTable(table) {
  if (table === null) return true;
  if (!isRecord(table) || !Array.isArray(table.saved)) return false;
  const fields = table.fields === undefined ? [] : table.fields;
  const properties = table.properties === undefined ? {} : table.properties;
  if (!Array.isArray(fields) || !isRecord(properties)) return false;
  const keys = new Set();
  for (const field of fields) {
    if (!isRecord(field) || typeof field.key !== 'string' || !field.key.startsWith('property:') ||
        typeof field.label !== 'string' || !field.label.trim() ||
        !['text', 'number', 'checkbox'].includes(field.type) || keys.has(field.key)) return false;
    keys.add(field.key);
  }
  const sortKeys = new Set(['title', 'type', 'status', 'date', ...keys]);
  const fieldTypes = new Map(fields.map(field => [field.key, field.type]));
  const validValue = (key, value) => {
    switch (fieldTypes.get(key)) {
      case 'text': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'checkbox': return typeof value === 'boolean';
      default: return false;
    }
  };
  const validFilter = filter => filter == null || (isRecord(filter) && validValue(filter.key, filter.value));
  const validView = view => isRecord(view) && ['all', 'memos', 'todos', 'events', 'files'].includes(view.type) &&
    (view.status === null || typeof view.status === 'string') && sortKeys.has(view.sortKey) &&
    typeof view.descending === 'boolean' && validFilter(view.propertyFilter);
  if (!validView(table.view) || !table.saved.every(entry => isRecord(entry) && typeof entry.name === 'string' && validView(entry.view))) return false;
  return Object.entries(properties).every(([rowKey, row]) =>
    /^(?:memos|tasks|files):.+$/.test(rowKey) && isRecord(row) &&
    Object.entries(row).every(([key, value]) => validValue(key, value)));
}
