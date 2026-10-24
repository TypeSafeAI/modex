import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SecretStore, noCipher, testCipher } from "../src/main/engine/secrets.js";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { tmpdir } from "./helpers.js";

/** LM-2 (#378): main-owned profiles; tokens live only in the encrypted secret store (AC3, AC6). */

function setup() {
  const home = tmpdir("modex-lm-");
  const secrets = new SecretStore(home, testCipher);
  return { home, secrets, store: new LocalConnectionStore(home, secrets) };
}

const TOKEN = "lm-token-SECRET-4242";

test("profiles persist without secrets; the renderer view says only whether a token is saved", () => {
  const { home, secrets, store } = setup();
  const a = store.create({ label: "Ollama", runtime: "ollama", url: "http://127.0.0.1:11434" });
  const b = store.create({ label: "LM Studio", runtime: "lmstudio", url: "http://localhost:1234/", token: TOKEN });
  assert.match(a.id, /^lc_[0-9a-f-]{36}$/);
  assert.notEqual(a.id, b.id);
  assert.deepEqual([a.revision, a.origin, a.basePath, a.credential.present], [1, "http://127.0.0.1:11434", "", false]);
  assert.deepEqual([b.origin, b.credential], ["http://localhost:1234", { present: true, storage: "test cipher (not secure)" }]);

  const file = path.join(home, "app", "local-connections.json");
  const everything = [fs.readFileSync(file, "utf8"), fs.readFileSync(secrets.file, "utf8"), JSON.stringify(store.list()), JSON.stringify(b)].join("\n");
  assert.equal(everything.includes(TOKEN), false, "no plaintext token on disk or in a view");
  assert.equal(everything.includes("4242"), false, "not even the last four characters");
  assert.equal(fs.existsSync(path.join(home, "app", "state.json")), false);

  const reopened = new LocalConnectionStore(home, secrets);
  assert.deepEqual(reopened.list().map(c => c.label), ["Ollama", "LM Studio"]);
  assert.equal(reopened.resolve({ id: b.id, revision: 1 })?.token, TOKEN, "main resolves the token for its own requests");
  assert.equal(reopened.resolve({ id: a.id, revision: 1 })?.token, null);
});

test("invalid input is refused before anything is written", () => {
  const { home, store } = setup();
  const bad: unknown[] = [
    { label: "x", runtime: "ollama", url: "http://10.0.0.1:11434" },
    { label: "x", runtime: "vllm-remote", url: "http://127.0.0.1:1" },
    { label: "", runtime: "ollama", url: "http://127.0.0.1:1" },
    { label: "a\u0000b", runtime: "ollama", url: "http://127.0.0.1:1" },
    { label: "x".repeat(81), runtime: "ollama", url: "http://127.0.0.1:1" },
    { label: "x", runtime: "ollama", url: "http://127.0.0.1:1/v1" },
    { label: "x", runtime: "ollama", url: "http://127.0.0.1:1", token: "a\r\nX-Injected: 1" },
    { label: "x", runtime: "ollama", url: "http://127.0.0.1:1", token: "has space" },
    { label: "x", runtime: "ollama", url: "http://127.0.0.1:1", token: "t".repeat(5000) },
    { label: "x", runtime: "responses", url: "http://127.0.0.1:1", manualModels: ["ok", "bad\nid"] },
    { label: "x", runtime: "responses", url: "http://127.0.0.1:1", manualModels: Array.from({ length: 51 }, (_, i) => `m${i}`) },
    { label: "x", runtime: "responses", url: "http://127.0.0.1:1", manualModels: ["   "] },
    { label: "x", runtime: "responses", url: "http://127.0.0.1:1", extra: true },
    null, "http://127.0.0.1:1",
  ];
  for (const input of bad) assert.throws(() => store.create(input as never), /./, JSON.stringify(input));
  assert.equal(fs.existsSync(path.join(home, "app", "local-connections.json")), false);
  const custom = store.create({ label: "vLLM", runtime: "responses", url: "http://[::1]:8000/v1", manualModels: ["Qwen/Qwen3 Coder:30B Q4", "Qwen/Qwen3 Coder:30B Q4", "org/m"] });
  assert.deepEqual([custom.basePath, custom.manualModels], ["/v1", ["Qwen/Qwen3 Coder:30B Q4", "org/m"]], "exact IDs kept, duplicates once");
});

