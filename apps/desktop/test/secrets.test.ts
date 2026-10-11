import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SecretStore, noCipher, testCipher, electronCipher } from "../src/main/engine/secrets.js";
import { tmpdir } from "./helpers.js";

test("secret store: encrypts at rest with 0600, describes without revealing, clears, and refuses without a cipher", () => {
  const home = tmpdir("modex-home-");
  const store = new SecretStore(home, testCipher);
  assert.equal(store.has("typesafe_api_key"), false);
  assert.deepEqual(store.describe("typesafe_api_key"), { present: false, backend: "test cipher (not secure)", last4: null, savedAt: null, isReference: false });
  store.set("typesafe_api_key", "  sk-live-abcdef1234  ");
  assert.equal(store.get("typesafe_api_key"), "sk-live-abcdef1234");
  const file = path.join(home, "app", "secrets.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes("sk-live-abcdef1234"), false, "plaintext never touches disk");
  assert.equal(fs.existsSync(path.join(home, "app", "state.json")), false, "nothing lands in state.json");
  const d = store.describe("typesafe_api_key");
  assert.deepEqual([d.present, d.last4, d.isReference, typeof d.savedAt], [true, "1234", false, "string"]);
  store.set("typesafe_api_key", "op://Development/Jev API Key/password");
  assert.equal(store.describe("typesafe_api_key").isReference, true);
  assert.equal(new SecretStore(home, testCipher).get("typesafe_api_key"), "op://Development/Jev API Key/password", "survives a restart");
  store.set("typesafe_api_key", "   ");
  assert.equal(store.has("typesafe_api_key"), false, "an empty value clears");
  store.set("typesafe_api_key", "k");
  store.clear("typesafe_api_key");
  assert.equal(store.get("typesafe_api_key"), null);
  const locked = new SecretStore(tmpdir("modex-home-"), noCipher);
  assert.throws(() => locked.set("typesafe_api_key", "k"), /no keychain encryption is unavailable/);
  assert.equal(locked.available(), false);
  // A blob written by another cipher cannot be read; that is a null key, not a crash.
  const other = new SecretStore(home, { name: "other", available: () => true, encrypt: (s) => Buffer.from(s), decrypt: () => { throw new Error("nope"); } });
  other.set("typesafe_api_key", "x");
  assert.equal(new SecretStore(home, testCipher).get("typesafe_api_key"), null);
});

test("electronCipher wraps safeStorage and names the platform store", () => {
  const calls: string[] = [];
  const fake = { isEncryptionAvailable: () => true, encryptString: (s: string) => { calls.push(`enc:${s}`); return Buffer.from(s.split("").reverse().join("")); }, decryptString: (b: Buffer) => { calls.push("dec"); return b.toString().split("").reverse().join(""); } };
  const mac = electronCipher(fake, "darwin");
  assert.equal(mac.name, "macOS Keychain");
  assert.equal(electronCipher(fake, "win32").name, "Windows DPAPI");
  assert.equal(electronCipher(fake, "linux").name, "OS keyring");
  assert.equal(mac.decrypt(mac.encrypt("abc")), "abc");
  assert.deepEqual(calls, ["enc:abc", "dec"]);
});

test("Linux secrets require a known encrypted OS keyring and never rewrite existing secrets on fallback", () => {
  let backend = "basic_text";
  let encryptions = 0;
  let decryptions = 0;
  const cipher = electronCipher({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: value => { encryptions++; return testCipher.encrypt(value); },
    decryptString: value => { decryptions++; return testCipher.decrypt(value); },
  }, "linux");
  const home = tmpdir("modex-linux-keyring-");
  const store = new SecretStore(home, cipher);
  assert.equal(store.available(), false);
  assert.throws(() => store.set("typesafe_api_key", "private"), /encryption is unavailable/);
  assert.equal(fs.existsSync(store.file), false);
  assert.throws(() => cipher.encrypt("private"), /keyring.*unavailable/i);
  assert.throws(() => cipher.decrypt(Buffer.from("private")), /keyring.*unavailable/i);
  assert.deepEqual([encryptions, decryptions], [0, 0]);
  for (const encrypted of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    backend = encrypted;
    assert.equal(store.available(), true);
    store.set("typesafe_api_key", "retained-private-key");
    assert.equal(store.get("typesafe_api_key"), "retained-private-key");
  }
  const saved = fs.readFileSync(store.file);
  for (const unavailable of ["basic_text", "unknown", "", "unrecognized_backend"]) {
    backend = unavailable;
    const before = [encryptions, decryptions];
    assert.equal(store.available(), false);
    assert.equal(store.get("typesafe_api_key"), null);
    assert.throws(() => store.set("typesafe_api_key", "replacement"), /encryption is unavailable/);
    assert.deepEqual([encryptions, decryptions], before);
    assert.deepEqual(fs.readFileSync(store.file), saved);
  }
});

test("Linux keyring discovery fails closed when absent or throwing, while Mac and Windows do not query it", () => {
  const base = { isEncryptionAvailable: () => true, encryptString: testCipher.encrypt, decryptString: testCipher.decrypt };
  assert.equal(electronCipher(base, "linux").available(), false);
  const throwing = { ...base, getSelectedStorageBackend: () => { throw new Error("not ready"); } };
  assert.equal(electronCipher(throwing, "linux").available(), false);
  for (const platform of ["darwin", "win32"] as const) {
    const cipher = electronCipher(throwing, platform);
    assert.equal(cipher.available(), true);
    assert.equal(cipher.decrypt(cipher.encrypt("secret")), "secret");
  }
});
