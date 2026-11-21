const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../..')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

// 웹의 expo-sqlite는 SQLite를 WebAssembly로 실행하므로 SharedArrayBuffer가 필요합니다.
// Metro에서 .wasm을 번들링하고 페이지를 교차 출처 격리(COOP/COEP)해야 합니다.
// 개발 서버에만 적용됩니다. 배포된 웹 빌드도 동일한 두 헤더를 직접 전송해야 합니다.
if (!config.resolver.assetExts.includes('wasm')) config.resolver.assetExts.push('wasm');
// Expo CLI는 Metro의 enhanceMiddleware보다 먼저 실행되는 매니페스트 미들웨어에서 HTML 페이지를 제공하므로,
// 이 개발 서버 프로세스의 모든 응답에 헤더를 설정합니다.
const http = require('node:http');
if (!http.ServerResponse.prototype.__coiPatched) {
  const writeHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function (...args) {
    if (!this.headersSent) {
      if (!this.hasHeader('Cross-Origin-Embedder-Policy')) this.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      if (!this.hasHeader('Cross-Origin-Opener-Policy')) this.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    }
    return writeHead.apply(this, args);
  };
  http.ServerResponse.prototype.__coiPatched = true;
}

module.exports = config;
