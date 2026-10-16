# Analytics

Analytics shows how much model usage your Modex threads spend: tokens, cache reads and writes, and output, by
model, project, thread and account. Open it from the **Analytics** icon in the rail, next to Chat and Space.
**Settings → General → Show Analytics in the rail** hides the icon; the change applies right away.

## What is recorded

Each turn that called a model adds one row to `MODEX_HOME/app/usage.jsonl` (file mode 0600, one JSON object per
line). A row holds the time, the tool (`claude-code` or `codex`), the model the thread asked for (`default` when the
CLI chose), the thread id, the project name, the Codex account binding when there is one, and the turn's token
counts. Prompts, files and replies are never recorded.

- **Counts come from the CLIs' own usage reports**, through the same per-turn meter Auto routing uses
  (`backends/usage.ts`). A Claude call is counted once per message id; Codex reports are taken only for the
  thread's own turn. Input, cache reads and cache writes are summed over every call in the turn. Output includes
  reasoning, as both CLIs report it.
- **Every turn is recorded**, Auto or not, including a stopped turn that already called a model. A turn that never
  reached a model adds nothing.
- **Costs are unpriced.** Modex has no price table, so `cost` stays null and the dashboard shows calls as
  unpriced rather than free.
- **Recording is best-effort.** A failed write is logged and never changes the turn. Reading skips lines that
  don't parse, so a torn last line after a crash costs one row.
- Usage from before this release, from other tools, and from outside Modex is not imported.

## How it is shown

The dashboard is its own document in a native view over the Analytics surface, so its styles and the app's never
meet. Main serves it from the built page (`dist/usage-preview`, packaged with the app) on `modex-analytics://app/`
in an in-memory session, with the rows at `usage.json`; every other request from that session is refused, and the
page has no access to the desktop bridge. It refreshes every 15 seconds while visible. Like the knowledge base, the
view hides under dialogs and menus and while Streamer Mode is on.

It looks like the rest of Modex. The page reads the app's tokens (`renderer/tokens.css`), and main sets the app's
theme on it (Graphite, Jev or OpenCoven) as the page loads and whenever the theme changes in Settings; the view's
corners follow the app's sheet. Like Space, it has a sidebar titled **Analytics** with the six views, and each view
has its title with the date and tool filters and **Export CSV** beside it, over one line saying what was recorded.
Every view fits the window, down to the app's 900×600 minimum, with no page scroll: Overview sizes its totals,
chart, token breakdown, tools and recent turns to the window, and long tables and lists scroll inside their own
panel.

## The standalone preview

The same dashboard runs on its fictional fixture data outside the app, with a **Demo Data** stamp. Run from the
repository root in your session worktree:

```sh
pnpm --filter @modex/desktop dev:usage
```

Open <http://127.0.0.1:8766>. This server binds to loopback and fails if the port is
already occupied. Build the standalone page with:

```sh
pnpm --filter @modex/desktop build:usage
```

The output is `apps/desktop/dist/usage-preview/`. The normal desktop build also
builds this entry point, so CI checks the bundle. It uses the existing
React and Vite dependencies, without the desktop bridge or Electron processes.

## What works

Overview charts and token breakdowns, activity search and call details, model/tool
comparison, project drill-downs, account attribution, and source coverage all read
the same fixture records. Date and tool filters apply together; date bounds are
inclusive UTC days. CSV export includes the filtered search results. Missing
prices remain unpriced, and reasoning is already included in output tokens.

The preview takes the app's tokens too, in Graphite unless the URL says `?theme=jev` or
`?theme=coven`, and is laid out for the app's window sizes. The sidebar groups Workspace and
Manage into keyboard-operable disclosures; following a link into a collapsed group reopens it so
the current destination stays visible. Tables and lists scroll within their panel. Charts draw at
the size they are shown and carry a text summary. Dialogs support Escape; focus moves to the
heading after a navigation change.

## Fixture and asset provenance

- `src/renderer/usage/sample.ts` expands 13 synthetic workload seeds from the fixtures in
  [AI Usage Ledger](https://github.com/CompleteTech-LLC/ai-usage-ledger-skill), revision
  `28c39ea06315232e8752c3f36fb5aac8761a412e`. The generated `all_events.csv` was normalized
  into typed rows, then expanded into a deterministic fictional workspace: 471 calls,
  147 sessions, 45 active days, and 11 sources across January–September 2026. Four
  named demo projects and unattributed work illustrate drilling into a ledger.
  Raw-source paths are omitted. Its MIT notice is retained in `usage/public/licenses/LEDGER-LICENSE.txt`.
- The sample's model names, accounts, dates, and saved prices are fixture values,
  not verified provider offerings or current rates. API equivalents are estimates,
  not charges or subscription balances. Scaling each seed's token categories and
  costs together keeps the demo internally consistent. The workload includes
  subagents, cache reads/writes, quiet and busy months, and 212 unpriced calls.
- GitHub Copilot adds synthetic sessions throughout the demo, including filters,
  chart legends, activity, accounts, source coverage, and CSV. Its token values are
  illustrative. Its API-equivalent cost remains unpriced; Copilot billing units
  are never treated as USD. GitHub's [usage and billing documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)
  describes the separate reporting surfaces. No Copilot connector or import is implemented.
- Colors, type, radii and spacing are Modex's own (`renderer/tokens.css`); the chart series use
  its syntax palette. The page uses the system font stack, like the app, and ships no fonts.

Importing other tools' logs, account connections, subscription billing, and provider
quotas are not implemented.

## Validation

```sh
pnpm --filter @modex/desktop typecheck
pnpm --filter @modex/desktop build:usage
pnpm --filter @modex/desktop build:main
node --test apps/desktop/dist/test/usage-ledger.test.js apps/desktop/dist/test/analytics.test.js
pnpm --filter @modex/desktop exec playwright test e2e/analytics.spec.ts e2e/usage.spec.ts
```

`analytics.test.ts` covers the recorded row's shape, tool mapping and summed input, torn-line and date
filtering, recording for every turn without failing one, and that the analytics origin serves only the built page
and `usage.json` (no traversal, symlinks or other types). `e2e/analytics.spec.ts` opens Analytics from the rail on a
seeded row, checks the live banner without a Demo stamp and no bridge in the page, and hides it from Settings.

The focused tests cover inclusive UTC filtering, token/cost aggregation, missing
prices, partial cost labels, CSV escaping, and demo session/account consistency.
`e2e/usage.spec.ts` checks keyboard disclosure activation, automatic group reopening,
mobile navigation after desktop collapse, Copilot filtering, unknown costs,
account attribution, and a real CSV download. Browser interaction checks
complement these; they do not constitute VoiceOver or human keyboard-only acceptance.

Safari verification on 2026-10-07 covered both appearances, navigation, empty
search, custom dates, call details, and exact project drill-downs. Phone and
tablet iframe checks (390 and 768 CSS pixels including scrollbars) confirmed no
page-level horizontal overflow. CSV serialization tests pass; Safari displayed
its download-permission prompt, which was cancelled. No browser permission was
changed.
