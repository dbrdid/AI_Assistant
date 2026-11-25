export const searchTerms = query => String(query ?? '').normalize('NFC').trim().split(/\s+/).filter(Boolean);

export function rankSearchRows(rows, terms) {
  const keywords = [...new Set(terms.map(term => term.toLowerCase()))];
  if (!keywords.length) return [];
  const phrase = terms.join(' ').toLowerCase();
  const matches = [];
  for (const row of rows) {
    const title = String(row.title ?? '').normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
    const text = String(row.text ?? '').normalize('NFC').toLowerCase();
    if (!keywords.every(keyword => title.includes(keyword) || text.includes(keyword))) continue;
    const titleMatches = keywords.filter(keyword => title.includes(keyword)).length;
    const rank = title === phrase ? 4 : title.startsWith(phrase) ? 3 :
      titleMatches === keywords.length ? 2 : titleMatches > 0 ? 1 : 0;
    matches.push({ row, rank, titleMatches });
  }
  return matches.sort((a, b) => b.rank - a.rank || b.titleMatches - a.titleMatches).map(({ row }) => row);
}

// 파일은 이름으로만 찾음: 본문에서 읽어 둔 글(text)은 검색 대상에 넣지 않고 종류만 넣음
export const fileSearchRow = file => ({ ...file, type: 'file', title: file.name, text: file.kind });
