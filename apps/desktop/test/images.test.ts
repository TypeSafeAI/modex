import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ImageStore } from "../src/main/engine/images/store.js";
import { ImageJobs } from "../src/main/engine/images/jobs.js";
import { imageHeader, boundedRead } from "../src/main/engine/images/files.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type {
  TurnOptions,
  TurnSink,
} from "../src/main/engine/backends/types.js";
import { PNG_B64 } from "./helpers.js";
import { local } from "./fakeproc.js";
const png = Buffer.from(PNG_B64, "base64");
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-images-test-"));
  let referenced = false;
  const images = new ImageStore(home, {
    thumbnail: (bytes) => bytes,
    referenced: () => referenced,
  });
  return {
    home,
    images,
    protect: (value: boolean) => (referenced = value),
    clean: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
test("owned images preserve source bytes, paginate, survive restart and protect referenced trash", () => {
  const f = fixture();
  try {
    const source = path.join(f.home, "input.png");
    fs.writeFileSync(source, png);
    const result = f.images.import([
      { name: "Original.png", path: source },
      { name: "bad.svg", data: Buffer.from("<svg/>").toString("base64") },
    ]);
    assert.equal(result.assets.length, 1);
    assert.equal(result.errors.length, 1);
    const image = result.assets[0]!;
    fs.unlinkSync(source);
    assert.deepEqual(f.images.bytes(image.id), png);
    f.images.update({ id: image.id, name: "Renamed", favorite: true });
    assert.equal(
      f.images.list({ view: "favorites", query: "renamed" }).total,
      1,
    );
    assert.equal(
      new ImageStore(f.home, { thumbnail: (b) => b }).get(image.id).name,
      "Renamed",
    );
    f.images.update({ id: image.id, trash: true });
    assert.equal(f.images.list().total, 0);
    f.protect(true);
    assert.throws(() => f.images.delete(image.id), /referenced/);
    assert.equal(f.images.list({ view: "trash" }).total, 1);
    f.protect(false);
    f.images.delete(image.id);
    assert.throws(() => f.images.get(image.id), /no longer/);
    assert.throws(() => f.images.list({ offset: -1 }), /Invalid/);
  } finally {
    f.clean();
  }
});
test("rejects oversized dimensions, spoofed formats, symlink reads and corrupt metadata without destroying originals", () => {
  const f = fixture();
  try {
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(50000, 16);
    bomb.writeUInt32BE(50000, 20);
    assert.throws(() => imageHeader(bomb), /40 megapixels/);
    assert.throws(() => imageHeader(Buffer.from("<svg>")), /valid PNG/);
    const real = path.join(f.home, "real.png");
    fs.writeFileSync(real, png);
    const link = path.join(f.home, "link.png");
    fs.symlinkSync(real, link);
    assert.throws(() => boundedRead(link));
    const result = f.images.import([
      { name: "spoof.png", data: Buffer.from("text").toString("base64") },
      { name: "real.png", data: PNG_B64 },
    ]);
    assert.equal(result.assets.length, 1);
    const original = f.images.filePath(result.assets[0]!.id);
    fs.writeFileSync(path.join(f.home, "images", "library.json"), "broken");
    assert.throws(() => f.images.list(), /preserved/);
    assert.deepEqual(fs.readFileSync(original), png);
  } finally {
    f.clean();
  }
});
test("library uses bounded pages and regenerates missing thumbnails", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 65; i++) f.images.add(png, `Image ${i}.png`);
    const page = f.images.list();
    assert.equal(page.assets.length, 60);
    assert.equal(page.nextOffset, 60);
    assert.equal(f.images.list({ offset: 60 }).assets.length, 5);
    const id = page.assets[0]!.id;
    fs.unlinkSync(path.join(f.images.root, "assets", id, "thumbnail.png"));
    assert.deepEqual(f.images.bytes(id, true), png);
  } finally {
    f.clean();
  }
});
async function jobsFixture(
  run: (
    options: TurnOptions,
    sink: TurnSink,
    signal: AbortSignal,
  ) => Promise<void>,
) {
  const f = fixture();
  const store = new Store(f.home);
  let jobs: ImageJobs;
  const runner = new ThreadRunner({
    home: f.home,
    store,
    emit: (event) => jobs?.onThreadEvent(event),
    images: { prepare: (thread, signal) => jobs.prepare(thread, signal) },
    backends: {
      claude: {
        id: "claude",
        listModels: async () => [],
        dispose: async () => {},
        runTurn: async (_text, options, sink, signal) => {
          await run(options, sink, signal);
          return { status: signal.aborted ? "interrupted" : "completed" };
        },
      },
    },
  });
  jobs = new ImageJobs({
    home: f.home,
    images: f.images,
    runner: () => runner,
    validate: async () => {},
    projectExists: () => true,
    changed: () => {},
  });
  const capability = jobs.bind({
    pluginId: "fixture",
    pluginVersion: "1",
    runtime: "claude",
    entrypoint: "fixture:images",
    label: "Fixture",
    edit: true,
  });
  return {
    ...f,
    store,
    runner,
    jobs,
    capability,
    cleanAsync: async () => {
      await jobs.dispose();
      await runner.dispose();
      f.clean();
    },
  };
}
async function settle(f: Awaited<ReturnType<typeof jobsFixture>>) {
  for (let i = 0; i < 500 && f.jobs.busy(); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.jobs.busy(), false);
}
test("generation registers actual output through job-scoped MCP, rejects traversal and preserves ancestry", async () => {
  let firstURL = "";
  const f = await jobsFixture(async (options, sink) => {
    assert.ok(options.images);
    firstURL = options.images.url;
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(firstURL)));
    try {
      fs.writeFileSync(path.join(options.cwd, "output", "result.png"), png);
      assert.equal(
        (
          await client.callTool({
            name: "register",
            arguments: { file: "../references/input.png" },
          })
        ).isError,
        true,
      );
      const saved = await client.callTool({
        name: "register",
        arguments: { file: "result.png" },
      });
      assert.notEqual(saved.isError, true);
      await client.callTool({
        name: "register",
        arguments: { file: "result.png" },
      });
      local(sink).assistant("Created an image.");
    } finally {
      await client.close();
    }
  });
  try {
    const source = f.images.add(png, "source.png");
    const input = {
      requestId: randomUUID(),
      prompt: "Turn this into a watercolor",
      capabilityId: f.capability.id,
      referenceIds: [source.id],
    };
    const job = f.jobs.submit(input);
    assert.equal(f.jobs.submit(input).id, job.id);
    await settle(f);
    const done = f.jobs.list()[0]!;
    assert.equal(done.status, "succeeded");
    assert.equal(done.outputIds.length, 1);
    const result = f.images.get(done.outputIds[0]!);
    assert.deepEqual(result.parentIds, [source.id]);
    assert.equal(result.prompt, input.prompt);
    assert.deepEqual(f.images.bytes(source.id), png);
    assert.equal(f.jobs.capabilities()[0]?.verifiedVersion, "1");
    assert.equal((await fetch(firstURL)).status, 404);
    assert.ok(f.jobs.items(job.id).some((i) => i.kind === "assistant"));
  } finally {
    await f.cleanAsync();
  }
});
test("text-only success fails; explicit retries get distinct attempts and running cancellation keeps stopped state", async () => {
  const f = await jobsFixture(async (_options, sink) => {
    local(sink).assistant("Done, but no image.");
  });
  try {
    const input = {
      requestId: randomUUID(),
      prompt: "A landscape",
      capabilityId: f.capability.id,
      referenceIds: [],
    };
    const job = f.jobs.submit(input);
    await settle(f);
    assert.equal(f.jobs.list()[0]?.status, "failed");
    assert.match(f.jobs.list()[0]?.error ?? "", /no registered/);
    const retry = f.jobs.retry(job.id, randomUUID());
    assert.notEqual(retry.id, job.id);
    assert.equal(retry.retryOf, job.id);
    f.jobs.cancel(retry.id);
    await settle(f);
    assert.equal(f.jobs.list()[0]?.status, "cancelled");
  } finally {
    await f.cleanAsync();
  }
});
test("restart marks pending jobs interrupted without replaying and retains drafts", async () => {
  const f = await jobsFixture(async (_options, sink) => {
    local(sink).assistant("No result");
  });
  try {
    f.jobs.saveDraft({
      prompt: "Keep my prompt",
      capabilityId: f.capability.id,
      referenceIds: [],
    });
    f.jobs.submit({
      requestId: randomUUID(),
      prompt: "A flower",
      capabilityId: f.capability.id,
      referenceIds: [],
    });
    const reopened = new ImageJobs({
      home: f.home,
      images: f.images,
      runner: () => f.runner,
      validate: async () => {
        throw new Error("must not run");
      },
      projectExists: () => true,
      changed: () => {},
    });
    assert.equal(reopened.list()[0]?.status, "interrupted");
    assert.equal(reopened.draft().prompt, "Keep my prompt");
    assert.equal(reopened.busy(), false);
    await reopened.dispose();
    await settle(f);
  } finally {
    await f.cleanAsync();
  }
});

