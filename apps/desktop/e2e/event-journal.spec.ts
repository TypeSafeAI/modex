import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventJournal, replayItems } from "../src/main/engine/event-journal";
import { createThread, currentRow, items, launch, seedHome, tid } from "./support";

// Routines Phase 0: with MODEX_EVENT_JOURNAL=1 the app records thread events alongside its state
// files. Off by default, so every other spec runs without it.
test("the opt-in event journal replays a real app session to its saved transcript", async () => {
  const { home, repo } = seedHome();
  const previous = process.env.MODEX_EVENT_JOURNAL;
  process.env.MODEX_EVENT_JOURNAL = "1";
  try {
    const { app, page } = await launch(home);
    let threadId: string;
    try {
      threadId = await createThread(page, "journal this session");
    } finally {
      await app.close();
    }
    const file = path.join(home, "app", "events.sqlite");
    expect(fs.existsSync(file)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "threads", `${threadId}.json`), "utf8"));
    expect(saved.length).toBeGreaterThan(1);
    const journal = new EventJournal(file);
    try {
      const entries = journal.since(0, { threadId });
      expect(entries.length).toBeGreaterThan(0);
      expect(replayItems(entries, threadId)).toEqual(saved);
      expect(entries.some((entry) => entry.event.type === "status")).toBe(true);
    } finally {
      journal.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MODEX_EVENT_JOURNAL; else process.env.MODEX_EVENT_JOURNAL = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("without the flag the app writes no journal", async () => {
  const { home, repo } = seedHome();
  const previous = process.env.MODEX_EVENT_JOURNAL;
  delete process.env.MODEX_EVENT_JOURNAL;
  try {
    const { app, page } = await launch(home);
    try { await createThread(page, "no journal here"); } finally { await app.close(); }
    expect(fs.existsSync(path.join(home, "app", "events.sqlite"))).toBe(false);
  } finally {
    if (previous !== undefined) process.env.MODEX_EVENT_JOURNAL = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// CF-6 (#279): the app's journal keeps its identity across a clean relaunch, so paired clients still
// resume, and takes a new one after the app is killed, so a cursor issued before the crash reloads.
test("the app's journal keeps its identity across a clean relaunch and takes a new one after a kill", async () => {
  const { home, repo } = seedHome();
  const previous = process.env.MODEX_EVENT_JOURNAL;
  process.env.MODEX_EVENT_JOURNAL = "1";
  const file = path.join(home, "app", "events.sqlite");
  // Read-only, so this test never marks the journal open or closed itself.
  const meta = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const value = (key: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
      return { id: value("id"), open: value("open") };
    } finally { db.close(); }
  };
  try {
    let run = await launch(home);
    try { await createThread(run.page, "journal this session"); } finally { await run.app.close(); }
    const first = meta();
    expect(first.id).toBeTruthy();
    expect(first.open).toBe("0");

    run = await launch(home);
    await run.app.close();
    expect(meta()).toEqual(first);

    run = await launch(home);
    const killed = new Promise((resolve) => run.app.process().once("exit", resolve));
    run.app.process().kill("SIGKILL");
    await killed;
    expect(meta()).toEqual({ id: first.id, open: "1" });

    run = await launch(home);
    try {
      await expect.poll(() => meta().id).not.toBe(first.id);
    } finally { await run.app.close(); }
    expect(meta().open).toBe("0");
  } finally {
    if (previous === undefined) delete process.env.MODEX_EVENT_JOURNAL; else process.env.MODEX_EVENT_JOURNAL = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// CF-6 (#279) gate G6, the power-loss proxy: SIGKILL of the app in the middle of a streaming reply, while the
// journal's 250 ms batch is pending. A kill is not a power cut (the OS still flushes what SQLite and the
// state files handed it), so this stands in for one and is labelled as one in docs/reviews/2026-10-22-cf6-gates.md.
test("killed mid-batch during a streaming reply: the relaunch takes a new journal identity, keeps the saved transcript and runs nothing again", async () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-script-")), "long-reply.json");
  fs.writeFileSync(script, JSON.stringify([{ content: words }]));
  const { home, repo } = seedHome({ mock_script: script });
  const previous = process.env.MODEX_EVENT_JOURNAL;
  process.env.MODEX_EVENT_JOURNAL = "1";
  const file = path.join(home, "app", "events.sqlite");
  const read = <T>(fn: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(file, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
  const meta = () => read((db) => Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value])));
  try {
    let run = await launch(home);
    await run.page.keyboard.press("Meta+n");
    await expect(tid(run.page, "composer-input")).toBeFocused();
    await tid(run.page, "composer-input").fill("write a long reply");
    await run.page.keyboard.press("Meta+Enter");
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "running", { timeout: 15_000 });
    const threadId = (await currentRow(run.page).getAttribute("data-thread-id"))!;
    // Some of the reply is journaled, then the app dies between batches.
    await expect.poll(() => fs.existsSync(file) ? read((db) => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE thread_id = ? AND type = 'item_update'").get(threadId) as { n: number }).n) : 0, { timeout: 15_000 }).toBeGreaterThan(3);
    await run.page.waitForTimeout(120);
    const killed = new Promise((resolve) => run.app.process().once("exit", resolve));
    run.app.process().kill("SIGKILL");
    await killed;
    const before = meta();
    expect(before.open).toBe("1");
    // Read-only: opening an EventJournal here would itself take the new identity the relaunch must take.
    const fromJournal = replayItems(read((db) => (db.prepare("SELECT seq, at, event FROM events WHERE thread_id = ? ORDER BY seq").all(threadId) as { seq: number; at: string; event: string }[])
      .map((row) => ({ seq: row.seq, at: row.at, event: JSON.parse(row.event) }))), threadId);
    const savedAtKill = JSON.parse(fs.readFileSync(path.join(home, "app", "threads", `${threadId}.json`), "utf8")) as { id: string; kind: string; text?: string }[];

    run = await launch(home);
    try {
      await expect.poll(() => meta().id).not.toBe(before.id);
      await run.page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"]`).click();
      await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle");
      await expect(items(run.page, "user")).toHaveCount(1);
      await run.page.waitForTimeout(1500); // a resend or rerun would start here
      await expect(items(run.page, "user")).toHaveCount(1);
      await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle");
    } finally { await run.app.close(); }
    const saved = JSON.parse(fs.readFileSync(path.join(home, "app", "threads", `${threadId}.json`), "utf8")) as { id: string; kind: string; text?: string; outcome?: string }[];
    expect(saved.filter((i) => i.kind === "user")).toHaveLength(1);
    // Every journaled item is in the state files, and its journaled text is no newer than what they saved.
    for (const item of fromJournal) {
      const kept = saved.find((i) => i.id === item.id);
      expect(kept, `journaled item ${item.id} is in the saved transcript`).toBeTruthy();
      const text = (item as { text?: string }).text;
      if (typeof text === "string" && typeof kept!.text === "string") expect(kept!.text.startsWith(text) || text.startsWith(kept!.text)).toBe(true);
    }
    const reply = saved.find((i) => i.kind === "assistant");
    const atKill = savedAtKill.find((i) => i.kind === "assistant");
    console.log(`[cf6-g6] journal rows replayed ${fromJournal.length} items; assistant journaled ${(fromJournal.find((i) => i.kind === "assistant") as { text?: string } | undefined)?.text?.length ?? 0} chars, saved at kill ${atKill?.text?.length ?? 0}, after relaunch ${reply?.text?.length ?? 0} (outcome ${reply?.outcome ?? "none"})`);
    expect(reply?.text ?? "").not.toBe(words);
    expect(meta().open).toBe("0");
  } finally {
    if (previous === undefined) delete process.env.MODEX_EVENT_JOURNAL; else process.env.MODEX_EVENT_JOURNAL = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(path.dirname(script), { recursive: true, force: true });
  }
});
