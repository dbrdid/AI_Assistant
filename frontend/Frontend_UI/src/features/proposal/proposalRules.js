export function reviewReason(p, { findDuplicate, findOverlap }) {
  if (p.kind === 'memo') return null;
  if (!p.date) return '날짜를 정해 주세요';
  try {
    const duplicate = findDuplicate(p);
    if (duplicate) return `이미 있는 “${duplicate.title}”와 같아요`;
    const clash = p.start ? findOverlap(p) : null;
    if (clash) return `“${clash.title}”와 시간이 겹쳐요`;
  } catch {
    return '내용을 확인해 주세요';
  }
  return null;
}