test("a token is refused, not stored in plain text, when the OS keychain is unavailable", () => {
  const home = tmpdir("modex-lm-");
  const store = new LocalConnectionStore(home, new SecretStore(home, noCipher));
  assert.throws(() => store.create({ label: "x", runtime: "lmstudio", url: "http://127.0.0.1:1234", token: TOKEN }), err => !String(err).includes(TOKEN) && /keychain|encryption/i.test(String(err)));
  assert.deepEqual(store.list(), []);
  assert.equal(store.create({ label: "x", runtime: "lmstudio", url: "http://127.0.0.1:1234" }).credential.present, false);
});

test("edits bump the revision only when the target changes; stale edits are refused", () => {
  const { store } = setup();
  const c = store.create({ label: "LM", runtime: "lmstudio", url: "http://127.0.0.1:1234", token: TOKEN });
  const renamed = store.update(c.id, 1, { label: "LM Studio" });
  assert.equal(renamed.revision, 1, "a label is not part of the target");
  assert.throws(() => store.update(c.id, 0, { label: "y" }), /changed/);
  const rotated = store.update(c.id, 1, { token: "new-token" });
  assert.equal(rotated.revision, 2);
  assert.equal(store.resolve({ id: c.id, revision: 1 }), null, "an old revision never resolves to the new token");
  assert.equal(store.resolve({ id: c.id, revision: 2 })?.token, "new-token");
  const moved = store.update(c.id, 2, { url: "http://127.0.0.1:4321" });
  assert.deepEqual([moved.revision, moved.credential.present], [3, false], "a token is never carried to another address");
  assert.equal(store.resolve({ id: c.id, revision: 3 })?.token, null);
  const movedWithToken = store.update(c.id, 3, { url: "http://localhost:4321", token: "t2" });
  assert.deepEqual([movedWithToken.revision, movedWithToken.credential.present], [4, true]);
  assert.equal(store.update(c.id, 4, { token: null }).credential.present, false);
  assert.throws(() => store.update(c.id, 5, { runtime: "ollama", url: "http://10.1.1.1:1" }), /./);
  assert.equal(store.list()[0]!.revision, 5, "a refused edit changes nothing");
});

test("deletion clears the token, keeps readable provenance and never resolves or rebinds", () => {
  const { secrets, store } = setup();
  const c = store.create({ label: "LM", runtime: "lmstudio", url: "http://127.0.0.1:1234", token: TOKEN });
  assert.throws(() => store.delete(c.id, 2), /changed/);
  store.delete(c.id, 1);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(credentialKeys(secrets, c.id), [], "no token entry for the deleted connection remains");
  assert.equal(store.resolve({ id: c.id, revision: 1 }), null);
  assert.deepEqual(store.provenance(c.id), { label: "LM", runtime: "lmstudio", origin: "http://127.0.0.1:1234", deleted: true });
  const replacement = store.create({ label: "LM", runtime: "lmstudio", url: "http://127.0.0.1:1234" });
  assert.notEqual(replacement.id, c.id, "an identical replacement is a different connection");
  assert.equal(store.resolve({ id: c.id, revision: 1 }), null);
  assert.throws(() => store.update(c.id, 1, { label: "back" }), /no longer exists|not found/i);
  assert.equal(store.provenance("lc_unknown"), null);
});

