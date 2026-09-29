import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTitle } from "../src/main/engine/titles.js";
import type { Backend } from "../src/main/engine/backends/types.js";

function backend(output: string, status: "completed" | "failed" = "completed"): Backend {
  return {
    id: "mock", listModels: async () => [], dispose: async () => {},
    async runTurn(prompt, opts, sink) {
      assert.match(prompt, /opening message/);
      assert.equal(opts.mode, "chat");
      assert.equal(opts.resume, undefined);
      assert.equal(await sink.approval({ question: "run tool?", canAlways: true }), "no");
      sink.delta("partial");
      sink.assistant(output);
      sink.session("title-session");
      return { status };
    },
  };
}

test("title generation uses an isolated chat turn and normalizes its final answer", async () => {
  assert.equal(await generateTitle(backend('"Fix login redirects"'), { model: "small" }, "please fix login", new AbortController().signal), "Fix login redirects");
});

test("invalid, failed and cancelled title generations keep the fallback", async () => {
  for (const output of ["", "line one\nline two", "x".repeat(100)]) {
    assert.equal(await generateTitle(backend(output), { model: "" }, "request", new AbortController().signal), null);
  }
  assert.equal(await generateTitle(backend("A title", "failed"), { model: "" }, "request", new AbortController().signal), null);
  const abort = new AbortController(); abort.abort();
  assert.equal(await generateTitle(backend("A title"), { model: "" }, "request", abort.signal), null);
});
