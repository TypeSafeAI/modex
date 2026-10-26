import { parsePatch } from "../../../shared/code-review-patch.js";
import { canonicalPrUrl, prKeyId, sameRevision, type LineAnchor, type PrFile, type PrKey, type PrRevision, type PrState } from "../../../shared/code-review.js";
import {
  intentMarker, MERGE_BLOCKS, REFUSALS, validateWrite,
  type EarlierDraft, type MergeCheck, type MergeMethod, type PrAction, type PrStateChange, type WriteDraft, type WriteOperation, type WritePreview, type WriteReceipt, type WriteRefusal, type WriteReply, type WriteRequest, type WriteResult, type WriteStatus,
} from "../../../shared/code-review-write.js";
import { mergePreflight, type MergeFacts, type MergePreflight, type MergeState } from "./merge-preflight.js";
import { ReviewActions, type ReviewContext, type ReviewDraft, type ReviewIntent, type ReviewOutcome } from "./intents.js";
import type { GhAnswer } from "../code-review/gh.js";
import { ghHostsStamp } from "../code-review/gh.js";
import { changedFile, json, pull, repository, type Pull } from "../code-review/github.js";
import { DRAFT_MUTATIONS, ghWriteTransport, type GhWriteCall, type GhWriteTransport } from "./write-gh.js";

/**
 * CR-7's `code-review:write` (#326): comments, submitted reviews, a head-guarded merge, and the state menu,
 * title/description edits and reviewer requests (decisions 2–4), through the person's own `gh` login,
 * approved by Val on 2026-10-25. Separate from `code-review:read`. Before preparing a preview, and again
 * before sending it, main reads the signed-in account, the repository's permission for it, and the pull
 * request's head, target, state and lock itself; nothing the renderer says is authority. A preview is
 * bound to the window that asked for it and is spent by one send or one refusal. A send whose outcome is
 * unclear stays unknown until a read-back finds it or the person decides; nothing is resent on its own.
 */
export interface CodeReviewWriteOptions {
  /** Where review-actions/state.json lives (MODEX_HOME). */
  home: string;
  /** Off in demos, E2E and browser development, like the read service. */
  enabled?: boolean;
  transport?: GhWriteTransport;
  identityStamp?: () => string | null;
  now?: () => number;
  /** How long a checked account is trusted for drafts. Previews and sends always check again. */
  identityTtlMs?: number;
}

type Account = { id: string; login: string };
interface Fresh {
  key: PrKey; account: Account; stamp: string | null; owner: string; name: string; permissions: { pull: boolean; push: boolean; triage: boolean } | null; locked: boolean | null; pr: Pull;
  /** The PR's GraphQL node id, for the draft mutations only. */
  nodeId: string | null;
  /** GitHub's own merge state and the repository's allowed methods, as read; null where the read didn't say. */
  merge: Pick<MergeFacts, "mergeable" | "mergeState" | "methods">;
}

const KB = 1024, MB = 1024 * KB;
const READ_TIMEOUT_MS = 15_000, SEND_TIMEOUT_MS = 30_000;
const READ_BACK_PAGES = 30, PAGE = 100, RECEIPTS = 20;

class Refused extends Error {
  /** `detail` replaces the reason's fixed text with another fixed text, never with GitHub's words. */
  constructor(readonly reason: WriteRefusal, readonly detail?: string) { super(reason); }
}