test("a corrupt or foreign profiles file is ignored entry by entry, not trusted", () => {
  const { home, secrets } = setup();
  const file = path.join(home, "app", "local-connections.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, connections: [
    { id: "lc_00000000-0000-4000-8000-000000000001", label: "ok", runtime: "ollama", origin: "http://127.0.0.1:11434", basePath: "", revision: 3, manualModels: [], createdAt: "t", updatedAt: "t" },
    { id: "lc_00000000-0000-4000-8000-000000000002", label: "remote", runtime: "ollama", origin: "http://10.0.0.1:11434", basePath: "", revision: 1, manualModels: [], createdAt: "t", updatedAt: "t" },
    { id: "nope", label: "bad id", runtime: "ollama", origin: "http://127.0.0.1:1", basePath: "", revision: 1, manualModels: [], createdAt: "t", updatedAt: "t" },
  ] }));
  const store = new LocalConnectionStore(home, secrets);
  assert.deepEqual(store.list().map(c => [c.label, c.revision]), [["ok", 3]]);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new LocalConnectionStore(home, secrets).list(), []);
});

/** Every secret entry belonging to one connection, whatever its credential version. */
function credentialKeys(secrets: SecretStore, id: string): string[] {
  const entries = (JSON.parse(fs.readFileSync(secrets.file, "utf8")) as { entries: Record<string, unknown> }).entries;
  return Object.keys(entries).filter(k => k.startsWith(`local_connection:${id}`));
}

/** Fails only the profiles-file rename, the moment a new revision would become durable. */
function failProfileWrite(store: LocalConnectionStore): () => void {
  const original = fs.renameSync;
  const m = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === store.file) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
    return original(from, to);
  });
  return () => m.mock.restore();
}

test("a failed profile write never changes what an existing revision resolves", () => {
  const { secrets, store } = setup();
  const c = store.create({ label: "LM", runtime: "lmstudio", url: "http://127.0.0.1:1234", token: TOKEN });
  const ref = { id: c.id, revision: 1 };
  const attempts: [string, () => unknown][] = [
    ["rotation", () => store.update(c.id, 1, { token: "replacement-token" })],
    ["clear", () => store.update(c.id, 1, { token: null })],
    ["endpoint move", () => store.update(c.id, 1, { url: "http://127.0.0.1:4321" })],
    ["endpoint move with token", () => store.update(c.id, 1, { url: "http://localhost:4321", token: "moved-token" })],
    ["delete", () => store.delete(c.id, 1)],
  ];
  for (const [name, attempt] of attempts) {
    const restore = failProfileWrite(store);
    try { assert.throws(attempt, /EIO/, name); } finally { restore(); }
    const resolved = store.resolve(ref);
    assert.equal(resolved?.token, TOKEN, `${name}: revision 1 still resolves its own token`);
    assert.equal(resolved?.endpoint.origin, "http://127.0.0.1:1234", `${name}: and its own address`);
    assert.deepEqual(store.list().map(v => [v.revision, v.credential.present]), [[1, true]], `${name}: the view is unchanged`);
    assert.equal(credentialKeys(secrets, c.id).length, 1, `${name}: no orphaned token entry is left behind`);
  }
  // The same edits succeed once the disk recovers, and the old revision then stops resolving.
  const rotated = store.update(c.id, 1, { token: "replacement-token" });
  assert.equal(store.resolve(ref), null);
  assert.equal(store.resolve({ id: c.id, revision: rotated.revision })?.token, "replacement-token");
  assert.equal(credentialKeys(secrets, c.id).length, 1, "the superseded token entry is removed");
});

test("a failed create leaves neither a profile nor its token behind", () => {
  const { secrets, store } = setup();
  const restore = failProfileWrite(store);
  try { assert.throws(() => store.create({ label: "LM", runtime: "lmstudio", url: "http://127.0.0.1:1234", token: TOKEN }), /EIO/); } finally { restore(); }
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(secrets.file) ? credentialKeys(secrets, "").length : 0, 0);
});
