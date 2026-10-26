import { test } from "node:test";
import assert from "node:assert/strict";
import { Writes } from "../src/renderer/code-review/writes.js";
import type { WriteDraft, WriteReply } from "../src/shared/code-review-write.js";
import type { PrKey, PrRevision } from "../src/shared/code-review.js";

const key: PrKey = { account: "1", host: "github.com", repoId: "2", number: 3 };
const revision: PrRevision = { baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) };
function heldSave() {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let draft: WriteDraft | undefined;
  const bodies: string[] = [];
  const writes = new Writes(async (request) => {
    let value: unknown;
    if (request.op === "status") value = { account: { id: "1", login: "fixture" }, revision, drafts: draft ? { comment: draft } : {}, earlier: [], receipts: [] };
    else if (request.op === "save") {
      bodies.push(request.body);
      if (bodies.length === 1) { entered(); await gate; }
      assert.equal(request.expectedVersion, draft?.version ?? 0);
      draft = { kind: request.kind, revision, version: (draft?.version ?? 0) + 1, body: request.body, comments: request.comments };
      value = draft;
    } else throw new Error(`Unexpected ${request.op}`);
    return { requestId: request.requestId, key, op: request.op, result: { state: "ok", value } } as WriteReply;
  });
  return { writes, release, started, bodies };
}

test("preview flush waits for a newer edit made while an earlier save is held", async () => {
  const f = heldSave();
  try {
    await f.writes.refresh(key, revision);
    f.writes.editBody(key, revision, "comment", "first edit");
    const first = f.writes.flushBody(key, revision, "comment");
    await f.started;
    f.writes.editBody(key, revision, "comment", "latest edit");
    const previewFlush = f.writes.flushBody(key, revision, "comment");
    f.release();
    await first;
    const result = await previewFlush;
    assert.equal(result.ok && result.value.body, "latest edit");
    assert.deepEqual(f.bodies, ["first edit", "latest edit"]);
    assert.equal(f.writes.pendingBody(key, revision, "comment"), undefined);
    assert.equal(f.writes.entry(key, revision)?.status?.drafts.comment?.body, "latest edit");
  } finally { f.release(); f.writes.clear(); }
});

test("an old account's held save cannot restore buffers or entries after clear", async () => {
  const f = heldSave();
  try {
    await f.writes.refresh(key, revision);
    f.writes.editBody(key, revision, "comment", "old account");
    const pending = f.writes.flushBody(key, revision, "comment");
    await f.started;
    f.writes.clear();
    f.release();
    const result = await pending;
    assert.equal(!result.ok && result.reason, "account-changed");
    assert.equal(f.writes.pendingBody(key, revision, "comment"), undefined);
    assert.equal(f.writes.entry(key, revision), undefined);
  } finally { f.release(); f.writes.clear(); }
});
