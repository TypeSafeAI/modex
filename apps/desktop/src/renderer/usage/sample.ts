import type { UsageEvent } from "./ledger.js";

// Synthetic upstream fixtures used only as workload seeds, never as live prices.
const seeds: UsageEvent[] = [
  {
    at: "2026-01-01T10:00:05+00:00",
    tool: "claude-code",
    model: "claude-opus-5",
    session: "s1",
    account: "claude:example",
    kind: "main",
    id: "sample-1",
    project: "/w",
    input: 10,
    cached: 1000,
    cacheWrite: 200,
    output: 50,
    reasoning: 0,
    cost: 0.0038,
    uncachedCost: 0.0073,
  },
  {
    at: "2026-02-01T10:00:20+00:00",
    tool: "codex",
    model: "gpt-5.5",
    session: "rollout-2026-02-01T10-00-00-p1000000-0000-0000-0000-000000000001",
    account: "codex:example",
    kind: "main",
    id: "sample-2",
    project: "/w",
    input: 100,
    cached: 900,
    cacheWrite: 0,
    output: 100,
    reasoning: 10,
    cost: 0.00395,
    uncachedCost: 0.008,
  },
  {
    at: "2026-02-01T10:00:40+00:00",
    tool: "codex",
    model: "gpt-5.5",
    session: "rollout-2026-02-01T10-00-00-p1000000-0000-0000-0000-000000000001",
    account: "codex:example",
    kind: "main",
    id: "sample-3",
    project: "/w",
    input: 100,
    cached: 900,
    cacheWrite: 0,
    output: 100,
    reasoning: 10,
    cost: 0.00395,
    uncachedCost: 0.008,
  },
  {
    at: "2026-02-01T11:00:30+00:00",
    tool: "codex",
    model: "gpt-5.5",
    session: "c1000000-0000-0000-0000-000000000002",
    account: "codex:example",
    kind: "subagent",
    id: "sample-4",
    project: "/w",
    input: 100,
    cached: 100,
    cacheWrite: 0,
    output: 30,
    reasoning: 0,
    cost: 0.00145,
    uncachedCost: 0.0019,
  },
  {
    at: "2026-03-01T10:00:03+00:00",
    tool: "gemini-cli",
    model: "gemini-2.5-pro",
    session: "g1",
    account: "gemini:example",
    kind: "main",
    id: "sample-5",
    project: "",
    input: 200,
    cached: 300,
    cacheWrite: 0,
    output: 60,
    reasoning: 20,
    cost: null,
    uncachedCost: null,
  },
  {
    at: "2026-03-31T23:33:21+00:00",
    tool: "cline",
    model: "claude-sonnet-5",
    session: "t1",
    account: "unattributed",
    kind: "main",
    id: "sample-6",
    project: "",
    input: 800,
    cached: 700,
    cacheWrite: 100,
    output: 60,
    reasoning: 0,
    cost: 0.00259,
    uncachedCost: 0.0038,
  },
  {
    at: "2026-04-01T09:00:00+00:00",
    tool: "aider",
    model: "gpt-5.5",
    session: "repo@2026-04-01 09:00:00",
    account: "unattributed",
    kind: "main",
    id: "sample-7",
    project: "/sample/aider/repo",
    input: 2800,
    cached: 0,
    cacheWrite: 0,
    output: 27,
    reasoning: 0,
    cost: 0.01481,
    uncachedCost: 0.01481,
  },
  {
    at: "2026-04-01T09:00:00+00:00",
    tool: "aider",
    model: "gpt-5.5",
    session: "repo@2026-04-01 09:00:00",
    account: "unattributed",
    kind: "main",
    id: "sample-8",
    project: "/sample/aider/repo",
    input: 36428,
    cached: 0,
    cacheWrite: 0,
    output: 120,
    reasoning: 0,
    cost: 0.18574,
    uncachedCost: 0.18574,
  },
  {
    at: "2026-05-01T10:00:00+00:00",
    tool: "kimi",
    model: "kimi-k2.6",
    session: "k1",
    account: "unattributed",
    kind: "main",
    id: "sample-9",
    project: "",
    input: 100,
    cached: 900,
    cacheWrite: 50,
    output: 40,
    reasoning: 0,
    cost: null,
    uncachedCost: null,
  },
  {
    at: "2026-06-01T10:00:00+00:00",
    tool: "mistral-vibe",
    model: "devstral-2",
    session: "v1",
    account: "unattributed",
    kind: "main",
    id: "sample-10",
    project: "/w",
    input: 5000,
    cached: 0,
    cacheWrite: 0,
    output: 300,
    reasoning: 0,
    cost: null,
    uncachedCost: null,
  },
  {
    at: "2026-07-01T10:00:00+00:00",
    tool: "continue",
    model: "openai/gpt-5-mini",
    session: "c1",
    account: "unattributed",
    kind: "main",
    id: "sample-11",
    project: "",
    input: 1200,
    cached: 0,
    cacheWrite: 0,
    output: 80,
    reasoning: 0,
    cost: 0.00046,
    uncachedCost: 0.00046,
  },
  {
    at: "2026-08-01T10:00:04+00:00",
    tool: "pi",
    model: "anthropic/claude-sonnet-5",
    session: "2026-08-01_p",
    account: "unattributed",
    kind: "main",
    id: "sample-12",
    project: "",
    input: 20,
    cached: 400,
    cacheWrite: 0,
    output: 10,
    reasoning: 0,
    cost: 0.00022,
    uncachedCost: 0.00094,
  },
  {
    at: "2026-09-01T10:00:02+00:00",
    tool: "codebuff",
    model: "claude-opus-5",
    session: "chat-messages",
    account: "unattributed",
    kind: "main",
    id: "sample-13",
    project: "",
    input: 300,
    cached: 100,
    cacheWrite: 0,
    output: 25,
    reasoning: 0,
    cost: 0.002175,
    uncachedCost: 0.002625,
  },
  {
    at: "2026-09-01T10:00:00Z",
    tool: "github-copilot",
    model: "gpt-5",
    session: "copilot-demo",
    account: "github:demo",
    kind: "main",
    id: "copilot-seed",
    project: "",
    input: 2400,
    cached: 600,
    cacheWrite: 0,
    output: 480,
    reasoning: 120,
    // Copilot credits/request multipliers are not USD. No conversion is assumed.
    cost: null,
    uncachedCost: null,
  },
];

