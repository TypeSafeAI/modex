import { test } from "node:test";
import assert from "node:assert/strict";
import { stageFileBatch } from "../src/renderer/stage-files.js";
import type { ModexBridge } from "../src/shared/types.js";
import type { StagedFile } from "../src/shared/attachments.js";
import { LIMITS } from "../src/shared/attachments.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
const testBridge = (stage: (file: StagedFile) => Promise<unknown>, pathForFile?: (f: File) => string) => ({
  invoke: async (_channel: string, payload: { files: StagedFile[] }) => { assert.equal(payload.files.length, 1); return stage(payload.files[0]!); }, pathForFile,
}) as Pick<ModexBridge, "invoke" | "pathForFile">;
const stageResult = (name: string) => ({ staged: [{ id: name, name, rel: `staging/${name}`, size: 1, mime: "text/plain", kind: "file" }], errors: [] });

test("encoding and staging are sequential across overlapping batches, with one file in each command", async () => {
  const held = deferred(); const started = deferred(); const reads: string[] = []; const sent: string[] = [];
  const bridge = testBridge(async file => { sent.push(file.name); if (file.name === "a") { started.resolve(); await held.promise; } return stageResult(file.name); });
  const file = (name: string) => { const f = new File(["x"], name); f.arrayBuffer = async () => { reads.push(name); return new TextEncoder().encode("x").buffer; }; return f; };
  const first = stageFileBatch([file("a"), file("b")], 20, bridge); await Promise.race([started.promise, first]);
  const second = stageFileBatch([file("c")], 20, bridge);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(reads, ["a"]); assert.deepEqual(sent, ["a"]);
  held.resolve(); await Promise.all([first, second]); assert.deepEqual(new Set(reads), new Set(["a", "b", "c"]));
});

test("file failures keep prior and later successes; image bounds prevent reading; room excludes excess", async () => {
  const names: string[] = [];
  const bridge = testBridge(async file => { names.push(file.name); if (file.name === "bad") throw new Error("transport failed"); return stageResult(file.name); });
  const big = new File([new Uint8Array(LIMITS.imageBytes + 1)], "large.png", { type: "image/png" });
  big.arrayBuffer = async () => { throw new Error("should not read oversized image"); };
  const result = await stageFileBatch([new File(["a"], "a"), new File(["b"], "bad"), big, new File(["c"], "c"), new File(["x"], "excluded")], 4, bridge);
  assert.deepEqual(result.staged.map(x => x.name), ["a", "c"]);
  assert.deepEqual(names, ["a", "bad", "c"]);
  assert.match(result.errors.join(" "), /left out/); assert.match(result.errors.join(" "), /bad.*transport failed/); assert.match(result.errors.join(" "), /large.png.*limit/);
});

test("native trusted path staging does not encode the file", async () => {
  const file = new File(["hello"], "note.txt"); file.arrayBuffer = async () => { throw new Error("unexpected encode"); };
  const bridge = testBridge(async source => { assert.equal(source.path, "/selected/note.txt"); assert.equal(source.data, undefined); return stageResult(source.name); }, () => "/selected/note.txt");
  assert.equal((await stageFileBatch([file], 1, bridge)).staged.length, 1);
});
