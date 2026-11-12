import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test, type TestContext } from "node:test";
import { SecretStore, electronCipher, testCipher, type Cipher } from "../src/main/engine/secrets.js";

// Execute main's actual cipher assembly with the real disk store. Only the external
// OS encryption service is substituted; this is not native keychain qualification.
const source = fs.readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
const assembly = source.split(/\r?\n/).filter(line => /^const (secrets|osCipher) = /.test(line)).join("\n");

function fixture(t: TestContext, packaged: boolean, env: Record<string, string>, available = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-main-cipher-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let encryptions = 0;
  const context: Record<string, any> = {
    home, app: { isPackaged: packaged }, process: { env }, SecretStore, electronCipher, testCipher,
    safeStorage: {
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: () => { encryptions++; return Buffer.from("synthetic OS-wrapped bytes"); },
      decryptString: () => "SYNTHETIC-MAIN-CREDENTIAL",
    },
  };
  vm.runInNewContext(`${assembly}\nglobalThis.store = secrets; globalThis.cipher = osCipher;`, context);
  return { store: context.store as SecretStore, cipher: context.cipher as Cipher, encryptions: () => encryptions };
}

test("packaged main keeps credential writes on the OS cipher despite inherited E2E flags", t => {
  for (const env of [{}, { MODEX_E2E: "1" }, { MODEX_E2E: "0" }] as Record<string, string>[]) {
    const f = fixture(t, true, env);
    f.store.set("typesafe_api_key", "SYNTHETIC-MAIN-CREDENTIAL");
    f.cipher.encrypt("SYNTHETIC-OAUTH-CREDENTIAL");
    assert.equal(f.encryptions(), 2, "both credential consumers must reach OS encryption");
    const saved = JSON.parse(fs.readFileSync(f.store.file, "utf8"));
    assert.equal(Buffer.from(saved.entries.typesafe_api_key.enc, "base64").toString(), "synthetic OS-wrapped bytes");
    assert.equal(f.store.get("typesafe_api_key"), "SYNTHETIC-MAIN-CREDENTIAL");
  }
});

test("packaged main refuses credential persistence when OS encryption is unavailable, including E2E flags", t => {
  const f = fixture(t, true, { MODEX_E2E: "1" }, false);
  assert.throws(() => f.store.set("typesafe_api_key", "SYNTHETIC-MAIN-CREDENTIAL"), /encryption is unavailable/);
  assert.throws(() => f.cipher.encrypt("SYNTHETIC-OAUTH-CREDENTIAL"), /encryption is unavailable/);
  assert.equal(fs.existsSync(f.store.file), false);
  assert.equal(f.encryptions(), 0);
});

test("unpackaged E2E fixtures retain synthetic storage without using the OS keychain", t => {
  const f = fixture(t, false, { MODEX_E2E: "1" }, false);
  f.store.set("typesafe_api_key", "SYNTHETIC-MAIN-CREDENTIAL");
  assert.equal(f.store.get("typesafe_api_key"), "SYNTHETIC-MAIN-CREDENTIAL");
  assert.equal(f.cipher.decrypt(f.cipher.encrypt("SYNTHETIC-OAUTH-CREDENTIAL")), "SYNTHETIC-OAUTH-CREDENTIAL");
  assert.equal(f.encryptions(), 0);
});

test("ordinary unpackaged main also uses OS encryption", t => {
  const f = fixture(t, false, {});
  f.store.set("typesafe_api_key", "SYNTHETIC-MAIN-CREDENTIAL");
  assert.equal(f.encryptions(), 1);
});
