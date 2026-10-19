import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { Backend, TurnSink } from "../src/main/engine/backends/types.js";
import type { ApprovalAnswer, ThreadItem } from "../src/shared/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * Who answered a card (docs/human-requests.md, CF-6 #279): a standing answer answers what is already
 * waiting as whoever set it, not as this window.
 */

const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
const approval = (items: ThreadItem[]) => items.find((i) => i.kind === "approval") as ThreadItem & { answer?: string; answeredBy?: string };

/** A Claude-shaped backend whose turn asks one approval and records the decision it hears. */
function asking(heard: ApprovalAnswer[]): Backend {
  return { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    heard.push(await sink.approval({ question: "Allow Bash: $ deploy?", canAlways: false, action: { backend: "claude", tool: "Bash", title: "$ deploy", input: { command: "deploy" } } }));
    return { status: "completed" };
  } };
}

for (const by of ["phone", "paired-desktop", undefined]) {
  test(`switching a thread to YOLO answers its waiting approval as ${by ?? "this window"}`, async () => {
    const heard: ApprovalAnswer[] = [];
    const home = tmpdir("modex-request-attribution-");
    const store = new Store(home);
    const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { claude: asking(heard) } });
    try {
      const thread = await runner.createThread(store.addProject(gitRepo()).id, { backend: "claude", auto: false });
      const sent = runner.send(thread.id, "deploy");
      await waitFor(() => Boolean(approval(runner.items(thread.id))));
      runner.updateThread(thread.id, { approvals: "yolo" }, by ? { by } : {});
      await sent;
      assert.deepEqual(heard, ["yes"]);
      const card = approval(runner.items(thread.id));
      assert.deepEqual([card.answer, card.answeredBy], ["yes", by ?? "desktop"]);
      assert.equal(approval(new Store(home).items(thread.id)).answeredBy, by ?? "desktop", "and saved that way");
    } finally { await runner.dispose(); }
  });
}
