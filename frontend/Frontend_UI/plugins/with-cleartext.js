// 기본 네트워크 정책은 HTTPS만 허용(cleartextTrafficPermitted="false")한다.
// 로컬 LLM·개발 서버 접속용으로 localhost/에뮬레이터 및 mDNS·로컬 도메인(.local, .lan, .home.arpa)만
// network_security_config.xml로 제한 허용한다. (Android network-security-config는 CIDR IP 대역을 지원하지 않으므로
// 사설 IP 서버는 .local 호스트명, HTTPS 또는 암호화된 Atria 브리지 중계를 사용한다.)
const fs = require('node:fs');
const path = require('node:path');

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="true">local</domain>
    <domain includeSubdomains="true">lan</domain>
    <domain includeSubdomains="true">home.arpa</domain>
  </domain-config>
</network-security-config>
`;

function applyManifestPolicy(manifest) {
  const application = manifest.manifest.application[0];
  application.$['android:usesCleartextTraffic'] = 'false';
  application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
  return manifest;
}

const withCleartext = config => {
  const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
  const withManifest = withAndroidManifest(config, next => {
    applyManifestPolicy(next.modResults);
    return next;
  });
  return withDangerousMod(withManifest, ['android', async next => {
    const xmlDir = path.join(next.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(xmlDir, { recursive: true });
    fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), NETWORK_SECURITY_CONFIG_XML, 'utf8');
    return next;
  }]);
};

withCleartext.NETWORK_SECURITY_CONFIG_XML = NETWORK_SECURITY_CONFIG_XML;
withCleartext.applyManifestPolicy = applyManifestPolicy;

module.exports = withCleartext;
