# Usage dashboard preview

Run from the repository root in your session worktree:

```sh
npm run dev:usage -w @modex/desktop
```

Open <http://127.0.0.1:8766>. This server binds to loopback and fails if the port is
already occupied. Build the standalone page with:

```sh
npm run build:usage -w @modex/desktop
```

The output is `apps/desktop/dist/usage-preview/`. The normal desktop build also
builds this entry point, so CI checks the preview bundle. It uses the existing
React and Vite dependencies, without the desktop bridge or Electron processes.
It is not included in the packaged desktop app or its navigation yet.

## What works

Overview charts and token breakdowns, activity search and call details, model/tool
comparison, project drill-downs, account attribution, and source coverage all read
the same fixture records. Date and tool filters apply together; date bounds are
inclusive UTC days. CSV export includes the filtered search results. Missing
prices remain unpriced, and reasoning is already included in output tokens.

Both appearances use TypeSafe UI's palette and self-hosted IBM Plex fonts.
The sidebar groups Workspace and Manage into keyboard-operable disclosures,
with concise Models and Sources labels and a large Demo Data stamp. Following a
link into a collapsed group reopens it so the current destination stays visible.
Narrow screens switch to a horizontal navigation strip and stacked panels; wider
tables scroll within their panel. All six mobile destinations stay available
regardless of the desktop disclosure state. Charts include a text summary and data table.
Dialogs support Escape; focus moves to the heading after a navigation change.

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
- Palette, spacing, surface treatment, and typography follow
  [TypeSafe UI](https://ui.jev.works), with token references from
  [its source](https://github.com/TypeSafeAI/typesafe-ui/blob/main/packages/ui/src/styles/globals.css).
- IBM Plex Sans and IBM Plex Mono were sourced from TypeSafe UI's hosted font
  assets. Their SIL Open Font License is retained in `usage/public/licenses/OFL.txt`.
- The brand mark reuses Modex's existing `BrandMark` component.

Live log collection, account connections, subscription billing, and provider
quotas are not implemented. Before adding collection, validate duplicate Claude
message updates and Codex fork-replay handling against real sanitized records.

## Validation

```sh
npm run typecheck -w @modex/desktop
npm run build:usage -w @modex/desktop
npm run build:main -w @modex/desktop
node --test apps/desktop/dist/test/usage-ledger.test.js
```

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
