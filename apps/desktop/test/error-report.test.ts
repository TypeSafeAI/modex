import { test } from "node:test";
import assert from "node:assert/strict";
import { appInfoLine, errorReport } from "../src/shared/error-report.js";

test("errorReport: where, when, the message verbatim and indented, and only the context that is set", () => {
  const report = errorReport({
    where: "Changes · diff",
    message: "Could not load diff: fatal: bad object\nsecond line",
    context: { threadId: "t1", path: "src/a.ts", original: undefined, empty: "", none: null },
    at: new Date("2026-10-17T12:00:00.000Z"),
  });
  assert.equal(report, [
    "Modex error: Changes · diff",
    "At: 2026-10-17T12:00:00.000Z",
    "",
    "Message:",
    "  Could not load diff: fatal: bad object",
    "  second line",
    "",
    "Context:",
    JSON.stringify({ threadId: "t1", path: "src/a.ts" }, null, 2),
  ].join("\n"));
});

test("errorReport: no context section when nothing is known, and a placeholder for an empty message", () => {
  const report = errorReport({ where: "Analytics", message: "   ", at: new Date(0) });
  assert.equal(report, "Modex error: Analytics\nAt: 1970-01-01T00:00:00.000Z\n\nMessage:\n  (no message)");
});

test("appInfoLine names the app build and platform for the copied report", () => {
  assert.equal(appInfoLine({ version: "0.1.0", electron: "44.4.5", platform: "darwin", arch: "arm64" }), "App: Modex 0.1.0 · Electron 44.4.5 · darwin arm64");
  assert.equal(appInfoLine({ version: "0.1.0", platform: "linux", arch: "x64" }), "App: Modex 0.1.0 · linux x64");
});
