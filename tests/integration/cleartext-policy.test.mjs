import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const withCleartext = require('../../frontend/Frontend_UI/plugins/with-cleartext.js');

test('with-cleartext disables global cleartext HTTP and restricts exceptions to local domains', () => {
  const manifest = { manifest: { application: [{ $: { 'android:usesCleartextTraffic': 'true' } }] } };
  withCleartext.applyManifestPolicy(manifest);
  const appAttrs = manifest.manifest.application[0].$;
  assert.equal(appAttrs['android:usesCleartextTraffic'], 'false');
  assert.equal(appAttrs['android:networkSecurityConfig'], '@xml/network_security_config');

  const xml = withCleartext.NETWORK_SECURITY_CONFIG_XML;
  assert.match(xml, /<base-config\s+cleartextTrafficPermitted="false"\s*\/>/);
  assert.match(xml, /<domain\s+includeSubdomains="false">localhost<\/domain>/);
  assert.match(xml, /<domain\s+includeSubdomains="false">127\.0\.0\.1<\/domain>/);
  assert.match(xml, /<domain\s+includeSubdomains="false">10\.0\.2\.2<\/domain>/);
  assert.match(xml, /<domain\s+includeSubdomains="true">local<\/domain>/);
});
