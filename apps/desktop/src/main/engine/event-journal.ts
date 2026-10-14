import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ThreadEvent, ThreadItem } from "../../shared/types.js";

/** One journaled event and its cursor. Cursors only grow, and a cursor is never reused. */
export interface JournalEntry { seq: number; at: string; event: ThreadEvent }

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
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private pending: ThreadEvent[] = [];
  /** Pending row index per merge key, so a later update can fold into it. */
  private slots = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(file: string, private readonly flushMs = 250) {
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
      CREATE INDEX IF NOT EXISTS events_thread ON events (thread_id, seq);`);
    this.insert = this.db.prepare("INSERT INTO events (at, thread_id, type, event) VALUES (?, ?, ?, ?)");
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
    this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  /** Write everything pending in one transaction. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.slots = new Map();
    const at = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const event of batch) this.insert.run(at, event.threadId, event.type, JSON.stringify(event));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  /** The newest cursor written, 0 when empty. */
  latest(): number {
    this.flush();
    return Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq);
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.db.close();
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
 * A thread's transcript rebuilt from journaled events, applied as the runner applies them: an
 * `item` appends, an `item_update` merges into the item with that id and is ignored when there is
 * none.
 */
export function replayItems(entries: Iterable<JournalEntry | ThreadEvent>, threadId: string): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const entry of entries) {
    const event = "event" in entry ? entry.event : entry;
    if (event.threadId !== threadId) continue;
    if (event.type === "item") items.push(event.item);
    else if (event.type === "item_update") {
      const index = items.findIndex((item) => item.id === event.id);
      if (index >= 0) items[index] = { ...items[index], ...event.patch } as ThreadItem;
    }
  }
  return items;
}