export class CodeReviewWrites {
  private readonly home: string;
  private readonly enabled: boolean;
  private readonly transport: GhWriteTransport;
  private readonly stamp: () => string | null;
  private readonly now: () => number;
  private readonly ttl: number;
  private actions: ReviewActions | null = null;
  /** Previews this process issued, by intent id: the proof a send needs, and the window it belongs to. */
  private readonly previews = new Map<string, { confirmation: object; session: string }>();
  private identity: (Account & { stamp: string | null; at: number }) | null = null;
  /** Owner and name main last read for a PR, for receipt links only. Every write reads them again. */
  private readonly names = new Map<string, { owner: string; name: string }>();
  /** One operation at a time per pull request: a double click waits for the first to settle. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: CodeReviewWriteOptions) {
    this.home = options.home;
    this.enabled = options.enabled ?? true;
    this.transport = options.transport ?? ghWriteTransport();
    this.stamp = options.identityStamp ?? ghHostsStamp;
    this.now = options.now ?? Date.now;
    this.ttl = options.identityTtlMs ?? 30_000;
  }

  /** The `code-review:write` handler. `session` is main's name for the window that asked, never the renderer's. */
  async handle(input: unknown, session: string, currentDocument: () => boolean = () => true): Promise<WriteReply> {
    const request = validateWrite(input);
    if (!request) throw new Error("Invalid Code Review write request.");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error("Invalid Code Review session.");
    const reply = (result: WriteResult<unknown>) => ({ requestId: request.requestId, op: request.op, key: request.key, result }) as WriteReply;
    if (!this.enabled) return reply(refuse("disabled"));
    const id = prKeyId(request.key);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      try {
        if (!currentDocument()) throw new Refused("no-preview");
        return reply({ state: "ok", value: await this.run(request, session, currentDocument) });
      } catch (error) {
        // Anything that is not one of this file's refusals reads as `failed`: no exception text leaves main.
        return reply(error instanceof Refused ? refuse(error.reason, error.detail) : refuse("failed"));
      }
    });
    this.queues.set(id, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(id) === run) this.queues.delete(id);
    }
  }

  private run(request: WriteRequest, session: string, currentDocument: () => boolean): Promise<unknown> {
    switch (request.op) {
      case "status": return this.status(request.key, request.revision, session);
      case "save": return this.save(request, session);
      case "carry": return this.carry(request, session);
      case "prepare": return this.prepare(request, session);
      case "merge-check": return this.mergeCheck(request.key, request.revision);
      case "prepare-merge": return this.prepareMerge(request, session);
      case "prepare-action": return this.prepareAction(request, session);
      case "submit": return this.submit(request.key, request.intentId, session, currentDocument);
      case "cancel": return this.cancel(request.key, request.intentId, session);
      case "reconcile": return this.reconcile(request.key, request.intentId, session);
      case "abandon": return this.abandon(request.key, request.intentId, session);
    }
  }

  // --- Local state ------------------------------------------------------------------------------

  private store(): ReviewActions {
    try {
      this.actions ??= new ReviewActions(this.home);
      return this.actions;
    } catch {
      throw new Refused("storage");
    }
  }

  /** A storage failure is never a send: ReviewActions admits a dispatch only after it is durable. */
  private local<T>(work: (actions: ReviewActions) => T): T {
    const actions = this.store();
    try {
      return work(actions);
    } catch (error) {
      throw error instanceof Refused ? error : new Refused("storage");
    }
  }

  private context(account: string, session: string, key: PrKey, revision: PrRevision, permitted = false): ReviewContext {
    return { account, session, permitted, key, revision };
  }

  // --- Operations -------------------------------------------------------------------------------

  /** Drafts and receipts only, under the signed-in account: opening a PR costs no extra GitHub read. */
  private async status(key: PrKey, revision: PrRevision, session: string): Promise<WriteStatus> {
    const account = await this.account(key, false);
    const ctx = this.context(account.id, session, key, revision);
    return this.local((actions) => ({
      account, revision,
      drafts: Object.fromEntries((["comment", "review"] as const).flatMap((kind) => { const d = actions.getDraft(ctx, kind); return d ? [[kind, draftView(d)]] : []; })),
      earlier: actions.earlier(ctx).filter((d) => d.body.trim() || d.comments.length).map(earlierView),
      receipts: actions.list(ctx).slice(-RECEIPTS).map((intent) => receipt(intent, this.names.get(prKeyId(key)) ?? null)),
    }));
  }

  private async save(request: Extract<WriteRequest, { op: "save" }>, session: string): Promise<WriteDraft> {
    const account = await this.account(request.key, false);
    const ctx = this.context(account.id, session, request.key, request.revision);
    const saved = this.local((actions) => actions.saveDraft(ctx, request.kind, request.expectedVersion, request.body, request.comments));
    if (!saved) throw new Refused(request.comments.some((c) => !sameRevision(c.anchor.revision, request.revision)) ? "anchor-outdated" : "draft-conflict");
    return draftView(saved);
  }

  /** An earlier head's body into this head's draft. Its line anchors count in the old revision and stay behind. */
  private async carry(request: Extract<WriteRequest, { op: "carry" }>, session: string): Promise<WriteDraft> {
    const account = await this.account(request.key, false);
    const here = this.context(account.id, session, request.key, request.revision);
    const there = this.context(account.id, session, request.key, request.from);
    const saved = this.local((actions) => {
      const current = actions.getDraft(here, request.kind), earlier = actions.getDraft(there, request.kind);
      if (!earlier || sameRevision(request.from, request.revision)) throw new Refused("draft-empty");
      if (current && (current.body.trim() || current.comments.length)) throw new Refused("draft-conflict");
      return actions.saveDraft(here, request.kind, current?.version ?? 0, earlier.body, []);
    });
    if (!saved) throw new Refused("draft-conflict");
    return draftView(saved);
  }

  private async prepare(request: Extract<WriteRequest, { op: "prepare" }>, session: string): Promise<WritePreview> {
    const fresh = await this.fresh(request.key, true);
    this.current(fresh, request.revision);
    this.allow(fresh, request.operation);
    const ctx = this.context(fresh.account.id, session, request.key, request.revision, true);
    const kind = request.operation.kind;
    const draft = this.local((actions) => actions.getDraft(ctx, kind));
    if (!draft || draft.version !== request.draftVersion) throw new Refused("draft-conflict");
    const inlinePaths = await this.anchors(fresh, draft);
    const prepared = this.local((actions) => {
      // A newer preview replaces an unsent one, from this window or another. A send in doubt blocks the PR.
      for (const intent of actions.list(ctx)) {
        if (intent.state === "prepared") { actions.cancel(ctx, intent.id); this.previews.delete(intent.id); }
        else if (intent.state === "dispatched" || intent.state === "unknown") throw new Refused("busy");
      }
      return actions.prepare(ctx, request.operation, request.draftVersion);
    });
    if (!prepared) throw new Refused("draft-empty");
    this.previews.set(prepared.intent.id, { confirmation: prepared.confirmation, session });
    return {
      intentId: prepared.intent.id, account: fresh.account, operation: request.operation, revision: request.revision,
      destination: this.destination(fresh, request.key),
      body: draft.body, comments: draft.comments.length,
      inlineComments: draft.comments.map(({ anchor, body }, index) => ({ path: inlinePaths[index]!, side: anchor.side, start: anchor.start, end: anchor.end, body })),
    };
  }

  /** Whether Merge may be offered for the reviewed head, read now. An offer grants nothing by itself. */
  private async mergeCheck(key: PrKey, revision: PrRevision): Promise<MergeCheck> {
    const fresh = await this.fresh(key, true);
    const decision = await this.mergeable(fresh, revision);
    const destination = this.destination(fresh, key);
    if (decision.kind === "unavailable") return { kind: "unavailable", reason: decision.reason, detail: MERGE_BLOCKS[decision.reason], url: destination.url };
    return { kind: "offer", account: fresh.account, destination, revision, methods: (decision as Extract<MergePreflight, { kind: "offer" }>).methods, unstable: fresh.merge.mergeState === "unstable" };
  }

  private async prepareMerge(request: Extract<WriteRequest, { op: "prepare-merge" }>, session: string): Promise<WritePreview> {
    const fresh = await this.fresh(request.key, true);
    this.offered(await this.mergeable(fresh, request.revision), request.method);
    const operation = { kind: "merge", method: request.method } as const;
    const ctx = this.context(fresh.account.id, session, request.key, request.revision, true);
    const prepared = this.local((actions) => {
      for (const intent of actions.list(ctx)) {
        if (intent.state === "prepared") { actions.cancel(ctx, intent.id); this.previews.delete(intent.id); }
        else if (intent.state === "dispatched" || intent.state === "unknown") throw new Refused("busy");
      }
      return actions.prepare(ctx, operation);
    });
    if (!prepared) throw new Refused("storage");
    this.previews.set(prepared.intent.id, { confirmation: prepared.confirmation, session });
    return { intentId: prepared.intent.id, account: fresh.account, operation, revision: request.revision, destination: this.destination(fresh, request.key), body: "", comments: 0, inlineComments: [] };
  }

  /** A state change, an edit or a reviewer request: checked against GitHub's PR now, then previewed exactly. */
  private async prepareAction(request: Extract<WriteRequest, { op: "prepare-action" }>, session: string): Promise<WritePreview> {
    const fresh = await this.fresh(request.key, true);
    this.current(fresh, request.revision);
    this.allowAction(fresh, request.action);
    const ctx = this.context(fresh.account.id, session, request.key, request.revision, true);
    const prepared = this.local((actions) => {
      for (const intent of actions.list(ctx)) {
        if (intent.state === "prepared") { actions.cancel(ctx, intent.id); this.previews.delete(intent.id); }
        else if (intent.state === "dispatched" || intent.state === "unknown") throw new Refused("busy");
      }
      return actions.prepare(ctx, request.action);
    });
    if (!prepared) throw new Refused("storage");
    this.previews.set(prepared.intent.id, { confirmation: prepared.confirmation, session });
    return { intentId: prepared.intent.id, account: fresh.account, operation: request.action, revision: request.revision, destination: this.destination(fresh, request.key), body: "", comments: 0, inlineComments: [] };
  }

  private async submit(key: PrKey, id: string, session: string, currentDocument: () => boolean): Promise<WriteReceipt> {
    const preview = this.previews.get(id);
    if (!preview || preview.session !== session) throw new Refused("no-preview");
    const intent = this.local((actions) => actions.list(this.context(key.account, session, key, placeholder(key))).find((i) => i.id === id));
    if (!intent || intent.state !== "prepared") { this.previews.delete(id); throw new Refused("no-preview"); }
    const spend = () => {
      this.previews.delete(id);
      this.local((actions) => actions.cancel(this.context(key.account, session, key, intent.revision), id));
    };
    let fresh: Fresh, ctx: ReviewContext;
    let inlinePaths: string[] = [];
    try {
      fresh = await this.fresh(key, true);
      if (intent.operation.kind === "merge") this.offered(await this.mergeable(fresh, intent.revision), intent.operation.method);
      else if (isAction(intent.operation)) { this.current(fresh, intent.revision); this.allowAction(fresh, intent.operation); }
      else {
        this.current(fresh, intent.revision);
        this.allow(fresh, intent.operation as WriteOperation);
        if (intent.payload) inlinePaths = await this.anchors(fresh, intent.payload);
      }
      // gh's login changed after main checked it: the request could go out as someone else.
      if (this.stamp() !== fresh.stamp) throw new Refused("account-changed");
      // Recheck main-owned document authority after every asynchronous preflight read, before dispatch.
      if (!currentDocument()) throw new Refused("no-preview");
      ctx = this.context(fresh.account.id, session, key, intent.revision, true);
    } catch (error) {
      spend();
      throw error;
    }
    const permit = this.local((actions) => actions.dispatch(ctx, preview.confirmation));
    this.previews.delete(id);
    if (!permit) throw new Refused("no-preview");
    const outcome = await this.send(fresh, permit, inlinePaths);
    let settled: ReviewIntent | null = null;
    try {
      settled = this.store().complete(ctx, id, outcome);
      if (settled?.state === "confirmed" && permit.draftVersion !== null) {
        // The draft that was sent is done with; a newer edit made meanwhile is kept.
        this.store().saveDraft(ctx, permit.operation.kind as "comment" | "review", permit.draftVersion, "", []);
      }
    } catch {
      // The outcome could not be recorded: the durable receipt still says dispatched, which a restart reads as unknown.
      return receipt({ ...permit, state: "unknown" }, fresh);
    }
    return receipt(settled ?? { ...permit, state: "unknown" }, fresh);
  }

  private async cancel(key: PrKey, id: string, session: string): Promise<WriteReceipt> {
    await this.account(key, false);
    const cancelled = this.local((actions) => actions.cancel(this.context(key.account, session, key, placeholder(key)), id));
    this.previews.delete(id);
    if (!cancelled) throw new Refused("no-preview");
    return receipt(cancelled, null);
  }

  /** Reads the PR's comments or reviews back for this intent's marker, by this account. Finding none proves nothing. */
  private async reconcile(key: PrKey, id: string, session: string): Promise<WriteReceipt> {
    const fresh = await this.fresh(key, true);
    const intent = this.local((actions) => actions.list(this.context(fresh.account.id, session, key, placeholder(key))).find((i) => i.id === id));
    if (!intent) throw new Refused("no-preview");
    if (intent.state !== "unknown") return receipt(intent, fresh);
    if (intent.operation.kind === "merge") return this.reconcileMerge(fresh, intent, session);
    if (isAction(intent.operation)) return this.reconcileAction(fresh, intent, intent.operation, session);
    if (!intent.payload) return receipt(intent, fresh);
    const expected = posted(intent.payload.body, intent.id);
    const review = intent.operation.kind === "review";
    const base = `repos/${enc(fresh.owner)}/${enc(fresh.name)}/${review ? "pulls" : "issues"}/${key.number}/${review ? "reviews" : "comments"}`;
    let found: string | null = null;
    for (let page = 1; page <= READ_BACK_PAGES && !found; page++) {
      const rows = json((await this.get(`${base}?per_page=${PAGE}&page=${page}`, 8 * MB)).body);
      if (!Array.isArray(rows)) throw new Refused("failed");
      for (const raw of rows) {
        const row = raw as { id?: unknown; user?: { id?: unknown }; body?: unknown; commit_id?: unknown };
        if (String(row?.user?.id) !== fresh.account.id || typeof row.body !== "string" || !Number.isSafeInteger(row.id)) continue;
        if (review && row.commit_id !== intent.revision.headSha) continue;
        if (row.body.replace(/\r\n/g, "\n") === expected) { found = String(row.id); break; }
      }
      if (rows.length < PAGE) break;
    }
    if (!found) return receipt(intent, fresh);
    const reconciled = this.local((actions) => actions.reconcile(this.context(fresh.account.id, session, key, intent.revision), id,
      { kind: "matched", key: intent.key, revision: intent.revision, digest: intent.digest, remoteId: found! }));
    return receipt(reconciled ?? intent, fresh);
  }

  /**
   * A merge is ours only if GitHub says the PR merged, by this account, at the head it was asked to merge.
   * Merged by someone else, or not merged, proves nothing about the request: it stays unknown.
   */
  private async reconcileMerge(fresh: Fresh, intent: ReviewIntent, session: string): Promise<WriteReceipt> {
    const raw = json((await this.get(`repos/${enc(fresh.owner)}/${enc(fresh.name)}/pulls/${intent.key.number}`, 4 * MB)).body) as
      { merged?: unknown; merged_by?: { id?: unknown } | null; merge_commit_sha?: unknown; head?: { sha?: unknown } } | undefined;
    const sha = raw?.merge_commit_sha;
    if (raw?.merged !== true || String(raw.merged_by?.id) !== fresh.account.id || raw.head?.sha !== intent.revision.headSha || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return receipt(intent, fresh);
    const reconciled = this.local((actions) => actions.reconcile(this.context(fresh.account.id, session, intent.key, intent.revision), intent.id,
      { kind: "matched", key: intent.key, revision: intent.revision, digest: intent.digest, remoteId: sha }));
    return receipt(reconciled ?? intent, fresh);
  }

  /**
   * A state change, an edit or a reviewer request is confirmed when the PR, read now, shows exactly what was
   * asked. That shows the outcome, not who caused it: someone else may have made the same change.
   */
  private async reconcileAction(fresh: Fresh, intent: ReviewIntent, action: PrAction, session: string): Promise<WriteReceipt> {
    const raw = json((await this.get(`repos/${enc(fresh.owner)}/${enc(fresh.name)}/pulls/${intent.key.number}`, 4 * MB)).body) as RawPull | undefined;
    if (!raw || typeof raw.updated_at !== "string" || !reached(raw, action)) return receipt(intent, fresh);
    const reconciled = this.local((actions) => actions.reconcile(this.context(fresh.account.id, session, intent.key, intent.revision), intent.id,
      { kind: "matched", key: intent.key, revision: intent.revision, digest: intent.digest, remoteId: `${action.kind}@${raw.updated_at}` }));
    return receipt(reconciled ?? intent, fresh);
  }

  private async abandon(key: PrKey, id: string, session: string): Promise<WriteReceipt> {
    await this.account(key, true);
    const abandoned = this.local((actions) => actions.abandon(this.context(key.account, session, key, placeholder(key)), id));
    if (!abandoned) throw new Refused("no-preview");
    return receipt(abandoned, null);
  }

  // --- Checks -----------------------------------------------------------------------------------

  /** The revision the person reviewed must still be the PR's. */
  private current(fresh: Fresh, revision: PrRevision): void {
    if (fresh.pr.revision.headSha !== revision.headSha) throw new Refused("head-changed");
    if (!sameRevision(fresh.pr.revision, revision)) throw new Refused("target-changed");
  }

  /** What this account may do here, from main's own reads. Unreadable permission is refusal, never permission. */
  private allow(fresh: Fresh, operation: WriteOperation): void {
    if (!fresh.permissions || fresh.locked === null) throw new Refused("permission-unknown");
    if (!fresh.permissions.pull) throw new Refused("denied");
    if (operation.kind === "review" && (fresh.pr.state === "closed" || fresh.pr.state === "merged")) throw new Refused("not-open");
    if (fresh.locked && !fresh.permissions.push) throw new Refused("locked");
    if (operation.kind === "review" && operation.event !== "COMMENT" && fresh.pr.author.id === fresh.account.id) throw new Refused("self-review");
  }

  /**
   * Merging needs push permission, read now, and `mergePreflight`'s offer from GitHub's own state. Check counts
   * and model findings are not inputs. A moved head or target, or another account, asks for a new review.
   */
  private async mergeable(fresh: Fresh, revision: PrRevision): Promise<MergePreflight> {
    if (!fresh.permissions) throw new Refused("permission-unknown");
    if (!fresh.permissions.push) throw new Refused("denied");
    const facts: MergeFacts = { key: fresh.key, revision: fresh.pr.revision, state: fresh.pr.state, ...fresh.merge, queue: await this.queue(fresh) };
    const decision = mergePreflight({ key: fresh.key, revision }, facts);
    if (decision.kind === "reconfirm") throw new Refused(decision.reason === "head-changed" ? "head-changed" : decision.reason === "target-changed" ? "target-changed" : "account-changed");
    return decision;
  }

  /** Only a method the fresh offer contains may be previewed or sent. */
  private offered(decision: MergePreflight, method: MergeMethod): void {
    if (decision.kind === "unavailable") throw new Refused("merge-unavailable", MERGE_BLOCKS[decision.reason]);
    if (decision.kind !== "offer" || !decision.methods.includes(method)) throw new Refused("merge-unavailable", MERGE_BLOCKS["no-methods"]);
  }

  /**
   * Whether the target branch merges through a queue, from its rulesets. null when unreadable or when the
   * listing may be cut short. Classic branch protection's queue setting isn't readable here; GitHub refuses
   * a direct merge then, and the outcome is shown as a refusal.
   */
  private async queue(fresh: Fresh): Promise<MergeFacts["queue"]> {
    const branch = fresh.pr.revision.baseRef;
    if (branch.includes("..")) return null;
    let rows: unknown;
    try {
      rows = json((await this.get(`repos/${enc(fresh.owner)}/${enc(fresh.name)}/rules/branches/${enc(branch)}?per_page=100&page=1`, 2 * MB)).body);
    } catch (error) {
      if (error instanceof Refused && ["no-cli", "signed-out", "offline", "timeout"].includes(error.reason)) throw error;
      return null;
    }
    if (!Array.isArray(rows) || rows.length >= 100) return null;
    return rows.some((row) => (row as { type?: unknown })?.type === "merge_queue") ? "required" : "none";
  }

  private destination(fresh: Fresh, key: PrKey): WritePreview["destination"] {
    return { owner: fresh.owner, repo: fresh.name, number: key.number, url: canonicalPrUrl({ host: "github.com", owner: fresh.owner, repo: fresh.name, number: key.number }) };
  }

  /**
   * Decisions 2–4, from main's own reads. GitHub lets a PR's author change its state and edit it; otherwise
   * these need write access (triage suffices for state and reviewers). Unreadable permission is refusal.
   */
  private allowAction(fresh: Fresh, action: PrAction): void {
    const p = fresh.permissions;
    if (!p) throw new Refused("permission-unknown");
    const author = fresh.pr.author.id === fresh.account.id;
    const state = fresh.pr.state;
    switch (action.kind) {
      case "state": {
        if (!(p.push || p.triage || author)) throw new Refused("denied");
        if (!TRANSITIONS[action.to].includes(state)) throw new Refused("state-conflict");
        return;
      }
      case "edit":
        if (!(p.push || author)) throw new Refused("denied");
        // Someone else's edit since the text was read is never overwritten.
        if (fresh.pr.title !== action.expected.title || fresh.pr.body !== action.expected.body) throw new Refused("edit-conflict");
        return;
      case "reviewers": {
        if (!(p.push || p.triage)) throw new Refused("denied");
        if (state === "closed" || state === "merged") throw new Refused("not-open");
        const own = [fresh.pr.author.login, fresh.account.login].map((l) => l.toLowerCase());
        if (action.logins.some((l) => own.includes(l.toLowerCase()))) throw new Refused("reviewer-invalid");
        return;
      }
    }
  }

  /** Resolve every destination against complete provider hunks, never renderer-supplied path/range authority. */
  private async anchors(fresh: Fresh, payload: { comments: { anchor: LineAnchor }[] }): Promise<string[]> {
    if (!payload.comments.length) return [];
    const { baseSha, headSha } = fresh.pr.revision;
    const root = `repos/${enc(fresh.owner)}/${enc(fresh.name)}`;
    if (payload.comments.some((c) => c.anchor.side === "base")) {
      const answer = json((await this.get(`${root}/compare/${baseSha}...${headSha}?per_page=1&page=1`, 24 * MB)).body) as
        { base_commit?: { sha?: unknown }; merge_base_commit?: { sha?: unknown } } | undefined;
      const base = answer?.merge_base_commit?.sha;
      if (answer?.base_commit?.sha !== baseSha || typeof base !== "string") throw new Refused("failed");
      if (payload.comments.some((c) => c.anchor.side === "base" && c.anchor.commitSha !== base)) throw new Refused("anchor-outdated");
    }
    // GitHub exposes at most 3,000 PR files. An incomplete listing cannot establish a unique destination.
    if (fresh.pr.totals.files > READ_BACK_PAGES * PAGE) throw new Refused("anchor-outdated");
    const files: PrFile[] = [];
    for (let page = 1; page <= READ_BACK_PAGES; page++) {
      const rows = json((await this.get(`${root}/pulls/${fresh.key.number}/files?per_page=100&page=${page}`, 24 * MB)).body);
      if (!Array.isArray(rows) || rows.length > PAGE) throw new Refused("failed");
      for (const row of rows) {
        const file = changedFile(row);
        if (!file) throw new Refused("failed");
        files.push(file);
      }
      if (rows.length < PAGE || files.length >= fresh.pr.totals.files) break;
    }
    if (files.length !== fresh.pr.totals.files || new Set(files.map((file) => file.path)).size !== files.length) throw new Refused("anchor-outdated");
    // The files endpoint is mutable: bracket the listing with a revision check before using its evidence.
    const after = await this.fresh(fresh.key, true);
    this.current(after, fresh.pr.revision);
    return payload.comments.map(({ anchor }) => {
      const matches = files.filter((file) => (anchor.side === "base" ? file.previousPath ?? file.path : file.path) === anchor.path);
      if (matches.length !== 1 || (anchor.side === "head" && anchor.commitSha !== headSha)) throw new Refused("anchor-outdated");
      const file = matches[0]!, patch = parsePatch(file);
      const supported = patch.state === "text" && patch.complete && patch.hunks.some((hunk) => {
        const lines = hunk.rows.map((row) => anchor.side === "base" ? row.oldLine : row.newLine).filter((line): line is number => line !== null);
        return lines.includes(anchor.start) && lines.includes(anchor.end);
      });
      if (!supported) throw new Refused("anchor-outdated");
      // GitHub addresses LEFT-side comments on renamed files using the current filename too.
      return file.path;
    });
  }

  // --- GitHub -----------------------------------------------------------------------------------

  /** The signed-in account, which must be the key's. A remembered answer that disagrees is checked again, never trusted. */
  private async account(key: PrKey, force: boolean): Promise<Account> {
    let account = await this.who(force);
    if (account.id !== key.account && !force) account = await this.who(true);
    if (account.id !== key.account) throw new Refused("account-changed");
    return account;
  }

  private async who(force: boolean): Promise<Account> {
    const stamp = this.stamp();
    const known = this.identity;
    if (!force && known && this.now() - known.at < this.ttl && stamp !== null && stamp === known.stamp) return { id: known.id, login: known.login };
    const answer = await this.transport({ method: "GET", endpoint: "user", input: null, maxBytes: 256 * KB, timeoutMs: READ_TIMEOUT_MS });
    if (answer.kind !== "http") {
      if (answer.kind === "signed-out" || answer.kind === "no-cli") this.identity = null;
      throw new Refused(transportRefusal(answer.kind));
    }
    if (answer.status !== 200) {
      if (answer.status === 401) this.identity = null;
      throw new Refused(httpRefusal(answer));
    }
    const user = json(answer.body) as { id?: unknown; login?: unknown } | undefined;
    const id = typeof user?.id === "number" && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : null;
    const login = typeof user?.login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login) ? user.login : null;
    if (!id || !login) throw new Refused("failed");
    this.identity = { id, login, stamp, at: this.now() };
    return { id, login };
  }

  /**
   * The account, the repository by its stable id (with this account's permission on it), and the pull
   * request, read now. `stamp` is gh's login state from before the account was checked.
   */
  private async fresh(key: PrKey, force: boolean): Promise<Fresh> {
    const stamp = this.stamp();
    const account = await this.account(key, force);
    const raw = json((await this.get(`repositories/${key.repoId}`, MB)).body) as
      { permissions?: { pull?: unknown; push?: unknown; triage?: unknown }; allow_merge_commit?: unknown; allow_squash_merge?: unknown; allow_rebase_merge?: unknown } | undefined;
    const repo = repository(raw);
    if (!repo || repo.id !== key.repoId) throw new Refused("not-found");
    const p = raw?.permissions;
    const permissions = p && typeof p.pull === "boolean" && typeof p.push === "boolean" ? { pull: p.pull, push: p.push, triage: p.triage === true } : null;
    const rawPull = json((await this.get(`repos/${enc(repo.owner)}/${enc(repo.name)}/pulls/${key.number}`, 4 * MB)).body) as
      { locked?: unknown; mergeable?: unknown; mergeable_state?: unknown; node_id?: unknown } | undefined;
    const pr = pull(rawPull);
    if (!pr || pr.base.id !== key.repoId || pr.number !== key.number) throw new Refused("not-found");
    this.names.set(prKeyId(key), { owner: repo.owner, name: repo.name });
    const allowed = (value: unknown) => typeof value === "boolean" ? value : null;
    const methods = { merge: allowed(raw?.allow_merge_commit), squash: allowed(raw?.allow_squash_merge), rebase: allowed(raw?.allow_rebase_merge) };
    const state = rawPull?.mergeable_state;
    const merge = {
      mergeable: typeof rawPull?.mergeable === "boolean" ? rawPull.mergeable : null,
      mergeState: typeof state === "string" && (MERGE_STATES as readonly string[]).includes(state) ? state as MergeState : null,
      // Settings this account can't see come back absent: unreadable, never allowed.
      methods: Object.values(methods).every((v) => v === null) ? null : methods,
    };
    const nodeId = typeof rawPull?.node_id === "string" && /^[A-Za-z0-9_=+/-]{1,200}$/.test(rawPull.node_id) ? rawPull.node_id : null;
    return { key, account, stamp, owner: repo.owner, name: repo.name, permissions, locked: typeof rawPull?.locked === "boolean" ? rawPull.locked : null, pr, merge, nodeId };
  }

  private async get(endpoint: string, maxBytes: number): Promise<{ body: Buffer }> {
    const answer = await this.transport({ method: "GET", endpoint, input: null, maxBytes, timeoutMs: READ_TIMEOUT_MS });
    if (answer.kind !== "http") throw new Refused(transportRefusal(answer.kind));
    if (answer.status < 200 || answer.status >= 300) throw new Refused(httpRefusal(answer));
    return answer;
  }

  /**
   * The one mutation. A 2xx with an id is confirmed; an answer GitHub gave for a request it did not carry
   * out is rejected; anything else (a 5xx, a timeout, a dropped connection, an unreadable answer) may have
   * reached GitHub and is unknown.
   */
  private async send(fresh: Fresh, intent: ReviewIntent, inlinePaths: string[]): Promise<ReviewOutcome> {
    const base = `repos/${enc(fresh.owner)}/${enc(fresh.name)}`;
    if (intent.operation.kind === "merge") return this.sendMerge(base, intent, intent.operation.method);
    if (isAction(intent.operation)) return this.sendAction(fresh, base, intent, intent.operation);
    const payload = intent.payload!;
    const body = posted(payload.body, intent.id);
    const call: GhWriteCall = intent.operation.kind === "comment"
      ? { method: "POST", endpoint: `${base}/issues/${intent.key.number}/comments`, input: { body }, maxBytes: 4 * MB, timeoutMs: SEND_TIMEOUT_MS }
      : { method: "POST", endpoint: `${base}/pulls/${intent.key.number}/reviews`, maxBytes: 4 * MB, timeoutMs: SEND_TIMEOUT_MS, input: {
        commit_id: intent.revision.headSha, event: (intent.operation as { event: string }).event, body,
        comments: payload.comments.map(({ anchor, body: text }, index) => {
          const side = anchor.side === "head" ? "RIGHT" : "LEFT";
          return { path: inlinePaths[index]!, body: text, side, line: anchor.end, ...(anchor.start < anchor.end ? { start_line: anchor.start, start_side: side } : {}) };
        }),
      } };
    let answer: GhAnswer;
    try {
      answer = await this.transport(call);
    } catch {
      return { state: "unknown" };
    }
    if (answer.kind !== "http") return answer.kind === "no-cli" || answer.kind === "signed-out" ? { state: "rejected", reason: "failed" } : { state: "unknown" };
    if (answer.status >= 200 && answer.status < 300) {
      const created = json(answer.body) as { id?: unknown } | undefined;
      return typeof created?.id === "number" && Number.isSafeInteger(created.id) && created.id > 0 ? { state: "confirmed", remoteId: String(created.id) } : { state: "unknown" };
    }
    if ([401, 403, 404, 410].includes(answer.status)) return { state: "rejected", reason: "denied" };
    if ([400, 409, 422, 429].includes(answer.status)) return { state: "rejected", reason: "failed" };
    return { state: "unknown" };
  }

  /**
   * The state menu, an edit or a reviewer request: one fixed call each. A 2xx that shows the change is
   * confirmed. GraphQL answers 200 even when it did nothing: errors without data are a refusal.
   */
  private async sendAction(fresh: Fresh, base: string, intent: ReviewIntent, action: PrAction): Promise<ReviewOutcome> {
    const pull = `${base}/pulls/${intent.key.number}`;
    let call: GhWriteCall;
    if (action.kind === "state" && (action.to === "draft" || action.to === "ready")) {
      if (!fresh.nodeId) return { state: "rejected", reason: "failed" };
      call = { method: "POST", endpoint: "graphql", input: { query: DRAFT_MUTATIONS[action.to], variables: { id: fresh.nodeId } }, maxBytes: MB, timeoutMs: SEND_TIMEOUT_MS };
    } else if (action.kind === "state") {
      call = { method: "PATCH", endpoint: pull, input: { state: action.to }, maxBytes: 4 * MB, timeoutMs: SEND_TIMEOUT_MS };
    } else if (action.kind === "edit") {
      call = { method: "PATCH", endpoint: pull, input: { ...(action.title !== null ? { title: action.title } : {}), ...(action.body !== null ? { body: action.body } : {}) }, maxBytes: 4 * MB, timeoutMs: SEND_TIMEOUT_MS };
    } else {
      call = { method: "POST", endpoint: `${pull}/requested_reviewers`, input: { reviewers: action.logins }, maxBytes: 4 * MB, timeoutMs: SEND_TIMEOUT_MS };
    }
    let answer: GhAnswer;
    try {
      answer = await this.transport(call);
    } catch {
      return { state: "unknown" };
    }
    if (answer.kind !== "http") return answer.kind === "no-cli" || answer.kind === "signed-out" ? { state: "rejected", reason: "failed" } : { state: "unknown" };
    if (answer.status >= 200 && answer.status < 300) {
      const result = json(answer.body) as (RawPull & { data?: Record<string, { pullRequest?: { isDraft?: unknown; updatedAt?: unknown } } | null> | null; errors?: unknown }) | undefined;
      if (call.endpoint === "graphql") {
        const changed = result?.data ? Object.values(result.data)[0]?.pullRequest : undefined;
        if (changed && changed.isDraft === (action.kind === "state" && action.to === "draft") && typeof changed.updatedAt === "string") return { state: "confirmed", remoteId: `state@${changed.updatedAt}` };
        // Request errors omit data. A present data entry, even null, can follow execution.
        // Only recognized pre-execution refusals release the uncertainty blocker.
        const refused = result && !Object.hasOwn(result, "data") && Array.isArray(result.errors) && result.errors.length > 0
          && result.errors.every((error: unknown) => {
            if (!error || typeof error !== "object") return false;
            const item = error as { type?: unknown; message?: unknown };
            return typeof item.message === "string" && item.message.length > 0
              && ["FORBIDDEN", "GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED"].includes(String(item.type));
          });
        return refused ? { state: "rejected", reason: "failed" } : { state: "unknown" };
      }
      return result && typeof result.updated_at === "string" && reached(result, action) ? { state: "confirmed", remoteId: `${action.kind}@${result.updated_at}` } : { state: "unknown" };
    }
    if ([401, 403, 404, 410].includes(answer.status)) return { state: "rejected", reason: "denied" };
    if ([400, 409, 422, 429].includes(answer.status)) return { state: "rejected", reason: "failed" };
    return { state: "unknown" };
  }

  /**
   * `sha` is the reviewed head: GitHub refuses the merge (409) if the branch moved since. A 200 that says it
   * merged, with the merge commit, is confirmed. 405 (not mergeable now) and 409/422 are refusals.
   */
  private async sendMerge(base: string, intent: ReviewIntent, method: MergeMethod): Promise<ReviewOutcome> {
    let answer: GhAnswer;
    try {
      answer = await this.transport({ method: "PUT", endpoint: `${base}/pulls/${intent.key.number}/merge`, input: { sha: intent.revision.headSha, merge_method: method }, maxBytes: MB, timeoutMs: SEND_TIMEOUT_MS });
    } catch {
      return { state: "unknown" };
    }
    if (answer.kind !== "http") return answer.kind === "no-cli" || answer.kind === "signed-out" ? { state: "rejected", reason: "failed" } : { state: "unknown" };
    if (answer.status === 200) {
      const merged = json(answer.body) as { merged?: unknown; sha?: unknown } | undefined;
      return merged?.merged === true && typeof merged.sha === "string" && /^[0-9a-f]{40}$/.test(merged.sha) ? { state: "confirmed", remoteId: merged.sha } : { state: "unknown" };
    }
    if ([401, 403, 404, 410].includes(answer.status)) return { state: "rejected", reason: "denied" };
    if ([400, 405, 409, 422, 429].includes(answer.status)) return { state: "rejected", reason: "failed" };
    return { state: "unknown" };
  }
}

