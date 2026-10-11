import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("native launch eligibility requires a declared activation capability for regular Modex", { skip: process.platform !== "darwin" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "modex-launch-capability-"));
  try {
    const source = fileURLToPath(new URL("../../src/main/engine/desktop-system.m", import.meta.url));
    const wrapper = path.join(directory, "capability.m");
    const executable = path.join(directory, "capability");
    fs.writeFileSync(wrapper, `#define main modexDesktopSystemMain\n#include ${JSON.stringify(source)}\n#undef main\nint main(int argc, const char *argv[]) { @autoreleasepool { if (argc != 2) return 2; return supportsDesktopLaunch([NSURL fileURLWithPath:@(argv[1])]) ? 0 : 1; } }\n`);
    execFileSync("clang", ["-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror", "-framework", "AppKit", "-framework", "Security", wrapper, "-o", executable]);
    const regular = { CFBundleIdentifier: "ai.typesafe.modex" };
    const supported = { ...regular, ModexDesktopHostLaunchProtocol: 1, CFBundleURLTypes: [{ CFBundleURLSchemes: ["modex-host"] }] };
    const cases: [string, Record<string, unknown>, boolean][] = [
      ["legacy-preview", { CFBundleIdentifier: "works.jev.modex.host-preview" }, true],
      ["legacy-regular", regular, false],
      ["supported", supported, true],
      ["wrong-id", { ...supported, CFBundleIdentifier: "example.unrelated" }, false],
      ["future-version", { ...supported, ModexDesktopHostLaunchProtocol: 2 }, false],
      ["string-version", { ...supported, ModexDesktopHostLaunchProtocol: "1" }, false],
      ["missing-scheme", { ...supported, CFBundleURLTypes: [] }, false],
      ["wrong-scheme", { ...supported, CFBundleURLTypes: [{ CFBundleURLSchemes: ["https"] }] }, false],
      ["malformed-types", { ...supported, CFBundleURLTypes: "modex-host" }, false],
      ["malformed-entry", { ...supported, CFBundleURLTypes: ["modex-host"] }, false],
      ["malformed-schemes", { ...supported, CFBundleURLTypes: [{ CFBundleURLSchemes: "modex-host" }] }, false],
    ];
    for (const [name, info, eligible] of cases) {
      const bundle = path.join(directory, `${name}.app`);
      fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
      execFileSync("plutil", ["-convert", "xml1", "-o", path.join(bundle, "Contents", "Info.plist"), "-"], { input: JSON.stringify({ CFBundlePackageType: "APPL", CFBundleName: name, ...info }) });
      const result = spawnSync(executable, [bundle], { encoding: "utf8" });
      assert.equal(result.status, eligible ? 0 : 1, `${name}: ${result.stderr}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