// Fixed scenarios, not a benchmark: repeated sessions, cold/warm context,
// quiet/busy months, missing prices and unattributed work. No random or clock input.
const projects = [
  "/demo/atlas-web",
  "/demo/design-system",
  "/demo/payments-api",
  "/demo/docs",
  "",
];
const otherSeeds = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const monthlyLoad = [2, 3, 2, 5, 4, 6, 4, 7, 5];
export const sampleEvents: UsageEvent[] = [];
for (let month = 0; month < 9; month++) {
  for (let workday = 0; workday < 5; workday++) {
    const date = new Date(Date.UTC(2026, month, 2 + workday * 5));
    // Move weekend scenarios to Monday; all sessions have a plausible workday.
    if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 2);
    const day = date.toISOString().slice(0, 10);
    const sourceIndexes = [
      (month + workday) % 2 === 0 ? 0 : 1,
      13,
      otherSeeds[(month * 5 + workday) % otherSeeds.length]!,
    ];
    for (const [slot, seedIndex] of sourceIndexes.entries()) {
      const seed = seeds[seedIndex]!;
      const session = "demo-" + day + "-" + slot;
      const project = projects[(month + workday + slot) % projects.length]!;
      const turns = 2 + ((month + workday + slot) % 4);
      for (let turn = 0; turn < turns; turn++) {
        const scale = monthlyLoad[month]! * (2 + turn);
        const subagent =
          slot === 0 && (month + workday) % 4 === 0 && turn === turns - 1;
        sampleEvents.push({
          ...seed,
          id: session + "-call-" + turn,
          at:
            day +
            "T" +
            String(9 + slot * 3).padStart(2, "0") +
            ":" +
            String(8 + turn * 4).padStart(2, "0") +
            ":00Z",
          session: session + (subagent ? "-subagent" : ""),
          project,
          account: seed.account.replace(":example", ":demo"),
          kind: subagent ? "subagent" : "main",
          input: seed.input * scale,
          cached: seed.cached * scale,
          cacheWrite: seed.cacheWrite * scale,
          output: seed.output * scale,
          reasoning: seed.reasoning * scale,
          cost:
            seed.cost === null ? null : Number((seed.cost * scale).toFixed(6)),
          uncachedCost:
            seed.uncachedCost === null
              ? null
              : Number((seed.uncachedCost * scale).toFixed(6)),
        });
      }
    }
  }
}
