export interface UsageEvent {
  id: string;
  at: string;
  tool: string;
  model: string;
  session: string;
  project: string;
  account: string;
  kind: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  cost: number | null;
  uncachedCost: number | null;
}
export interface Filters {
  tool: string;
  since: string;
  until: string;
}
export const filterEvents = (
  events: UsageEvent[],
  filters: Filters,
): UsageEvent[] =>
  events.filter((event) => {
    const day = new Date(event.at).toISOString().slice(0, 10);
    return (
      (filters.tool === "all" || event.tool === filters.tool) &&
      (!filters.since || day >= filters.since) &&
      (!filters.until || day <= filters.until)
    );
  });
export function summarize(events: UsageEvent[]) {
  const total = {
    calls: events.length,
    tokens: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    cost: 0,
    saved: 0,
    unpriced: 0,
    sessions: 0,
    activeDays: 0,
    hitRate: 0,
  };
  const sessions = new Set<string>(),
    days = new Set<string>();
  for (const event of events) {
    total.input += event.input;
    total.cached += event.cached;
    total.cacheWrite += event.cacheWrite;
    total.output += event.output;
    if (event.cost === null) total.unpriced++;
    else {
      total.cost += event.cost;
      if (event.uncachedCost !== null)
        total.saved += event.uncachedCost - event.cost;
    }
    sessions.add(event.tool + ":" + event.session);
    days.add(new Date(event.at).toISOString().slice(0, 10));
  }
  const prompt = total.input + total.cached + total.cacheWrite;
  total.tokens = prompt + total.output; // Reasoning is already included in output.
  total.hitRate = prompt ? (total.cached / prompt) * 100 : 0;
  total.sessions = sessions.size;
  total.activeDays = days.size;
  return total;
}
export function exportCsv(events: UsageEvent[]): string {
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^\s*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text)
      ? '"' + text.replaceAll('"', '""') + '"'
      : text;
  };
  return [
    [
      "timestamp_utc",
      "tool",
      "model",
      "project",
      "session",
      "input_uncached",
      "cache_read",
      "cache_write",
      "output",
      "api_equivalent_usd",
      "pricing",
    ],
    ...events.map((event) => [
      event.at,
      event.tool,
      event.model,
      event.project,
      event.session,
      event.input,
      event.cached,
      event.cacheWrite,
      event.output,
      event.cost,
      event.cost === null ? "unpriced" : "estimated",
    ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\r\n");
}
export const toolNames: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  aider: "Aider",
  "mistral-vibe": "Mistral Vibe",
  cline: "Cline",
  continue: "Continue",
  kimi: "Kimi",
  "gemini-cli": "Gemini CLI",
  pi: "Pi",
  codebuff: "Codebuff",
};
export const toolName = (tool: string) => toolNames[tool] ?? tool;
export const toolColors: Record<string, string> = {
  aider: "pink",
  codex: "teal",
  "claude-code": "amber",
  "mistral-vibe": "blue",
  cline: "violet",
  continue: "green",
  kimi: "amber",
  "gemini-cli": "blue",
  pi: "teal",
  codebuff: "violet",
};
export const compact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
export const money = (n: number | null) =>
  n === null
    ? "Unpriced"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2,
      }).format(n);
export const dateLabel = (date: string, options?: Intl.DateTimeFormatOptions) =>
  new Date(date).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...options,
  });
export function groupEvents(
  events: UsageEvent[],
  key: (event: UsageEvent) => string,
) {
  const groups = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const name = key(event);
    groups.set(name, [...(groups.get(name) ?? []), event]);
  }
  return [...groups]
    .map(([name, rows]) => ({ name, rows, ...summarize(rows) }))
    .sort((a, b) => b.tokens - a.tokens);
}

export const costLabel = (total: ReturnType<typeof summarize>) =>
  total.calls > 0 && total.unpriced === total.calls
    ? "Unpriced"
    : money(total.cost) + (total.unpriced > 0 ? " (partial)" : "");
