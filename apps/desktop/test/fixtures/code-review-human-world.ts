import { baseWorld, ghFile, sha, type GhWorld } from "./code-review-gh-world.js";

/** Complete, synthetic read data for the person-run keyboard/VoiceOver checklist, not acceptance results. */
export function humanWorld(): GhWorld {
  const world = baseWorld();
  const lending = "repos/example-org/lending", field = "repos/example-org/field-guide";
  const body = `This is a synthetic pull request for the person-run Code Review checklist. No library, account, deployment or result described here is real.

## What changes

Moving a hold to another pickup branch should preserve its original request time and queue position. The old implementation cancelled the hold and created another, putting the member behind requests received later. This change keeps the same hold and replaces only its pickup branch.

- **Identity:** keep the hold id so existing receipts and notifications still refer to the same request.
- **Ordering:** retain requestedAt, including ties between requests received during the same minute. The branch transfer must never become a new request.
- **Availability:** validate the target branch before making any change. A closed branch returns an explanation and leaves the original hold untouched.
- **Notifications:** describe the new pickup location without promising that an item is ready before it arrives.
- **Recovery:** a failed transfer leaves the original branch, identifier and timestamp together. Retrying after a failure must not create a second hold.
- **History:** show the old and new pickup branches in the transfer receipt so a member can explain a discrepancy to the desk.

## How to read this fixture

The first changed file has context, removed and added lines for the accessibility journey. Eight small text files in separate nested folders supply separate file headings and enough tree entries to exercise independent scrolling. A large generated text file has intentionally omitted patch content; the UI must label the missing patch rather than claim all lines are present. The last file is a binary image with no textual patch. The eleven file records total +8,912 and −47, matching the pull request metadata.

## Activity and checks

There are 101 made-up comments across two REST pages. Use Load more activity to reach the final comment. Check runs deliberately include success, failure and an in-progress result, and a separate commit status is pending. None is a real CI receipt or evidence that this synthetic change could merge. The preview destination uses example.test and must be activated explicitly; it comes from a synthetic deployment record rather than a comment link.

## Limits

The inferred stack is derived from these made-up base and head branches. It is not an authoritative dependency declaration. No native coding provider is available in this home: the provider executables record their arguments and refuse execution. Human VoiceOver observations, reduced-motion behavior and live review or write acceptance must be recorded separately by the person who performs them.
`;
  world.routes[`${lending}/pulls/73`] = { ...world.routes[`${lending}/pulls/73`] as object, body, comments: 101 };
  world.routes[`${field}/pulls/91`] = { ...world.routes[`${field}/pulls/91`] as object, body: "## Grouping branch pages\n\nSynthetic region grouping with four changed files, +11 and −4. No live data or deployment." };
  world.routes[`${lending}/issues/73/timeline`] = Array.from({ length: 101 }, (_, i) => ({
    id: 9100 + i, event: "commented", user: { id: 1002, login: "grace-fixture", type: "User" },
    created_at: new Date(Date.parse("2026-10-18T18:00:00Z") + i * 60_000).toISOString(),
    body: `Human checklist activity ${i + 1}: preserve the hold's original queue position.`,
  }));
  world.routes[`${lending}/deployments`] = [{ id: 8301, sha: sha("c"), environment: "preview", created_at: "2026-10-18T20:32:00Z" }];
  world.routes[`${lending}/deployments/8301/statuses`] = [{ id: 8302, state: "success", environment_url: "https://example.test/preview/73" }];
  const checkRun = (id: number, name: string, conclusion: string | null) => ({
    id, name, head_sha: sha("c"), status: conclusion ? "completed" : "in_progress", conclusion,
    app: { slug: "github-actions" }, started_at: "2026-10-18T20:31:00Z", completed_at: conclusion ? "2026-10-18T20:35:00Z" : null,
    html_url: `https://github.com/example-org/lending/runs/${id}`,
  });
  world.routes[`${lending}/commits/${sha("c")}/check-runs`] = { total_count: 4, check_runs: [
    checkRun(8101, "unit + e2e (macOS)", "success"), checkRun(8102, "typecheck", "success"), checkRun(8103, "lint", "failure"), checkRun(8104, "package", null),
  ] };
  world.routes[`${lending}/commits/${sha("c")}/status`] = { total_count: 1, statuses: [{ id: 8201, context: "preview/deploy", state: "pending", creator: { id: 1003, login: "deploy-bot", type: "User" }, created_at: "2026-10-18T20:32:00Z", updated_at: "2026-10-18T20:32:00Z", target_url: "https://example.test/preview/73" }] };
  world.routes[`${lending}/pulls/73/files`] = [
    ghFile("src/holds/move.ts", "@@ -1,3 +1,4 @@\n export function moveHold(hold, branch) {\n-  return createHold(branch);\n+  // Preserve the request identity and queue position.\n+  return { ...hold, pickupBranch: branch };\n }", 2, 1),
    ...Array.from({ length: 8 }, (_, i) => ghFile(`src/holds/transfer-${i + 1}/queue/identity/history/receipts/step.ts`, `@@ -0,0 +1 @@\n+export const transferStep${i + 1} = true;`, 1, 0, "added")),
    ghFile("generated/hold-index.txt", null, 8902, 46),
    ghFile("assets/shelf.png", null, 0, 0, "added"),
  ];
  world.routes[`${field}/pulls/91/files`] = [
    ghFile("src/branches/regions.ts", "@@ -1,4 +1,7 @@\n import { Branch } from \"./branch\";\n-export const regions = [\"north\", \"south\"];\n-export function groupByRegion(branches: Branch[]) { return branches; }\n+export const regions = [\"north\", \"south\", \"east\", \"west\"] as const;\n+export type Region = (typeof regions)[number];\n+export function groupByRegion(branches: Branch[]): Map<Region, Branch[]> {\n+  return new Map(regions.map((region) => [region, branches.filter((b) => b.region === region)]));\n+}\n export const DEFAULT_REGION = \"north\";", 5, 2),
    ghFile("src/branches/index.ts", "@@ -2,3 +2,5 @@\n export { Branch } from \"./branch\";\n-export { regions } from \"./regions\";\n+export { regions, groupByRegion } from \"./regions\";\n+export type { Region } from \"./regions\";\n+export { BranchList } from \"../pages/branch-list\";\n export { openingHours } from \"./hours\";", 3, 1),
    ghFile("src/pages/branch-list.tsx", "@@ -8,4 +8,5 @@ export function BranchList({ branches }: Props) {\n   return (\n-    <ul>{branches.map((b) => <li key={b.id}>{b.name}</li>)}</ul>\n+    <>{[...groupByRegion(branches)].map(([region, list]) => <section key={region}><h2>{region}</h2>\n+      <ul>{list.map((b) => <li key={b.id}>{b.name}</li>)}</ul></section>)}</>\n   );\n }", 2, 1),
    ghFile("docs/branches.md", "@@ -1,2 +1,3 @@\n # Branches\n+Branch pages are grouped by region: north, south, east and west.\n Each branch page lists its opening hours.", 1, 0),
  ];
  // Complete the other listed PRs too, so keyboard navigation does not land on fixture-only 404s.
  for (const [repo, numbers] of [[lending, [73, 70]], [field, [91, 73]]] as const) {
    world.routes[`${repo}/pulls`] = numbers.map(n => world.routes[`${repo}/pulls/${n}`]);
    for (const n of numbers) {
      world.routes[`${repo}/issues/${n}/timeline`] ??= [];
      world.routes[`${repo}/pulls/${n}/files`] ??= n === 70 ? [ghFile("hours.ts", "@@ -1 +1,2 @@\n-old\n+first\n+second", 2, 1), ghFile("hours.md", "@@ -0,0 +1 @@\n+Opening hours are printed on hold slips.", 1, 0, "added")] : [ghFile("anchors.md", "@@ -1,2 +1,5 @@\n-old\n-anchor\n+one\n+two\n+three\n+four\n+five", 5, 2)];
    }
    world.routes[`${repo}/deployments`] ??= [];
    world.routes[`${repo}/commits/${sha("c")}/check-runs`] ??= { total_count: 0, check_runs: [] };
    world.routes[`${repo}/commits/${sha("c")}/status`] ??= { total_count: 0, statuses: [] };
  }
  return world;
}
