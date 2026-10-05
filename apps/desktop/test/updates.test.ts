import test from "node:test";
import assert from "node:assert/strict";
import { ReleaseChecker, releaseUpdate } from "../src/main/engine/updates.js";

const release = (version = "0.0.7") => ({
  tag_name: `v${version}`, draft: false, prerelease: false, published_at: "2026-10-05T12:00:00Z",
  html_url: "https://untrusted.example/download", assets: [{ name: `Modex-${version}-arm64.dmg`, state: "uploaded", size: 1234 }],
});
const candidate = (value: unknown, current = "0.0.6", platform = "darwin", arch = "arm64") => releaseUpdate(value, current, platform, arch);

test("update comparison is numeric and the destination is owned by Modex", () => {
  assert.deepEqual(candidate(release()), { version: "0.0.7", url: "https://github.com/TypeSafeAI/modex/releases/tag/v0.0.7" });
  assert.equal(candidate(release("0.0.10"), "0.0.9")?.version, "0.0.10");
  assert.equal(candidate(release("1.0.0"), "0.99.99")?.version, "1.0.0");
  for (const version of ["0.0.6", "0.0.5", "0.0.7-beta.1", "0.0.7/evil", "00.0.7", "9007199254740992.0.0"]) assert.equal(candidate(release(version)), null, version);
  assert.equal(candidate(release(), "unversioned"), null);
});

test("only published stable releases with a usable installer for this Mac are offered", () => {
  for (const value of [null, {}, { ...release(), draft: true }, { ...release(), prerelease: true },
    { ...release(), published_at: null }, { ...release(), published_at: "invalid" },
    { ...release(), assets: [] }, { ...release(), assets: [{ name: "Modex-0.0.7-arm64.dmg", state: "new", size: 1234 }] },
    { ...release(), assets: [{ name: "Modex-0.0.7-arm64.dmg", state: "uploaded", size: 0 }] }]) assert.equal(candidate(value), null);
  assert.equal(candidate(release(), "0.0.6", "win32"), null);
  assert.equal(candidate(release(), "0.0.6", "darwin", "x64"), null);
});

test("release checks coalesce callers, use bounded fixed-origin requests and refresh after an hour", async () => {
  let calls = 0, now = 100;
  let finish!: (response: Response) => void;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/TypeSafeAI/modex/releases/latest");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(new Headers(options?.headers).has("Authorization"), false);
    return new Promise((resolve) => { finish = resolve; });
  };
  const checker = new ReleaseChecker({ currentVersion: "0.0.6", platform: "darwin", arch: "arm64", enabled: true, fetcher, now: () => now });
  const first = checker.check(), second = checker.check();
  assert.equal(first, second);
  finish(Response.json(release()));
  assert.equal((await first)?.version, "0.0.7");
  await checker.check(); assert.equal(calls, 1);
  now += 60 * 60 * 1000;
  const later = checker.check(); finish(Response.json(release("0.0.8")));
  assert.equal((await later)?.version, "0.0.8"); assert.equal(calls, 2);
});

test("offline and invalid responses remain quiet, retry later and preserve a known update", async () => {
  let now = 0, calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    if (calls === 2) return new Response("rate limited", { status: 403 });
    if (calls === 3) return new Response("not JSON");
    if (calls === 4) return Response.json(release());
    throw new Error("offline again");
  };
  const checker = new ReleaseChecker({ currentVersion: "0.0.6", platform: "darwin", arch: "arm64", enabled: true, fetcher, now: () => now });
  for (let i = 0; i < 3; i++) {
    assert.equal(await checker.check(), null);
    await checker.check(); assert.equal(calls, i + 1);
    now += 15 * 60 * 1000;
  }
  assert.equal((await checker.check())?.version, "0.0.7");
  now += 60 * 60 * 1000;
  assert.equal((await checker.check())?.version, "0.0.7");
});

test("development, demo and test mode can disable all update network requests", async () => {
  const checker = new ReleaseChecker({ currentVersion: "0.0.6", platform: "darwin", arch: "arm64", enabled: false,
    fetcher: async () => { assert.fail("No network request expected"); } });
  assert.equal(await checker.check(), null);
});
