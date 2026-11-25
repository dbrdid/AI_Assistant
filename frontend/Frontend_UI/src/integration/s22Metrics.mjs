// Allowlisted fields only: free text such as prompts, answers, titles and error messages cannot enter a record.
const NUMBERS = new Set(['ms', 'blocks', 'maxTokens', 'promptTokens', 'predicted', 'firstTokenMs', 'totalMs',
  'tokensPerSecond', 'promptMs', 'cachedTokens', 'availableBefore', 'availableAfter']);
const LABELS = { model: new Set(['Q4_K_M', 'Q5_K_M']), task: new Set(['command', 'general']),
  outcome: new Set(['ok', 'cancelled', 'limit', 'error']) };
const EVENTS = new Set(['document_open', 'block_edit', 'model_load', 'inference', 'cancel', 'approval_card']);
const MAX_EVENTS = 5000;

export function createRecorder(write, now = Date.now, schedule = setTimeout) {
  const events = [];
  let pending = false;
  function flush() {
    pending = false;
    try { write(JSON.stringify({ schema: 's22-metrics-v1', events })); } catch { /* Measurement must never affect the app. */ }
  }
  function record(name, fields = {}) {
    if (!EVENTS.has(name) || events.length >= MAX_EVENTS) return;
    const event = { name, at: now() };
    for (const [key, value] of Object.entries(fields)) {
      if ((NUMBERS.has(key) && Number.isFinite(value)) || (key === 'reload' && typeof value === 'boolean') || LABELS[key]?.has(value)) event[key] = value;
    }
    events.push(event);
    // Deferred so that file writes do not land inside the frame being measured.
    if (!pending) { pending = true; schedule(flush, 1000); }
  }
  return { record, flush, events };
}

export function p95(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
}
