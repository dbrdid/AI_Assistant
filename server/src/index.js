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
  // Configuration and upstream errors may contain credentials. Do not print them.
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
