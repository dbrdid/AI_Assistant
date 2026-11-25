// 릴리스 목록에서 지금보다 높은 Atria APK 고르기 (AppUpdate.js와 테스트가 같이 씀)
const parts = v => String(v ?? '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
export const isNewer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** releases: GitHub API list. → { version, url } of the newest Atria-<version>.apk above current, or null. */
export function pickUpdate(releases, current) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.draft) continue;
    for (const asset of release?.assets ?? []) {
      const version = /^Atria-([\d.]+)\.apk$/.exec(asset?.name ?? '')?.[1];
      if (version && isNewer(version, best?.version ?? current)) best = { version, url: asset.browser_download_url };
    }
  }
  return best;
}
