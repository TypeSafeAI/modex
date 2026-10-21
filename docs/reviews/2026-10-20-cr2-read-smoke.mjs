// #321 AC5: an authenticated read-only smoke test of the CR-2 read service against TypeSafeAI/modex,
// the repository Val authorized on 2026-10-20. It runs the compiled service with the real gh transport
// (Val's own `gh` login, GET only) and prints evidence: account and host, PR, head SHA, result states,
// coverage and request counts. It never prints a token, a header value or a response body.
import { CodeReviewService } from "../dist/src/main/engine/code-review/read-service.js";
import { ghTransport } from "../dist/src/main/engine/code-review/gh.js";

const real = ghTransport();
const calls = [];
const transport = async (call) => {
  const started = Date.now();
  const answer = await real(call);
  calls.push({ endpoint: call.endpoint.replace(/\?.*$/, "?…"), conditional: call.etag !== null, kind: answer.kind,
    status: answer.kind === "http" ? answer.status : null, ms: Date.now() - started,
    resource: answer.kind === "http" ? answer.headers["x-ratelimit-resource"] ?? null : null });
  return answer;
};
const service = new CodeReviewService({ transport });
let n = 0;
const read = (request) => service.read({ requestId: `smoke-${++n}`, ...request });
const summary = (reply) => ({ op: reply.op, state: reply.result.state, reason: reply.result.reason ?? null,
  coverage: reply.result.coverage ?? null, scope: reply.scope });

const target = Number(process.argv[2] ?? "334");
const evidence = { at: new Date().toISOString(), repository: "TypeSafeAI/modex", pr: target, steps: [] };
const step = (name, reply, extra = {}) => { evidence.steps.push({ name, ...summary(reply), ...extra }); return reply; };

const connection = step("connection", await read({ op: "connection" }));
const account = connection.result.value.state === "connected" ? connection.result.value.account : null;
evidence.account = account && { host: account.host, id: account.id, login: account.login };
if (!account) { console.log(JSON.stringify(evidence, null, 2)); process.exit(1); }

const inbox = await read({ op: "inbox", query: "repo:TypeSafeAI/modex" });
step("inbox", inbox, { groups: Object.fromEntries(Object.entries(inbox.result.value?.groups ?? {}).map(([g, r]) =>
  [g, { state: r.state, rows: r.value?.length ?? 0, coverage: r.coverage ?? null, first: r.value?.[0] ? { key: r.value[0].key, locator: r.value[0].locator, stackHint: r.value[0].stackHint } : null }])) });

const resolved = step("resolve", await read({ op: "resolve", input: `https://github.com/TypeSafeAI/modex/pull/${target}` }));
const key = resolved.result.value?.key;
evidence.key = key;
const overview = step("overview", await read({ op: "overview", key }));
const revision = overview.result.value?.revision;
evidence.revision = revision;
evidence.overview = overview.result.value && { state: overview.result.value.state, totals: overview.result.value.totals, headRepo: overview.result.value.headRepo };
const again = step("overview again (conditional)", await read({ op: "overview", key }));
evidence.conditionalStatus = calls.filter((c) => c.endpoint.startsWith(`repos/TypeSafeAI/modex/pulls/${target}`) && c.conditional).map((c) => c.status);
const activity = step("activity", await read({ op: "activity", key, cursor: null }));
evidence.activityKinds = [...new Set((activity.result.value ?? []).map((item) => item.kind))];
const checks = step("checks", await read({ op: "checks", key, revision }));
evidence.checks = (checks.result.value ?? []).map((c) => [c.source, c.name, c.reporter, c.status, c.conclusion]);
const files = step("files", await read({ op: "files", key, revision, cursor: null }));
const firstText = (files.result.value?.files ?? []).find((f) => f.patch.kind === "text" && f.status === "modified");
evidence.files = (files.result.value?.files ?? []).map((f) => [f.path, f.status, f.additions, f.deletions, f.patch.kind === "text" ? "text" : f.patch.reason]);
if (firstText) {
  const ctx = step("context", await read({ op: "context", key, revision, side: "head", path: firstText.path, start: 1, end: 3 }));
  evidence.context = ctx.result.value && { path: ctx.result.value.path, lines: ctx.result.value.lines.length, total: ctx.result.value.total };
}
step("stack", await read({ op: "stack", key }));
step("old account key refused", await read({ op: "overview", key: { ...key, account: "1" } }));
step("unknown repository id refused", await read({ op: "overview", key: { ...key, repoId: "1" } }));
evidence.requests = { total: calls.length, byResource: calls.reduce((m, c) => ({ ...m, [c.resource ?? c.kind]: (m[c.resource ?? c.kind] ?? 0) + 1 }), {}),
  notModified: calls.filter((c) => c.status === 304).length };
evidence.calls = calls;
console.log(JSON.stringify(evidence, null, 2));
