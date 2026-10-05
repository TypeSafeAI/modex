import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReleaseFeed, publishedRelease, REFRESH_MS } from '../server/github-release.mjs';
import { releaseLinks, validRelease, isVersion } from '../shared/release.mjs';
import handler from '../../../api/release.js';

function fixture(version = '0.0.8', id = 8) {
  const links = releaseLinks(version);
  return { id, tag_name: `v${version}`, html_url: links.url, draft: false, prerelease: false,
    published_at: '2026-10-05T20:00:00Z', assets: [
      { id: id * 10, name: `Modex-${version}-arm64.dmg`, browser_download_url: links.downloadUrl, state: 'uploaded', size: 1024, download_count: 7 },
      { id: id * 10 + 1, name: `Modex-${version}-arm64.zip`, state: 'uploaded', download_count: 3 },
      { id: id * 10 + 2, name: 'SHA256SUMS.txt', state: 'uploaded', download_count: 999 },
    ] };
}
function upstream({ latest = fixture(), repo = { stargazers_count: 1234, forks_count: 12 }, pages = [[fixture()]] } = {}) {
  return async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://api.github.com');
    if (endpoint.pathname.endsWith('/latest')) return Response.json(latest);
    if (endpoint.pathname.endsWith('/releases')) return Response.json(pages[Number(endpoint.searchParams.get('page')) - 1] ?? []);
    assert.equal(endpoint.pathname, '/repos/TypeSafeAI/modex');
    return Response.json(repo);
  };
}

test('published installer, stars and all stable Mac installer counts form one snapshot', async () => {
  const beta = { ...fixture('0.0.9', 9), prerelease: true };
  const draft = { ...fixture('0.0.10', 10), draft: true };
  const feed = await createReleaseFeed({ fetchImpl: upstream({ pages: [[fixture(), fixture('0.0.7', 7), beta, draft]] }) })();
  assert.equal(feed.release.version, '0.0.8');
  assert.deepEqual(feed.stats, { stars: 1234, forks: 12, downloads: 20 });
  assert.equal(feed.stale, false);
  assert.ok(feed.checkedAt);
});

test('rejects drafts, prereleases, missing or incomplete installers, foreign links and rollback', () => {
  for (const change of [ { draft: true }, { prerelease: true }, { assets: [] }, { tag_name: 'v0.0.8-beta.1' },
    { html_url: 'https://example.com' }, { published_at: null } ]) {
    assert.equal(publishedRelease({ ...fixture(), ...change }, '0.0.7'), null);
  }
  for (const change of [{ state: 'new' }, { size: 0 }, { browser_download_url: 'https://example.com/install.dmg' }]) {
    const release = fixture(); Object.assign(release.assets[0], change);
    assert.equal(publishedRelease(release, '0.0.7'), null);
  }
  assert.equal(publishedRelease(fixture('0.0.6'), '0.0.7'), null);
  assert.ok(publishedRelease(fixture('0.0.10'), '0.0.9'));
});

test('client contract rejects untrusted URLs, invalid versions and partial updates', () => {
  const links = releaseLinks('0.0.8');
  assert.equal(validRelease(links, '0.0.7'), true);
  for (const value of [null, {}, { ...links, url: 'javascript:alert(1)' }, { ...links, downloadUrl: links.downloadUrl + '?redirect=1' },
    { ...links, version: '1e2.0.0' }, { ...links, version: '0.00.8' }, releaseLinks('0.0.6')]) assert.equal(validRelease(value, '0.0.7'), false);
  assert.equal(isVersion('999999999999999999999999.1.0'), false);
});

test('coalesces concurrent refreshes, caches, then discovers a newly published release without rebuilding', async () => {
  let time = 0; let calls = 0; let latest = fixture();
  const get = createReleaseFeed({ now: () => time, fetchImpl: (...args) => { calls++; return upstream({ latest })(...args); } });
  const results = await Promise.all([get(), get(), get()]);
  assert.equal(calls, 3); assert.deepEqual(results[0], results[2]);
  latest = fixture('0.0.9'); time = REFRESH_MS - 1;
  assert.equal((await get()).release.version, '0.0.8'); assert.equal(calls, 3);
  time++;
  assert.equal((await get()).release.version, '0.0.9'); assert.equal(calls, 6);
});

test('rate limits preserve last good links and counts, and cold failure has no fabricated counts', async () => {
  let time = 0; let unavailable = false;
  const fetchImpl = (...args) => unavailable ? Promise.resolve(new Response('', { status: 403 })) : upstream()(...args);
  const get = createReleaseFeed({ now: () => time, fetchImpl });
  const good = await get(); unavailable = true; time += REFRESH_MS;
  const stale = await get();
  assert.deepEqual(stale.release, good.release); assert.deepEqual(stale.stats, good.stats);
  assert.equal(stale.checkedAt, good.checkedAt); assert.equal(stale.stale, true);
  const cold = await createReleaseFeed({ fetchImpl })();
  assert.equal(cold.release.version, '0.0.7'); assert.deepEqual(cold.stats, { stars: null, forks: null, downloads: null });
  assert.equal(cold.checkedAt, null);
});

test('partial API failure still discovers a release without inventing statistics', async () => {
  const get = createReleaseFeed({ fetchImpl: (url, opts) => url.endsWith('/latest') ? upstream()(url, opts) : Promise.reject(new Error('offline')) });
  const feed = await get();
  assert.equal(feed.release.version, '0.0.8'); assert.equal(feed.stats.downloads, null); assert.equal(feed.stale, true);
});

test('paginates all releases and deduplicates assets across moving pages', async () => {
  const page = Array.from({ length: 100 }, (_, i) => fixture(`0.1.${i}`, i + 1));
  const feed = await createReleaseFeed({ fetchImpl: upstream({ pages: [page, [page[99], fixture('0.2.0', 101)]] }) })();
  assert.equal(feed.stats.downloads, 1010);
});

test('never publishes a partial total on failed or truncated pagination', async () => {
  const page = Array.from({ length: 100 }, (_, i) => fixture(`0.1.${i}`, i + 1));
  const feed = await createReleaseFeed({ fetchImpl: upstream({ pages: Array(10).fill(page) }) })();
  assert.equal(feed.stats.downloads, null); assert.equal(feed.stale, true);
  const failed = await createReleaseFeed({ fetchImpl: (url, opts) => url.includes('page=2') ? Promise.reject(new Error('offline')) : upstream({ pages: [page] })(url, opts) })();
  assert.equal(failed.stats.downloads, null);
});

test('valid zero counts are preserved; malformed counts are never displayed', async () => {
  const zero = await createReleaseFeed({ fetchImpl: upstream({ repo: { stargazers_count: 0, forks_count: 0 }, pages: [[]] }) })();
  assert.deepEqual(zero.stats, { stars: 0, forks: 0, downloads: 0 });
  const bad = fixture(); bad.assets[0].download_count = -1;
  const invalid = await createReleaseFeed({ fetchImpl: upstream({ repo: { stargazers_count: '99', forks_count: -1 }, pages: [[bad]] }) })();
  assert.deepEqual(invalid.stats, { stars: null, forks: null, downloads: null });
});

test('HTTP handler refuses mutations before querying GitHub', async () => {
  const headers = {}; let ended = false;
  const response = { setHeader(key, value) { headers[key] = value; }, end() { ended = true; } };
  await handler({ method: 'POST' }, response);
  assert.equal(response.statusCode, 405); assert.equal(headers.Allow, 'GET, HEAD'); assert.equal(ended, true);
});
