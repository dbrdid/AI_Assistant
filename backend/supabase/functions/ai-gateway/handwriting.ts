export type HandwritingLine = {
  width: number;
  height: number;
  language: string;
  strokes: { p: [number, number][] }[];
};

const LANGUAGES = new Set(['ko', 'en', 'ja', 'zh']);
const MAX_LINES = 30;
const MAX_STROKES = 200;
const MAX_POINTS = 10_000;
const MAX_DIMENSION = 4096;

export function parseHandwritingLines(value: unknown): HandwritingLine[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINES) return null;
  let strokeCount = 0;
  let pointCount = 0;
  const lines: HandwritingLine[] = [];

  for (const rawLine of value) {
    if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) return null;
    const line = rawLine as Record<string, unknown>;
    const { width, height, language, strokes } = line;
    if (typeof width !== 'number' || !Number.isFinite(width) || width < 1 || width > MAX_DIMENSION
      || typeof height !== 'number' || !Number.isFinite(height) || height < 1 || height > MAX_DIMENSION
      || typeof language !== 'string' || !LANGUAGES.has(language)
      || !Array.isArray(strokes) || strokes.length === 0) return null;

    strokeCount += strokes.length;
    if (strokeCount > MAX_STROKES) return null;
    const parsedStrokes: HandwritingLine['strokes'] = [];
    for (const rawStroke of strokes) {
      if (!rawStroke || typeof rawStroke !== 'object' || Array.isArray(rawStroke)) return null;
      const points = (rawStroke as Record<string, unknown>).p;
      if (!Array.isArray(points) || points.length === 0) return null;
      pointCount += points.length;
      if (pointCount > MAX_POINTS) return null;

      const parsedPoints: [number, number][] = [];
      for (const point of points) {
        if (!Array.isArray(point) || point.length !== 2) return null;
        const [x, y] = point;
        if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > width
          || typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > height) return null;
        parsedPoints.push([Math.round(x), Math.round(y)]);
      }
      parsedStrokes.push({ p: parsedPoints });
    }

    lines.push({ width: Math.round(width), height: Math.round(height), language, strokes: parsedStrokes });
  }
  return lines;
}

export function toInputToolsBody(lines: HandwritingLine[]) {
  return {
    options: 'enable_pre_space',
    requests: lines.map(line => ({
      writing_guide: { writing_area_width: line.width, writing_area_height: line.height },
      ink: line.strokes.map(({ p }) => {
        const xs: number[] = [];
        const ys: number[] = [];
        const times: number[] = [];
        p.forEach(([x, y], i) => {
          xs.push(x);
          ys.push(y);
          times.push(i * 12);
        });
        return [xs, ys, times];
      }),
      language: line.language,
    })),
  };
}

export function parseInputToolsResponse(value: unknown, lineCount: number): string[] | null {
  if (!Array.isArray(value) || value[0] !== 'SUCCESS' || !Array.isArray(value[1]) || value[1].length !== lineCount) return null;
  const texts: string[] = [];
  for (const result of value[1]) {
    if (!Array.isArray(result) || !Array.isArray(result[1])) return null;
    const candidate = result[1][0];
    texts.push(typeof candidate === 'string' ? candidate.trim() : '');
  }
  return texts;
}
