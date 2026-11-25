// Builds dist/atria-bridge.exe (Windows, Node SEA via `node --build-sea`), dist/atria-bridge-<version>.tgz (npm pack) and SHA256SUMS.txt.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
const read = name => readFileSync(join(root, name), 'utf8');
const { version } = JSON.parse(read('package.json'));
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

if (process.platform === 'win32') {
  // A SEA main cannot import sibling files, so the two modules become one ESM script (no bundler needed).
  const core = read('bridge.mjs').replace(/^export const VERSION = .*$/m, `export const VERSION = ${JSON.stringify(version)};`);
  const cli = read('atria-bridge.mjs').replace(/^#!.*\n/, '').replace(/^import .* from '\.\/bridge\.mjs';\r?\n/m, '');
  if (cli.includes("from './bridge.mjs'") || !core.includes(`VERSION = ${JSON.stringify(version)};`)) throw new Error('번들 치환에 실패했습니다.');
  writeFileSync(join(dist, 'bundle.mjs'), core + '\n' + cli);
  writeFileSync(join(dist, 'sea.json'), JSON.stringify({ main: 'bundle.mjs', output: 'atria-bridge.exe', mainFormat: 'module', disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ['--build-sea', 'sea.json'], { cwd: dist, stdio: 'inherit' });
  rmSync(join(dist, 'bundle.mjs')); rmSync(join(dist, 'sea.json'));
} else {
  console.log('Windows 실행 파일은 Windows에서만 만듭니다. 이 플랫폼은 npm 패키지를 쓰세요.');
}
execSync('npm pack --pack-destination dist', { cwd: root, stdio: 'inherit' }); // fixed command, no user input

const sums = readdirSync(dist).sort().map(name => `${createHash('sha256').update(readFileSync(join(dist, name))).digest('hex')}  ${name}`);
writeFileSync(join(dist, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
