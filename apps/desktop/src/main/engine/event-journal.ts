import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ThreadEvent, ThreadItem } from "../../shared/types.js";

/** One journaled event and its cursor. Cursors only grow, and a cursor is never reused. */
export interface JournalEntry { seq: number; at: string; event: ThreadEvent }

/**
 * Where a client continues after a reconnect. `entries` are the events after its cursor, oldest
 * first, read in the same step as `latest`. They are absent when the client must reload state:
 * its cursor came from another journal, was pruned, or is too far behind to page.
 */
export interface JournalResume { id: string; latest: number; entries?: JournalEntry[] }

/** How long rows are kept. A cursor older than what is kept gets "reload state". */
export interface JournalRetention { maxAgeMs: number; maxRows: number }
export const JOURNAL_RETENTION: JournalRetention = { maxAgeMs: 7 * 24 * 60 * 60_000, maxRows: 250_000 };
/** The most events one resume replays; a client further behind reloads state instead. */
export const RESUME_LIMIT = 10_000;

export interface EventJournalOptions {
  flushMs?: number;
  retention?: JournalRetention;
  /** A timed flush failed. The journal stays usable for the caller to close. */
  onError?: (error: unknown) => void;
}

/**
 * Routines Phase 0 event journal (docs/specs/2026-10-11-modex-routines-spec.md). Records every
 * thread event in SQLite with a durable cursor, so a client can ask for what it missed after
 * sleep or a reconnect. It is written alongside `state.json` and the per-thread files, which stay
 * authoritative; nothing reads the journal to decide app state.
 *
 * Writes are batched. Within one flush window, later updates to an item merge into that item's
 * pending row, so a streamed reply costs one row per window instead of one per token. A merged
 * row applies to the item exactly as the separate updates would have, so replay is unchanged.
 */
export class EventJournal {
  /** Names this journal file. A cursor from another file, even one with the same path, never resumes here. */
  readonly id: string;
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly flushMs: number;
  private readonly retention: JournalRetention;
  private readonly onError: ((error: unknown) => void) | undefined;
  private pending: ThreadEvent[] = [];
  /** Pending row index per merge key, so a later update can fold into it. */
  private slots = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<(entries: JournalEntry[]) => void>();
  /** The highest cursor retention has deleted; 0 before any pruning. */
  private prunedThrough: number;
  private closed = false;

