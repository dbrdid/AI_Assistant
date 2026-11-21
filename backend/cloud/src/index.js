import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { OllamaProvider } from './ollama.js';

let app;
try {
  const config = loadConfig();
  app = buildApp({ config, provider: new OllamaProvider(config) });
  await app.listen({ host: config.host, port: config.port });
  console.info('AI API listening; request logging disabled.');
} catch {
  // 설정 및 상위 서비스 오류에 인증 정보가 포함될 수 있으므로 출력하지 않습니다.
  console.error('AI API startup failed. Check configuration and port availability.');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    const forcedExit = setTimeout(() => process.exit(1), 10000);
    forcedExit.unref();
    await app?.close();
    clearTimeout(forcedExit);
  });
}
