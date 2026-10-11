import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { redactSecrets, secretRanges } from "../src/shared/streamer-secrets.js";

test("escaped quotes, Markdown labels and YAML block secrets never leave a visible tail", () => {
  for (const [text, value] of [
    [String.raw`API_KEY="hello\"world"`, String.raw`"hello\"world"`],
    ["**password**: abcdef", "abcdef"],
    ["password: |\n  real-secret-value\n  second-line\npublic: hello", "real-secret-value"],
    ["password: >-\n  real-secret-value\n\npublic: hello", "real-secret-value"],
  ]) {
    const ranges = secretRanges(text!);
    const start = text!.indexOf(value!);
    assert.ok(ranges.some(([a, b]) => a <= start && b >= start + value!.length), text);
    assert.ok(!redactSecrets(text!).includes(value!), text);
  }
  assert.ok(redactSecrets("password: |\n  secret\npublic: hello").endsWith("public: hello"));
  assert.ok(redactSecrets("password: |\n  multiline-secret\npublic: hello").endsWith("public: hello"));
});

test("ranges identify raw UTF-16 offsets across Unicode without changing input", () => {
  const raw = "🔑 API_KEY=é秘密 another=public";
  const ranges = secretRanges(raw);
  assert.deepEqual(ranges.map(([a,b]) => raw.slice(a,b)), ["é秘密"]);
  assert.equal(raw, "🔑 API_KEY=é秘密 another=public");
});

test("redacts credentials while preserving normal workspace text", () => {
  for (const secret of ["sk-proj-abcdefgh123456", "ghp_abcdefgh123456", "violet-orchid-927"]) {
    assert.equal(redactSecrets(`password is ${secret}`), "password is [redacted]");
  }
  for (const text of ['{"api_key":"private-value"}', 'TOKEN=private-value', 'Authorization: Bearer private-value', 'https://user:private-value@example.com', '-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----']) {
    assert.ok(!redactSecrets(text).includes("private-value"), text);
  }
  assert.equal(redactSecrets("Build the React app in /Users/val/project; count=42"), "Build the React app in /Users/val/project; count=42");
});

test("redacts flags, partial streamed tokens, quoted values, and JSON headers", () => {
  const examples = [
    ["curl --api-key very-private", "very-private"],
    ['{"Authorization": "Bearer very-private"}', "very-private"],
    ['password="very private unfinished', "very private unfinished"],
    ["sk-proj-a", "sk-proj-a"],
    ["https://service.test/?access_token=very-private&count=42", "very-private"],
    ["-https://user:very-private@service.test", "very-private"],
    [".https://user:very-private@service.test", "very-private"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nvery-private", "very-private"],
  ];
  for (const [input, secret] of examples) assert.ok(!redactSecrets(input!).includes(secret!), input);
});

test("long unbroken terminal output does not stall secret matching", () => {
  const moduleUrl = new URL("../src/shared/streamer-secrets.js", import.meta.url).href;
  // Isolate the deadline so a regexp regression cannot hang the test runner.
  const script = `import { secretRanges } from ${JSON.stringify(moduleUrl)};
    for (const text of ["a".repeat(240_000), "a-".repeat(120_000), "*".repeat(240_000), String.fromCharCode(34).repeat(240_000), "token".repeat(48_000), "--" + "token".repeat(48_000)]) {
      if (secretRanges(text).length) throw new Error("public output was masked");
    }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 5_000 });
  assert.equal(redactSecrets("app_private_token=credential-value public=value"), "app_private_token=[redacted] public=value");
});