test("a replaced output root cannot authorize reading an external image", async () => {
  const f = await jobsFixture(async (options, sink) => {
    const outside = path.join(path.dirname(path.dirname(options.cwd)), "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "private.png"), png);
    const output = path.join(options.cwd, "output");
    fs.rmdirSync(output);
    fs.symlinkSync(outside, output);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(options.images!.url)));
    try {
      assert.equal((await client.callTool({ name: "register", arguments: { file: "private.png" } })).isError, true);
      local(sink).assistant("Rejected symlink output.");
    } finally { await client.close(); }
  });
  try {
    f.jobs.submit({ requestId: randomUUID(), prompt: "Image", capabilityId: f.capability.id, referenceIds: [] });
    await settle(f);
    assert.equal(f.jobs.list()[0]!.status, "failed");
    assert.equal(f.images.list().total, 0);
  } finally { await f.cleanAsync(); }
});

test("failed queue persistence never admits rejected generation or draft changes", async () => {
  let runs = 0;
  const f = await jobsFixture(async () => { runs++; });
  const file = path.join(f.home, "images", "jobs.json");
  try {
    fs.renameSync(file, `${file}.backup`);
    fs.mkdirSync(file);
    const rejected = { requestId: randomUUID(), prompt: "Rejected", capabilityId: f.capability.id, referenceIds: [] };
    assert.throws(() => f.jobs.submit(rejected));
    assert.equal(f.jobs.list().length, 0);
    assert.throws(() => f.jobs.saveDraft(rejected));
    assert.equal(f.jobs.draft().prompt, "");
    fs.rmdirSync(file);
    fs.renameSync(`${file}.backup`, file);
    f.jobs.submit({ ...rejected, requestId: randomUUID(), prompt: "Accepted" });
    await settle(f);
    assert.equal(runs, 1);
    assert.deepEqual(f.jobs.list().map(j => j.prompt), ["Accepted"]);
  } finally { await f.cleanAsync(); }
});

test("cancellation stops execution even when job persistence fails", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const f = await jobsFixture(async (_options, _sink, signal) => {
    started();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  });
  const file = path.join(f.home, "images", "jobs.json");
  try {
    const job = f.jobs.submit({ requestId: randomUUID(), prompt: "Cancel", capabilityId: f.capability.id, referenceIds: [] });
    await ready;
    fs.renameSync(file, `${file}.backup`); fs.mkdirSync(file);
    assert.throws(() => f.jobs.cancel(job.id));
    await settle(f);
    assert.equal(aborted, true);
    assert.equal(f.jobs.list()[0]!.status, "cancelled");
    fs.rmdirSync(file); fs.renameSync(`${file}.backup`, file);
  } finally { await f.cleanAsync(); }
});
