#!/usr/bin/env node
// Collects S22 system metrics over adb. Only parsed numbers are saved, never raw dumpsys text.
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const number = (text, pattern) => { const match = pattern.exec(text); return match ? Number(match[1]) : null; };
const parseColdStart = text => number(text, /TotalTime:\s*(\d+)/);
const parseBattery = text => {
  const tenths = number(text, /^\s*temperature:\s*(-?\d+)/m);
  return { level: number(text, /^\s*level:\s*(\d+)/m), temperatureC: tenths == null ? null : tenths / 10 };
};
const parseThermal = text => number(text, /Thermal Status:\s*(\d+)/);
const parsePssKb = text => number(text, /TOTAL PSS:\s*(\d+)/) ?? number(text, /^\s*TOTAL\s+(\d+)/m);
function parseFrames(text) {
  const total = number(text, /Total frames rendered:\s*(\d+)/);
  const janky = number(text, /Janky frames:\s*(\d+)/);
  const histogram = /HISTOGRAM:(.*)/.exec(text)?.[1] ?? '';
  const frozen = [...histogram.matchAll(/(\d+)ms=(\d+)/g)].reduce((sum, [, ms, count]) => sum + (Number(ms) >= 700 ? Number(count) : 0), 0);
  return { total, janky, slowPercent: total ? 100 * janky / total : null, frozenOver700ms: histogram ? frozen : null };
}
const parseExits = text => ({
  anr: (text.match(/reason=6\b/g) ?? []).length,
  crash: (text.match(/reason=(?:4|5)\b/g) ?? []).length,
  lowMemory: (text.match(/reason=3\b/g) ?? []).length,
});

function main([command, pkg, out, count = '30']) {
  if (!['cold-start', 'snapshot', 'reset-frames', 'pull'].includes(command) || !/^[A-Za-z][\w.]*$/.test(pkg ?? '') || (command !== 'reset-frames' && !out)) {
    console.error('usage: s22-collect.cjs <cold-start|snapshot|pull> <package> <outDir> [runs] | reset-frames <package>');
    process.exit(2);
  }
  const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const shell = (...args) => adb('shell', ...args);
  if (command === 'reset-frames') { shell('dumpsys', 'gfxinfo', pkg, 'reset'); return; }
  mkdirSync(out, { recursive: true });
  const save = (name, data) => writeFileSync(join(out, name + '-' + Date.now() + '.json'), JSON.stringify({
    schema: 's22-system-v1', device: shell('getprop', 'ro.product.model').trim(), build: shell('getprop', 'ro.build.display.id').trim(), ...data }, null, 2));
  if (command === 'cold-start') {
    const activity = shell('cmd', 'package', 'resolve-activity', '--brief', pkg).trim().split('\n').pop().trim();
    const runs = [];
    for (let i = 0; i < Number(count); i++) {
      shell('am', 'force-stop', pkg);
      runs.push(parseColdStart(shell('am', 'start', '-W', '-n', activity)));
    }
    save('cold-start', { displayedMs: runs });
  } else if (command === 'snapshot') {
    save('snapshot', { at: Date.now(), battery: parseBattery(shell('dumpsys', 'battery')), thermalStatus: parseThermal(shell('dumpsys', 'thermalservice')),
      pssKb: parsePssKb(shell('dumpsys', 'meminfo', pkg)), frames: parseFrames(shell('dumpsys', 'gfxinfo', pkg)),
      exits: parseExits(shell('dumpsys', 'activity', 'exit-info', pkg)) });
  } else {
    // run-as works only on debuggable builds, so release builds expose no metric files.
    const names = adb('exec-out', 'run-as', pkg, 'ls', 'files').split(/\s+/).filter(name => /^s22-metrics-\d+\.json$/.test(name));
    for (const name of names) writeFileSync(join(out, name), adb('exec-out', 'run-as', pkg, 'cat', 'files/' + name));
    console.log(names.length + ' files');
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { parseBattery, parseColdStart, parseExits, parseFrames, parsePssKb, parseThermal };
