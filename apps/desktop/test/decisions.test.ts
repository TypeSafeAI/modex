import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Router } from "../src/main/engine/routing/router.js";
import { QUESTION_SETS, ReceiptLog, type DecisionReceipt } from "../src/main/engine/routing/decisions.js";
import { QUESTION_SET_VERSION } from "../src/main/engine/routing/judge.js";
import { JevError, type JevResponse, type JevTransport } from "../src/main/engine/routing/jev.js";
import { decide } from "../src/main/engine/approvals/gate.js";
import { DEFAULT_APPROVAL_GATE, DEFAULT_ROUTING, type ApprovalRule, type ModelInfo, type Thread } from "../src/shared/types.js";
import { tmpdir } from "./helpers.js";

const thread = (over: Partial<Thread> = {}): Thread => ({ id: "th1", projectId: "p", title: "t", createdAt: "", updatedAt: "", cwd: "/w", backend: "codex", mode: "agent", plan: false, model: "gpt-6-astra", effort: "high", status: "idle", auto: true, ...over });
const listModels = async () => ({ models: [{ id: "gpt-6-astra", label: "gpt-6-astra", efforts: ["low", "medium", "high"], isDefault: true } as ModelInfo] });
const routing: JevResponse = { answers: {
  task: { type: "choice", choice: "small_edit", probabilities: { small_edit: 0.9 }, confidence: 0.9 },
  complexity: { type: "score", score: 0.4, probabilities: {}, confidence: 0.8 },
  blast_radius: { type: "score", score: 0.1, probabilities: {}, confidence: 0.9 },
  wants_speed: { type: "noul", noul: 0.2 },
  needs_deep_reasoning: { type: "noul", noul: 0.1 },
} };
const receipts = (home: string): DecisionReceipt[] => {
  const file = path.join(home, "app", "decisions.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as DecisionReceipt) : [];
};

test("each question set has a version, and routing status still reports the routing set's", async () => {
  assert.deepEqual(QUESTION_SETS, { routing: 1, follow_up: 1, approval: 1 });
  assert.equal(QUESTION_SETS.routing, QUESTION_SET_VERSION);
  const router = new Router({ home: tmpdir("modex-decisions-"), policy: () => DEFAULT_ROUTING, listModels, transport: null });
  assert.equal((await router.status()).questionSetVersion, QUESTION_SETS.routing);
});

test("a routing judgment leaves a receipt with its set, version and typed answers, and never the request", async () => {
  const home = tmpdir("modex-decisions-");
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => routing });
  const secret = "rename the SECRET_TOKEN_VALUE helper";
  const route = await router.route({ thread: thread(), text: secret, items: [], project: { name: "demo" } });
  assert.equal(route.source, "jev");
  const [receipt, ...rest] = receipts(home);
  assert.equal(rest.length, 0);
  assert.partialDeepStrictEqual(receipt, { set: "routing", version: 1, model: "jev-latest", transport: "http", threadId: "th1",
    answers: { task: { type: "choice", choice: "small_edit", confidence: 0.9 }, complexity: { type: "score", score: 0.4, confidence: 0.8 }, wants_speed: { type: "noul", noul: 0.2 } } });
  assert.equal(typeof receipt!.ms, "number");
  assert.ok(!Number.isNaN(Date.parse(receipt!.at)));
  assert.ok(!fs.readFileSync(path.join(home, "app", "decisions.jsonl"), "utf8").includes("SECRET_TOKEN_VALUE"), "the state sent to Jev is never stored");
});

test("an auth rejection on any set switches Jev off for every set, receipted, with routing's message unchanged", async () => {
  const home = tmpdir("modex-decisions-");
  let calls = 0;
  const transport: JevTransport = async () => { calls++; throw new JevError("Jev rejected the API key.", "auth", 401); };
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport });
  const rule: ApprovalRule = { id: "r1", when: "run the test suite", decision: "allow", enabled: true };
  const approval = await router.decisions.connect("approval", { threadId: "th1" });
  assert.ok(approval.transport);
  const gate = await decide({ backend: "claude", tool: "Bash", title: "$ pnpm test", cwd: "/w" }, { rules: [rule], config: { ...DEFAULT_APPROVAL_GATE, enabled: true }, project: { root: "/w", name: "w" }, mode: "agent", transport: approval.transport, model: approval.model });
  assert.equal(gate.decision, "ask", "a failed judgment fails closed");
  assert.match(gate.jevError!, /rejected the API key/);
  assert.partialDeepStrictEqual(receipts(home), [{ set: "approval", version: 1, threadId: "th1", error: { message: "Jev rejected the API key.", code: "auth" } }]);

  const route = await router.route({ thread: thread(), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.equal(route.source, "heuristic");
  assert.equal(route.item.reasons[0], "Jev is off for this session — Jev rejected the API key. Fix the key or credits and restart Modex. Used the built-in heuristic.");
  assert.equal(calls, 1, "a switched-off session asks nothing more");
  assert.deepEqual(await router.decisions.connect("follow_up"), { transport: null, model: "jev-latest", disabled: route.item.reasons[0]!.replace(" Used the built-in heuristic.", "") });
  router.reset();
  assert.ok((await router.decisions.connect("routing")).transport, "a key or policy change turns it back on");
});

test("an unconfigured judge reports why, asks nothing and stores nothing", async () => {
  const home = tmpdir("modex-decisions-");
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: null });
  assert.deepEqual(await router.decisions.connect("approval"), { transport: null, model: "jev-latest", unavailable: "No Jev API key found and no jev CLI on PATH." });
  const route = await router.route({ thread: thread(), text: "rename a to b", items: [], project: { name: "demo" } });
  assert.equal(route.item.reasons[0], "No Jev API key found and no jev CLI on PATH; used the built-in heuristic.");
  assert.deepEqual(receipts(home), []);
});

test("Try it receipts are marked as previews, and the log starts over past its size", async () => {
  const home = tmpdir("modex-decisions-");
  const router = new Router({ home, policy: () => DEFAULT_ROUTING, listModels, transport: async () => ({ answers: { destructive: { type: "noul", noul: 0.05 } } }) });
  const preview = await router.decisions.connect("approval", { preview: true });
  await preview.transport!({ state: {}, model: preview.model, questions: {} });
  assert.partialDeepStrictEqual(receipts(home), [{ set: "approval", preview: true, answers: { destructive: { type: "noul", noul: 0.05 } } }]);

  const file = path.join(tmpdir("modex-decisions-"), "decisions.jsonl");
  const log = new ReceiptLog(file, 400);
  const entry: DecisionReceipt = { at: new Date().toISOString(), set: "routing", version: 1, model: "jev-latest", transport: "http", ms: 1, answers: {} };
  for (let i = 0; i < 6; i++) log.write({ ...entry, ms: i });
  assert.ok(fs.existsSync(file.replace(/\.jsonl$/, ".1.jsonl")), "the previous file is kept once");
  assert.ok(fs.statSync(file).size < 400 + 200);
  assert.equal(log.read(1)[0]!.ms, 5, "the newest receipt reads first");
  const unwritable = new ReceiptLog(path.join(file, "nested", "decisions.jsonl"));
  assert.doesNotThrow(() => unwritable.write(entry), "a failed write never reaches the decision");
});
