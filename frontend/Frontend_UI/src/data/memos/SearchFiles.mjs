export function searchFilesByName(files, terms) {
  if (!Array.isArray(files) || !Array.isArray(terms) || terms.length === 0) return [];
  const needles = terms.map(term => String(term).toLowerCase()).filter(Boolean);
  if (!needles.length) return [];

  return files
    .filter(file => {
      const name = String(file?.name ?? file?.title ?? '').toLowerCase();
      return needles.every(term => name.includes(term));
    })
    .map(file => {
      const createdAt = Number(file.createdAt);
      const date = Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt) : null;
      return {
        id: file.id,
        type: 'file',
        title: file.name || file.title || '파일',
        date: date ? `${date.getMonth() + 1}/${date.getDate()}` : '',
        snippet: [file.kind, file.storage === 'cloud' ? '클라우드' : '기기'].filter(Boolean).join(' · '),
        text: '',
      };
    });
}
