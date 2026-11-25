// Derives EVIDENCE_THRESHOLD from the calibration set only: no clarify item may pass, then the fewest execute items are refused.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evidenceCoverage, routeCommand } from '../../frontend/Frontend_UI/src/features/stella/appCommands.mjs';

const file = new URL('s22-calibration.json', import.meta.url);

export function calibrate() {
  const raw = readFileSync(file);
  const { items } = JSON.parse(raw);
  const routed = items.filter(item => routeCommand(item.request).command);
  // Requests the rules resolve never reach the coverage gate, so they cannot inform its threshold.
  const scored = items.filter(item => !routed.includes(item)).map(item => ({ ...item, coverage: evidenceCoverage(item.request, item.value) }));
  const execute = scored.filter(item => item.expected === 'execute').map(item => item.coverage);
  const clarify = scored.filter(item => item.expected === 'clarify').map(item => item.coverage);
  const highestClarify = Math.max(...clarify), lowestExecute = Math.min(...execute);
  const above = execute.filter(value => value > highestClarify);
  // Midpoint of the safe gap, rounded up so that the highest clarify item stays refused.
  const threshold = above.length ? Math.ceil((highestClarify + Math.min(...above)) / 2 * 100) / 100 : null;
  return {
    sha256: createHash('sha256').update(raw).digest('hex'), items: items.length, execute: execute.length, clarify: clarify.length,
    routedByRules: routed.map(item => item.id), highestClarify, lowestExecute, threshold,
    unsafe: threshold == null ? null : clarify.filter(value => value >= threshold).length,
    refusedExecute: threshold == null ? null : scored.filter(item => item.expected === 'execute' && item.coverage < threshold).map(item => item.id),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) console.log(JSON.stringify(calibrate(), null, 2));