type RawPull = { state?: unknown; draft?: unknown; merged?: unknown; title?: unknown; body?: unknown; updated_at?: unknown; requested_reviewers?: unknown };
/** The PR states each change may start from: a merged PR changes no more. */
const TRANSITIONS: Record<PrStateChange, readonly PrState[]> = { closed: ["open", "draft"], open: ["closed"], draft: ["open"], ready: ["draft"] };
const isAction = (op: { kind: string }): op is PrAction => op.kind === "state" || op.kind === "edit" || op.kind === "reviewers";
/** Whether a PR as GitHub returned it shows exactly what the action asked for. */
function reached(pr: RawPull, action: PrAction): boolean {
  const text = (v: unknown) => typeof v === "string" ? v.replace(/\r\n/g, "\n") : v === null ? "" : null;
  switch (action.kind) {
    case "state":
      return action.to === "closed" ? pr.state === "closed" && pr.merged !== true
        : pr.state === "open" && (action.to === "open" || pr.draft === (action.to === "draft"));
    case "edit":
      return (action.title === null || pr.title === action.title) && (action.body === null || text(pr.body) === action.body.replace(/\r\n/g, "\n"));
    case "reviewers": {
      const requested = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers.map((r) => String((r as { login?: unknown })?.login).toLowerCase()) : [];
      return action.logins.every((l) => requested.includes(l.toLowerCase()));
    }
  }
}

