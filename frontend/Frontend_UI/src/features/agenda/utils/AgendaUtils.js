// 안건 비교 화면에서 쓰는 작은 도구들

// "2026-11-09" → "11.09"
export function shortDateKey(k) {
  return typeof k === 'string' && k.length >= 10 ? `${k.slice(5, 7)}.${k.slice(8, 10)}` : '';
}

// "2026-11-09" → "11월 9일"
export function longDateKey(k) {
  return typeof k === 'string' && k.length >= 10 ? `${Number(k.slice(5, 7))}월 ${Number(k.slice(8, 10))}일` : '';
}

// 이전/이후 글에서 "바뀐 부분"만 앞뒤 조금씩 남겨서 돌려줘요.
//   diffExcerpt('발표는 내가 맡기로', '발표는 지은이 맡기로') → { before:'…발표는 내가 맡…', after:'…발표는 지은이 맡…' }
export function diffExcerpt(a, b, ctx = 14) {
  const x = String(a || '');
  const y = String(b || '');
  let p = 0;
  const max = Math.min(x.length, y.length);
  while (p < max && x[p] === y[p]) p += 1;
  let s = 0;
  while (s < max - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s += 1;
  const cut = (str) => {
    const start = Math.max(0, p - ctx);
    const end = Math.min(str.length, str.length - s + ctx);
    return `${start > 0 ? '…' : ''}${str.slice(start, end)}${end < str.length ? '…' : ''}`;
  };
  return { before: cut(x), after: cut(y) };
}
