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
export function splitBlock(blocks, id, text, newId) {
  const index = blocks.findIndex(item => item.id === id), current = blocks[index];
  if (!current || current.type === 'table') throw new Error('분할할 텍스트 블록이 없습니다.');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (blocks.length + lines.length - 1 > MAX_BLOCKS) throw new Error('블록은 1,000개까지 추가할 수 있습니다.');
  const replacement = lines.map((line, offset) => ({ ...current, id: offset ? newId() : current.id, text: line, type: offset && current.type === 'heading' ? 'paragraph' : current.type, checked: offset ? false : current.checked }));
  return [...blocks.slice(0, index), ...replacement, ...blocks.slice(index + 1)];
}
