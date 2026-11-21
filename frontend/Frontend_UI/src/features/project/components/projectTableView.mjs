export const DEFAULT_TABLE_VIEW = Object.freeze({ type: 'all', status: null, sortKey: 'title', descending: false, propertyFilter: null });
export const PROPERTY_TYPES = [
  { id: 'text', label: '텍스트' },
  { id: 'number', label: '숫자' },
  { id: 'checkbox', label: '체크박스' },
];

export function removeProjectProperty(settings, key) {
  const resetReferences = (view) => ({
    ...view,
    ...(view.sortKey === key ? { sortKey: 'title', descending: false } : {}),
    ...(view.propertyFilter?.key === key ? { propertyFilter: null } : {}),
  });
  const properties = Object.fromEntries(Object.entries(settings.properties ?? {}).flatMap(([rowKey, row]) => {
    const { [key]: removed, ...rest } = row;
    return Object.keys(rest).length ? [[rowKey, rest]] : [];
  }));
  return {
    ...settings,
    view: resetReferences(settings.view),
    saved: settings.saved.map(item => ({ ...item, view: resetReferences(item.view) })),
    fields: settings.fields.filter(field => field.key !== key),
    properties,
  };
}

export function parsePropertyValue(type, input) {
  const value = input.trim();
  if (!value) return null;
  if (type === 'text') return value.slice(0, 200);
  if (type === 'checkbox') return value === 'true' ? true : value === 'false' ? false : undefined;
  if (type === 'number' && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

export function projectTableRows(sections, view, properties = {}) {
  const propertyFilter = view.propertyFilter;
  const rows = sections
    .filter(section => view.type === 'all' || section.key === view.type)
    .flatMap(section => section.items.map(item => ({
      ...item,
      type: section.label,
      section,
      rowKey: `${section.kind ?? section.key}:${item.id}`,
    })))
    .filter(item => {
      if (view.status !== null && item.status !== view.status) return false;
      if (!propertyFilter) return true;
      const actual = properties[item.rowKey]?.[propertyFilter.key];
      const target = propertyFilter.value;
      if (typeof actual !== typeof target) return false;
      if (typeof target === 'number') return actual >= target;
      if (typeof target === 'string') return actual.normalize('NFC').toLowerCase().includes(target.normalize('NFC').toLowerCase());
      return actual === target;
    });
  return rows.sort((left, right) => {
    const value = row => view.sortKey.startsWith('property:') ? properties[row.rowKey]?.[view.sortKey] : row[view.sortKey];
    const a = value(left);
    const b = value(right);
    if (a == null || a === '') return b == null || b === '' ? 0 : 1;
    if (b == null || b === '') return -1;
    const order = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), 'ko', { numeric: true });
    return (view.descending ? -1 : 1) * order;
  });
}
