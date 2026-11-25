// "내 서버의 로컬 LLM"(Ollama·LM Studio·Stella 브리지)은 같은 네트워크의 http 주소를 쓴다.
// 릴리스 빌드는 기본으로 http를 막으므로 사용자가 직접 입력한 서버 주소에 한해 쓰이도록 허용한다.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = config => withAndroidManifest(config, next => {
  next.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
  return next;
});
