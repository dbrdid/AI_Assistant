const { spawn } = require('node:child_process');
const path = require('node:path');
const cli = path.join(path.dirname(require.resolve('expo/package.json')), 'bin', 'cli');
// Isolated local SQLite and disabled Supabase/AI calls; normal npm start still requires real sign-in.
const child = spawn(process.execPath, [cli, 'start', '--host', 'localhost', '--port', process.env.STELLA_PREVIEW_PORT || '8098'], {
  cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
  env: { ...process.env, EXPO_PUBLIC_LOCAL_PREVIEW: '1', EXPO_OFFLINE: '1', CI: 'false' },
});
child.on('error', error => { console.error('미리보기 실행 실패:', error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
