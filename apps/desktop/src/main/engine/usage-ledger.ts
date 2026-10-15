import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { UsageEvent } from "../../shared/usage.js";
import type { TurnUsage } from "./backends/types.js";

/** The dashboard's tool ids: its names and colors are keyed by these, not by Modex backend ids. */
const TOOLS: Record<string, string> = { claude: "claude-code", codex: "codex" };
/** The most rows one read returns, newest kept. About a year of steady use. */
export const USAGE_READ_LIMIT = 50_000;

export interface UsageTurn {
  at: string;
  backend: string;
  model: string;
  threadId: string;
  project: string;
  account: string;
  usage: TurnUsage;
}

/**
 * Analytics' record of model usage: one JSON line per turn that called a model, appended to
 * `app/usage.jsonl`. Costs stay null (unpriced) until Modex has a price table. Reads skip lines
 * that do not parse, so a torn last line from a crash costs one row, not the file.
 */
export class UsageLedger {
  readonly file: string;

  constructor(appDir: string) {
    this.file = path.join(appDir, "usage.jsonl");
  }

  record(turn: UsageTurn): UsageEvent {
    const { usage } = turn;
    const event: UsageEvent = {
      id: randomUUID(),
      at: turn.at,
      tool: TOOLS[turn.backend] ?? turn.backend,
      model: turn.model || "default",
      session: turn.threadId,
      project: turn.project,
      account: turn.account,
      kind: "main",
      input: usage.totals?.input ?? usage.first.uncached,
      cached: usage.totals?.cached ?? usage.first.cacheRead,
      cacheWrite: usage.totals?.cacheWrite ?? usage.first.cacheWrite,
      // Both CLIs count reasoning inside output tokens.
      output: usage.outputTokens ?? 0,
      reasoning: 0,
      cost: null,
      uncachedCost: null,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file, "a+", 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(1);
      const separated = size === 0 || (fs.readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] === 10);
      // Preserve torn bytes, but keep the next valid event on its own record boundary.
      fs.writeFileSync(fd, `${separated ? "" : "\n"}${JSON.stringify(event)}\n`);
    } finally { fs.closeSync(fd); }
    return event;
  }

  /** Rows whose `at` falls in [since, until] (ISO strings, either bound optional), oldest first. */
  list(range: { since?: string; until?: string } = {}): UsageEvent[] {
    let text: string;
    try { text = fs.readFileSync(this.file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: UsageEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (!isUsageEvent(row)) continue;
      if (range.since && row.at < range.since) continue;
      if (range.until && row.at > range.until) continue;
      rows.push(row);
    }
    return rows.length > USAGE_READ_LIMIT ? rows.slice(-USAGE_READ_LIMIT) : rows;
  }
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const str = (v: unknown): v is string => typeof v === "string";

function isUsageEvent(v: unknown): v is UsageEvent {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return str(r.id) && str(r.at) && str(r.tool) && str(r.model) && str(r.session) && str(r.project) && str(r.account) && str(r.kind)
    && num(r.input) && num(r.cached) && num(r.cacheWrite) && num(r.output) && num(r.reasoning)
    && (r.cost === null || num(r.cost)) && (r.uncachedCost === null || num(r.uncachedCost));
}