const MERGE_STATES: readonly MergeState[] = ["clean", "unstable", "has_hooks", "blocked", "behind", "dirty", "draft", "unknown"];

const enc = encodeURIComponent;
/** A revision for operations that only name the PR (list, cancel, abandon): ReviewActions matches those by key. */
const placeholder = (_key: PrKey): PrRevision => ({ baseRef: "main", baseSha: "0".repeat(40), headSha: "0".repeat(40) });
const posted = (body: string, id: string) => body.trim() ? `${body}\n\n${intentMarker(id)}` : intentMarker(id);
const refuse = (reason: WriteRefusal, detail?: string): WriteResult<never> => ({ state: "refused", reason, detail: detail ?? REFUSALS[reason] });

function draftView(draft: ReviewDraft): WriteDraft {
  return { kind: draft.kind, revision: draft.revision, version: draft.version, body: draft.body, comments: draft.comments };
}
function earlierView(draft: ReviewDraft): EarlierDraft {
  return { kind: draft.kind, revision: draft.revision, version: draft.version, bodyLength: draft.body.length, comments: draft.comments.length };
}
function receipt(intent: ReviewIntent, fresh: { owner: string; name: string } | null): WriteReceipt {
  const operation = intent.operation as WriteOperation;
  const pr = fresh ? canonicalPrUrl({ host: "github.com", owner: fresh.owner, repo: fresh.name, number: intent.key.number }) : null;
  // A merge's id is its merge commit; the PR itself is the place to see it.
  const remoteUrl = intent.state !== "confirmed" || !intent.remoteId || !pr ? null
    : operation.kind === "merge" || isAction(operation) ? pr : `${pr}#${operation.kind === "comment" ? "issuecomment" : "pullrequestreview"}-${intent.remoteId}`;
  return { id: intent.id, operation, revision: intent.revision, state: intent.state, reason: intent.reason, remoteUrl };
}

function transportRefusal(kind: Exclude<GhAnswer["kind"], "http">): WriteRefusal {
  return kind === "no-cli" ? "no-cli" : kind === "signed-out" ? "signed-out" : kind === "offline" ? "offline" : kind === "timeout" ? "timeout" : "failed";
}
function httpRefusal(answer: Extract<GhAnswer, { kind: "http" }>): WriteRefusal {
  if (answer.status === 401) return "signed-out";
  if (answer.status === 429 || (answer.status === 403 && answer.headers["x-ratelimit-remaining"] === "0")) return "rate-limited";
  if (answer.status === 403) return "denied";
  if (answer.status === 404 || answer.status === 410) return "not-found";
  return "failed";
}
