const referenceLine = /^\[([^\]\n]+)\]\(memo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/i;

export function readMemoReference(line) {
  const match = referenceLine.exec(line.trim());
  return match ? { label: match[1], id: match[2].toLowerCase() } : null;
}

export function memoReferenceIds(body) {
  const ids = new Set();
  for (const line of body.split('\n')) {
    const reference = readMemoReference(line);
    if (reference) ids.add(reference.id);
  }
  return ids;
}

export function appendMemoReference(body, id, title) {
  if (memoReferenceIds(body).has(id.toLowerCase())) return body;
  const label = title.replace(/[\[\]\r\n]/g, ' ').trim() || '메모';
  return [body.trimEnd(), `[${label}](memo:${id})`].filter(Boolean).join('\n\n');
}

export function removeMemoReference(body, id) {
  const target = id.toLowerCase();
  const lines = body.split('\n');
  const remaining = lines.filter(line => readMemoReference(line)?.id !== target);
  return remaining.length === lines.length ? body : remaining.join('\n').replace(/(?:\n[ \t]*)+$/, '');
}
