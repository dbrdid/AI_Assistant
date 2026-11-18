const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../..')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

// expo-sqlite on web runs SQLite as WebAssembly and needs SharedArrayBuffer.
// Metro must bundle .wasm, and the page must be cross-origin isolated (COOP/COEP).
// Dev server only: a deployed web build must send the same two headers itself.
if (!config.resolver.assetExts.includes('wasm')) config.resolver.assetExts.push('wasm');
// Expo CLI serves the HTML page from its manifest middleware, which runs before Metro's
// enhanceMiddleware, so set the headers on every response of this dev-server process instead.
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
