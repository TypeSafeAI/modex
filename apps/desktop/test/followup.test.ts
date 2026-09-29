import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, type RouteInput } from "../src/main/engine/routing/router.js";
import { JevError, type JevRequest, type JevTransport } from "../src/main/engine/routing/jev.js";
import { DEFAULT_ROUTING, type Thread } from "../src/shared/types.js";
import { tmpdir } from "./helpers.js";

const thread: Thread = { id: "t", projectId: "p", title: "Task", cwd: "/tmp/project", createdAt: "", updatedAt: "", backend: "codex", mode: "agent", model: "", plan: false, auto: true, status: "idle" };
const input = (): RouteInput => ({ thread, text: "Add a search component", project: { name: "project" }, items: [
  { id: "u", kind: "user", text: "Add a search component", at: "" },
  { id: "tool", kind: "tool", name: "apply_patch", title: "secret file content", args: { patch: "PRIVATE_PATCH" }, output: "PRIVATE_OUTPUT", status: "done", ok: true, at: "" },
  { id: "a", kind: "assistant", text: "PRIVATE_ASSISTANT_TEXT", at: "" },
] });

function router(transport: JevTransport | null = null): Router {
  return new Router({ home: tmpdir("followup"), policy: () => DEFAULT_ROUTING, listModels: async () => ({ models: [] }), transport });
}

function recommend(r: Router, value = input(), signal?: AbortSignal) {
  return r.followUp(value, signal);
}

test("follow-up: Jev selects the prompt using typed completion facts, never file contents", async () => {
  let sent: JevRequest | undefined;
  const r = router(async (request) => {
    sent = request;
    return { answers: { follow_up: { type: "choice", choice: "review", confidence: 0.9, probabilities: { review: 0.9 } } } };
  });
  const result = await recommend(r);
  assert.equal(result?.source, "jev");
  assert.match(result!.text, /review/i);
  assert.equal(sent!.questions.follow_up!.type, "choice");
  assert.equal(JSON.stringify(sent).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(sent).includes("secret file content"), false);
});

test("follow-up: offline and unavailable judges fall back to verification after edits", async () => {
  for (const transport of [null, async () => { throw new JevError("offline", "network"); }]) {
    const result = await recommend(router(transport));
    assert.equal(result?.source, "heuristic");
    assert.match(result!.text, /test|verif/i);
  }
});

test("follow-up: invalid or low-confidence choices cannot become prompt text", async () => {
  for (const answer of [
    { type: "choice" as const, choice: "delete everything", confidence: 1, probabilities: {} },
    { type: "choice" as const, choice: "review", confidence: 0.1, probabilities: {} },
    { type: "choice" as const, choice: "review", confidence: Number.NaN, probabilities: {} },
  ]) {
    const result = await recommend(router(async () => ({ answers: { follow_up: answer } })));
    assert.equal(result?.source, "heuristic");
    assert.match(result!.text, /test|verif/i);
  }
});

test("follow-up: Jev can decline to suggest another task", async () => {
  const result = await recommend(router(async () => ({ answers: { follow_up: { type: "choice", choice: "none", confidence: 0.95, probabilities: {} } } })));
  assert.equal(result, null);
});

test("follow-up: cancellation and an empty thread produce no suggestion", async () => {
  let calls = 0;
  const r = router(async () => { calls++; throw new Error("should not call"); });
  const controller = new AbortController();
  controller.abort();
  assert.equal(await recommend(r, input(), controller.signal), null);
  assert.equal(await recommend(r, { ...input(), items: [] }), null);
  assert.equal(calls, 0);
});

test("follow-up: Auto off keeps the request local even with Jev configured", async () => {
  let calls = 0;
  const r = router(async () => { calls++; throw new Error("should not call"); });
  const result = await recommend(r, { ...input(), thread: { ...thread, auto: false } });
  assert.equal(calls, 0);
  assert.equal(result?.source, "heuristic");
});
