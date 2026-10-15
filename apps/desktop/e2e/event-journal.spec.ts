import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
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
