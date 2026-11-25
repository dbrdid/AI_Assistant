export const MAX_BLOCKS = 1000;
export function tableRows(rows = [['', ''], ['', '']]) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 50 || !Array.isArray(rows[0]) || rows[0].length < 1 || rows[0].length > 20) throw new Error('표는 1~50행, 1~20열로 작성해 주세요.');
  const columns = rows[0].length;
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== columns || row.some(cell => typeof cell !== 'string' || cell.length > 10000)) throw new Error('표의 셀 내용이 올바르지 않습니다.');
    return [...row];
  });
}
export function insertBlock(blocks, afterId, block, first = false) {
  if (blocks.length >= MAX_BLOCKS) throw new Error('블록은 1,000개까지 추가할 수 있습니다.');
  if (first) return [block, ...blocks];
  const index = afterId == null ? blocks.length - 1 : blocks.findIndex(item => item.id === afterId);
  if (index < 0 && blocks.length) throw new Error('삽입할 위치가 없습니다.');
  return [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)];
}
export function moveBlock(blocks, id, beforeId) {
  if (id === beforeId) return blocks;
  const block = blocks.find(item => item.id === id);
  if (!block || (beforeId != null && !blocks.some(item => item.id === beforeId))) throw new Error('이동할 블록이 없습니다.');
  const result = blocks.filter(item => item.id !== id);
  const index = beforeId == null ? result.length : result.findIndex(item => item.id === beforeId);
  result.splice(index, 0, block);
  return result;
}
// 입력 한 번으로 늘어난 줄바꿈 중 블록 경계가 될 곳. Enter(줄바꿈 한 글자)는 그 자리에서만 나누고,
// 붙여넣기는 빈 줄로 나뉜 문단마다 나누며 문단 안 줄바꿈은 블록 안에 둔다 (문장마다 블록이 생기지 않게). 나눌 곳이 없으면 null.
export function blockBreaks(before, after) {
  const prev = String(before).replace(/\r\n/g, '\n'), next = String(after).replace(/\r\n/g, '\n');
  if ((next.match(/\n/g)?.length ?? 0) <= (prev.match(/\n/g)?.length ?? 0)) return null;
  if (next.length === prev.length + 1) {
    let i = 0;
    while (i < prev.length && prev[i] === next[i]) i++;
    while (i > 0 && next[i - 1] === '\n') i--;
    if (next[i] === '\n') return [next.slice(0, i), next.slice(i + 1)];
  }
  const parts = next.split(/\n[ \t]*\n\s*/);
  return parts.length > 1 ? parts : null;
}

export function splitBlock(blocks, id, text, newId, parts) {
  const index = blocks.findIndex(item => item.id === id), current = blocks[index];
  if (!current || current.type === 'table') throw new Error('분할할 텍스트 블록이 없습니다.');
  const lines = parts ?? text.replace(/\r\n/g, '\n').split('\n');
  if (blocks.length + lines.length - 1 > MAX_BLOCKS) throw new Error('블록은 1,000개까지 추가할 수 있습니다.');
  const replacement = lines.map((line, offset) => ({ ...current, id: offset ? newId() : current.id, text: line, type: offset && current.type === 'heading' ? 'paragraph' : current.type, checked: offset ? false : current.checked }));
  return [...blocks.slice(0, index), ...replacement, ...blocks.slice(index + 1)];
}