  constructor(file: string, options: EventJournalOptions = {}) {
    this.flushMs = options.flushMs ?? 250;
    this.retention = options.retention ?? JOURNAL_RETENTION;
    this.onError = options.onError;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        type TEXT NOT NULL,
        event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_thread ON events (thread_id, seq);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('id', ?)").run(crypto.randomUUID());
    this.id = this.meta("id")!;
    this.prunedThrough = Number(this.meta("pruned_through") ?? 0);
    this.insert = this.db.prepare("INSERT INTO events (at, thread_id, type, event) VALUES (?, ?, ?, ?)");
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  record(event: ThreadEvent): void {
    if (this.closed) return;
    const key = mergeKey(event);
    const slot = key === undefined ? undefined : this.slots.get(key);
    if (slot !== undefined) this.pending[slot] = merge(this.pending[slot]!, event);
    else {
      this.pending.push(event);
      if (key !== undefined) this.slots.set(key, this.pending.length - 1);
      // An item's own row also absorbs its later updates.
      if (event.type === "item") this.slots.set(`item:${event.threadId}:${event.item.id}`, this.pending.length - 1);
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      try { this.flush(); } catch (error) { this.onError?.(error); }
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Write everything pending in one transaction, then hand the new rows to subscribers. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.slots = new Map();
    const at = new Date().toISOString();
    const entries: JournalEntry[] = [];
    this.db.exec("BEGIN");
    try {
      for (const event of batch) entries.push({ seq: Number(this.insert.run(at, event.threadId, event.type, JSON.stringify(event)).lastInsertRowid), at, event });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const listener of this.listeners) {
      try { listener(entries); }
      catch (error) { console.error("[modex] event journal subscriber failed:", error); }
    }
  }

  /**
   * Called with each batch of rows as it is written, in cursor order. A subscriber that also reads
   * with `resume()` misses nothing: both happen synchronously, so no batch falls between them.
   */
  subscribe(listener: (entries: JournalEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Events after `cursor`, oldest first, optionally for one thread. Pending events are flushed first. */
  since(cursor: number, opts: { threadId?: string; limit?: number } = {}): JournalEntry[] {
    this.flush();
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
    const rows = (opts.threadId
      ? this.db.prepare("SELECT seq, at, event FROM events WHERE seq > ? AND thread_id = ? ORDER BY seq LIMIT ?").all(cursor, opts.threadId, limit)
      : this.db.prepare("SELECT seq, at, event FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(cursor, limit)) as { seq: number; at: string; event: string }[];
    return rows.map((row) => ({ seq: Number(row.seq), at: row.at, event: JSON.parse(row.event) as ThreadEvent }));
  }

  /** The newest cursor written, 0 when empty. Pruning every row never moves it back. */
  latest(): number {
    this.flush();
    return Math.max(this.prunedThrough, Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq));
  }

  /**
   * What a client holding `cursor` from journal `id` missed, optionally for one thread. Without a
   * usable cursor, the answer is "reload state" with the cursor to continue from after that reload.
   */
  resume(id: string | undefined, cursor: number | undefined, opts: { threadId?: string } = {}): JournalResume {
    const latest = this.latest();
    const reload = { id: this.id, latest };
    if (id !== this.id || cursor === undefined || !Number.isSafeInteger(cursor) || cursor < this.prunedThrough || cursor > latest) return reload;
    const count = Number(((opts.threadId
      ? this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE seq > ? AND thread_id = ?").get(cursor, opts.threadId)
      : this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE seq > ?").get(cursor)) as { n: number }).n);
    if (count > RESUME_LIMIT) return reload;
    return { ...reload, entries: this.since(cursor, { ...opts, limit: RESUME_LIMIT }) };
  }

  /**
   * Delete rows older than the retention age, and the oldest rows past its row limit. Returns how
   * many rows went. Cursors still only grow; a client below the pruned point is told to reload.
   */
  prune(now = Date.now()): number {
    this.flush();
    const cutoff = new Date(now - this.retention.maxAgeMs).toISOString();
    const byAge = Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE at < ?").get(cutoff) as { seq: number }).seq);
    const byCount = Number((this.db.prepare("SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?").get(this.retention.maxRows) as { seq: number } | undefined)?.seq ?? 0);
    const through = Math.max(byAge, byCount);
    if (through <= this.prunedThrough) return 0;
    this.db.exec("BEGIN");
    try {
      const { changes } = this.db.prepare("DELETE FROM events WHERE seq <= ?").run(through);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('pruned_through', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(through));
      this.db.exec("COMMIT");
      this.prunedThrough = through;
      return Number(changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try { this.flush(); } finally {
      this.closed = true;
      this.listeners.clear();
      this.db.close();
    }
  }
}

function mergeKey(event: ThreadEvent): string | undefined {
  if (event.type === "item_update") return `item:${event.threadId}:${event.id}`;
  if (event.type === "status" || event.type === "thread") return `${event.type}:${event.threadId}`;
  return undefined;
}

/** Fold `next` into the pending row it shares a key with, as applying both in order would. */
function merge(previous: ThreadEvent, next: ThreadEvent): ThreadEvent {
  if (next.type === "item_update") {
    if (previous.type === "item") return { ...previous, item: { ...previous.item, ...next.patch } as ThreadItem };
    if (previous.type === "item_update") return { ...previous, patch: { ...previous.patch, ...next.patch } };
  }
  return next;
}

/**
 * A thread's transcript rebuilt from journaled events, applied as clients apply them: an `item` is
 * an upsert by id (appended when new, replacing the item otherwise), and an `item_update` merges
 * into the item with that id and is ignored when there is none. So a frame delivered twice changes
 * nothing, and items keep their identity: two items never merge unless they share an id.
 */
export function replayItems(entries: Iterable<JournalEntry | ThreadEvent>, threadId: string): ThreadItem[] {
  const items: ThreadItem[] = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    const event = "event" in entry ? entry.event : entry;
    if (event.threadId !== threadId) continue;
    if (event.type === "item") {
      const at = index.get(event.item.id);
      if (at === undefined) { index.set(event.item.id, items.length); items.push(event.item); }
      else items[at] = event.item;
    } else if (event.type === "item_update") {
      const at = index.get(event.id);
      if (at !== undefined) items[at] = { ...items[at], ...event.patch } as ThreadItem;
    }
  }
  return items;
}
