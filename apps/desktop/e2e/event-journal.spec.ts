import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventJournal, replayItems } from "../src/main/engine/event-journal";
import { createThread, launch, seedHome } from "./support";

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
