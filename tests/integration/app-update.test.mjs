import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, pickUpdate } from '../../frontend/Frontend_UI/src/services/update/pickUpdate.mjs';

test('the app offers only a newer Atria APK, compared as numbers', () => {
  assert.ok(isNewer('0.0.10', '0.0.9'));
  assert.ok(!isNewer('0.0.1', '0.0.1'));
  const releases = [
    { tag_name: 'v0.0.3', draft: true, assets: [{ name: 'Atria-0.0.3.apk', browser_download_url: 'u3' }] },
    { tag_name: 'v0.0.2', assets: [{ name: 'atria-bridge.exe' }, { name: 'Atria-0.0.2.apk', browser_download_url: 'u2' }] },
    { tag_name: 'v0.0.1', assets: [{ name: 'Atria-0.0.1.apk', browser_download_url: 'u1' }] },
  ];
  assert.deepEqual(pickUpdate(releases, '0.0.1'), { version: '0.0.2', url: 'u2' });
  assert.equal(pickUpdate(releases, '0.0.2'), null);
  assert.equal(pickUpdate(null, '0.0.1'), null);
});
