export const BLOCK_TYPES = [
  { id: 'text', label: '본문', prefix: '' },
  { id: 'heading', label: '소제목', prefix: '## ' },
  { id: 'bullet', label: '목록', prefix: '- ' },
  { id: 'todo', label: '체크리스트', prefix: '- [ ] ' },
];

export function readMemoBlocks(body) {
  return body.split('\n').map((line) => {
    if (/^- \[[ xX]\](?: |$)/.test(line)) {
      return { type: 'todo', text: line.slice(6), checked: line[3].toLowerCase() === 'x' };
    }
    const type = BLOCK_TYPES.find(({ prefix }) => prefix && (line.startsWith(prefix) || line === prefix.trimEnd()));
    return type ? { type: type.id, text: line.slice(type.prefix.length) } : { type: 'text', text: line };
  });
}

export function writeMemoBlocks(blocks) {
  return blocks.map(({ type, text, checked }) => {
    const prefix = type === 'todo' && checked ? '- [x] ' : BLOCK_TYPES.find(({ id }) => id === type).prefix;
    return prefix + text;
  }).join('\n');
}

export function splitEditedBlock(block, input) {
  const normalized = input.replace(/\r\n?/g, '\n');
  if (normalized === '\n' && !block.text.trim() && (block.type === 'bullet' || block.type === 'todo')) {
    return [{ type: 'text', text: '' }];
  }
  const [first, ...rest] = normalized.split('\n');
  if (!rest.length) return [{ ...block, text: first }];
  const continuation = block.type === 'bullet' || block.type === 'todo' ? block.type : 'text';
  return [
    { ...block, text: first },
    ...rest.map(line => {
      const [parsed] = readMemoBlocks(line);
      return parsed.type === 'text' ? { type: continuation, text: line } : parsed;
    }),
  ];
}
