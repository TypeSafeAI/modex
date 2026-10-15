import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  ImageCapability,
  ImageDraft,
  ImageJob,
} from "../../../shared/images.js";
import type { Thread, ThreadEvent } from "../../../shared/types.js";
import type { ThreadRunner } from "../runner.js";
import type { ImageStore } from "./store.js";
import { atomicJSON, boundedRead, readJSON } from "./files.js";
import { ImageAgent } from "./agent.js";
const ACTIVE = new Set(["queued", "running", "waiting-for-approval"]);
interface JobRecord extends ImageJob {
  requestId: string;
  registered?: Record<string, string>;
}
interface Document {
  version: 1;
  capabilities: ImageCapability[];
  jobs: JobRecord[];
  draft: ImageDraft;
}
const empty: ImageDraft = { prompt: "", capabilityId: "", referenceIds: [] };
export class ImageJobs {
  private root: string;
  private file: string;
  private data: Document;
  private active?: Promise<void>;
  private stopped = false;
  private readonly agent = new ImageAgent();
  constructor(
    private readonly o: {
      home: string;
      images: ImageStore;
      runner: () => ThreadRunner;
      validate(capability: ImageCapability): Promise<void>;
      projectExists(id: string): boolean;
      changed(): void;
      demo?: boolean;
    },
  ) {
    this.root = path.join(fs.realpathSync(o.home), "image-jobs");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.file = path.join(o.home, "images", "jobs.json");
    this.data = readJSON<Document>(this.file, {
      version: 1,
      capabilities: [],
      jobs: [],
      draft: empty,
    });
    if (
      this.data.version !== 1 ||
      !Array.isArray(this.data.capabilities) ||
      !Array.isArray(this.data.jobs) ||
      !this.data.draft ||
      this.data.jobs.some(
        (j) =>
          !/^[a-f0-9-]{36}$/.test(j.id) ||
          !Array.isArray(j.referenceIds) ||
          !Array.isArray(j.outputIds) ||
          !j.capability ||
          ![
            ...ACTIVE,
            "succeeded",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(j.status),
      )
    )
      throw new Error(
        "Saved image jobs are unreadable. Original data preserved.",
      );
    let changed = false;
    for (const job of this.data.jobs)
      if (ACTIVE.has(job.status)) {
        job.status = "interrupted";
        job.error =
          "Modex restarted. Check saved outputs before explicitly retrying.";
        changed = true;
      }
    if (changed) this.save();
  }
  private save(next: Document = this.data) {
    atomicJSON(this.file, next);
    this.data = next;
    this.o.changed();
  }
  private public(job: JobRecord): ImageJob {
    const { requestId: _request, registered: _registered, ...result } = job;
    return structuredClone(result);
  }
  list() {
    return this.data.jobs
      .slice()
      .reverse()
      .map((j) => this.public(j));
  }
  capabilities() {
    return structuredClone(this.data.capabilities);
  }
  bind(input: Omit<ImageCapability, "id" | "verifiedVersion">) {
    if (
      !["claude", "codex"].includes(input.runtime) ||
      typeof input.pluginId !== "string" ||
      !input.pluginId ||
      input.pluginId.length > 300 ||
      typeof input.pluginVersion !== "string" ||
      typeof input.label !== "string" ||
      input.label.length > 200 ||
      typeof input.edit !== "boolean" ||
      typeof input.entrypoint !== "string" ||
      !/^[A-Za-z0-9_:/@.\-]{1,160}$/.test(input.entrypoint) ||
      (input.account && input.account !== "cli")
    )
      throw new Error("Choose a native CLI image skill and valid entrypoint.");
    const capability: ImageCapability = { ...input, id: randomUUID() };
    this.save({ ...this.data, capabilities: [...this.data.capabilities, capability] });
    return capability;
  }
  unbind(id: string) {
    if (
      this.data.jobs.some((j) => ACTIVE.has(j.status) && j.capabilityId === id)
    )
      throw new Error("Finish this provider's jobs first.");
    this.save({ ...this.data, capabilities: this.data.capabilities.filter((c) => c.id !== id) });
  }
  draft() {
    return structuredClone(this.data.draft);
  }
  saveDraft(input: ImageDraft) {
    this.validateDraft(input, false);
    this.save({ ...this.data, draft: { ...input, referenceIds: [...input.referenceIds] } });
  }
  private validateDraft(input: ImageDraft, submitting: boolean) {
    if (
      !input ||
      typeof input.prompt !== "string" ||
      input.prompt.length > 16000 ||
      (submitting && !input.prompt.trim()) ||
      typeof input.capabilityId !== "string" ||
      !Array.isArray(input.referenceIds) ||
      input.referenceIds.length > 20 ||
      input.referenceIds.some((id) => typeof id !== "string")
    )
      throw new Error(
        "Enter a prompt (up to 16,000 characters) and at most 20 references.",
      );
    if (input.projectId && !this.o.projectExists(input.projectId))
      throw new Error("Project no longer exists.");
    for (const id of input.referenceIds) {
      const asset = this.o.images.get(id);
      if (asset.trashedAt)
        throw new Error("Restore reference images before using them.");
      if (submitting && asset.size > 5 * 1024 * 1024)
        throw new Error(`${asset.name} exceeds the 5 MiB reference limit.`);
    }
  }
  submit(input: ImageDraft & { requestId: string }, retryOf?: string) {
    if (this.stopped) throw new Error("Image generation is shutting down.");
    if (
      typeof input.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.requestId)
    )
      throw new Error("Invalid submission ID.");
    const prior = this.data.jobs.find((j) => j.requestId === input.requestId);
    if (prior) return this.public(prior);
    this.validateDraft(input, true);
    const capability = this.data.capabilities.find(
      (c) => c.id === input.capabilityId,
    );
    if (!capability)
      throw new Error("Choose an image plugin in Plugins first.");
    if (input.referenceIds.length && !capability.edit)
      throw new Error(
        "This image skill has not been configured for reference images or edits.",
      );
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      requestId: input.requestId,
      prompt: input.prompt,
      capabilityId: capability.id,
      referenceIds: [...input.referenceIds],
      projectId: input.projectId,
      capability: structuredClone(capability),
      status: "queued",
      outputIds: [],
      createdAt: now,
      updatedAt: now,
      retryOf,
    };
    this.save({ ...this.data, jobs: [...this.data.jobs, job] });
    queueMicrotask(() => this.pump());
    return this.public(job);
  }
  retry(id: string, requestId: string) {
    const job = this.find(id);
    if (ACTIVE.has(job.status)) throw new Error("This job is still active.");
    return this.submit({ ...job, requestId }, id);
  }
  cancel(id: string) {
    const job = this.find(id);
    if (!ACTIVE.has(job.status)) return;
    try {
      this.patch(job, { status: "cancelled" });
    } finally {
      // Cancellation must revoke output registration and stop execution even if disk writes fail.
      job.status = "cancelled";
      if (job.threadId) this.o.runner().stop(job.threadId);
    }
  }
  private find(id: string) {
    const job = this.data.jobs.find((j) => j.id === id);
    if (!job) throw new Error("Unknown image job.");
    return job;
  }
  items(id: string) {
    const job = this.find(id);
    return job.threadId ? this.o.runner().items(job.threadId) : [];
  }
  answer(id: string, itemId: string, answer: "yes" | "no") {
    if (!["yes", "no"].includes(answer)) throw new Error("Invalid answer.");
    const job = this.find(id);
    if (!job.threadId || !ACTIVE.has(job.status))
      throw new Error("Job is no longer active.");
    this.o.runner().answer(job.threadId, itemId, answer);
  }
  referenced(id: string) {
    return (
      this.data.draft.referenceIds.includes(id) ||
      this.data.jobs.some(
        (j) =>
          ACTIVE.has(j.status) &&
          (j.referenceIds.includes(id) || j.outputIds.includes(id)),
      )
    );
  }
  busy() {
    return (
      Boolean(this.active) || this.data.jobs.some((j) => ACTIVE.has(j.status))
    );
  }
  outcome(id: string, status: string) {
    const job = this.find(id);
    if (status === "interrupted" && ACTIVE.has(job.status))
      this.patch(job, {
        status: "interrupted",
        error: "Execution stopped. Any saved outputs remain available.",
      });
  }
  onThreadEvent(event: ThreadEvent) {
    if (event.type !== "status") return;
    const job = this.data.jobs.find(
      (j) => j.threadId === event.threadId && ACTIVE.has(j.status),
    );
    if (!job) return;
    if (event.status === "waiting")
      this.patch(job, { status: "waiting-for-approval" });
    else if (event.status === "running") this.patch(job, { status: "running" });
  }
  private patch(job: JobRecord, patch: Partial<JobRecord>) {
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    atomicJSON(this.file, { ...this.data, jobs: this.data.jobs.map(j => j === job ? next : j) });
    Object.assign(job, next);
    this.o.changed();
  }
  directory(id: string) {
    return path.join(this.root, id);
  }
  async prepare(thread: Thread, signal: AbortSignal) {
    const job = this.data.jobs.find(
      (j) => j.id === thread.imageJobId && j.threadId === thread.id,
    );
    if (!job || !ACTIVE.has(job.status)) return undefined;
    return this.agent.prepare(
      (file) => this.register(job, file),
      `Use the selected image skill. Save image outputs inside ${path.join(this.directory(job.id), "output")}, then call modex_images.register with each relative output filename. Never write Modex metadata or claim success without a registered image.`,
      signal,
    );
  }
  private register(job: JobRecord, file: string) {
    if (!ACTIVE.has(job.status)) throw new Error("Image job ended.");
    if (
      typeof file !== "string" ||
      file.length > 500 ||
      !file ||
      path.isAbsolute(file) ||
      file.split(/[\\/]/).some((p) => p === ".." || p === "." || !p)
    )
      throw new Error("Use a relative output filename.");
    const root = path.join(this.directory(job.id), "output");
    if (fs.realpathSync(root) !== root)
      throw new Error("Image output directory changed or contains symlinks.");
    const bytes = boundedRead(path.join(root, file), root);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (job.registered?.[digest])
      return this.o.images.get(job.registered[digest]!);
    const asset = this.o.images.add(bytes, path.basename(file), {
      source: "generated",
      jobId: job.id,
      parentIds: job.referenceIds,
      projectId: job.projectId,
      prompt: job.prompt,
    });
    this.patch(job, {
      outputIds: [...job.outputIds, asset.id],
      registered: { ...job.registered, [digest]: asset.id },
    });
    return asset;
  }
  private pump() {
    if (this.active || this.stopped) return;
    const job = this.data.jobs.find((j) => j.status === "queued");
    if (!job) return;
    this.active = this.run(job)
      .catch((error) => {
        if (ACTIVE.has(job.status)) {
          const failure = { status: "failed" as const, error: (error as Error).message };
          try { this.patch(job, failure); }
          catch {
            // Stop the queue if terminal state cannot be persisted. Startup recovery
            // marks the last durable active state interrupted; it never replays it.
            Object.assign(job, failure);
            this.stopped = true;
            this.o.changed();
          }
        }
      })
      .finally(() => {
        this.active = undefined;
        this.pump();
      });
  }
  private async run(job: JobRecord) {
    await this.o.validate(job.capability);
    if (job.status !== "queued" || this.stopped) return;
    this.validateDraft(job, true);
    const dir = this.directory(job.id);
    fs.mkdirSync(path.join(dir, "output"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "references"), { mode: 0o700 });
    const files = job.referenceIds.map((id, index) => {
      const asset = this.o.images.get(id);
      const name = `${index + 1}.${asset.mime.split("/")[1]}`;
      const target = path.join(dir, "references", name);
      fs.writeFileSync(target, this.o.images.bytes(id), {
        mode: 0o600,
        flag: "wx",
      });
      return target;
    });
    const thread = await this.o
      .runner()
      .createImageThread(
        dir,
        job.id,
        this.o.demo ? "mock" : job.capability.runtime,
        job.capability.account ?? "cli",
      );
    this.patch(job, { threadId: thread.id });
    if (job.status !== "queued" || this.stopped) return;
    this.patch(job, { status: "running" });
    const prompt = `Use the installed image skill ${job.capability.entrypoint} from ${job.capability.pluginId}. ${job.referenceIds.length ? "Edit using the supplied reference images; preserve originals." : "Generate a new image."}\n\n${job.prompt}\n\nReferences: ${files.length ? files.join("\n") : "none"}\nSave completed images in ${path.join(dir, "output")} and register each with modex_images.register. Do not modify any other project or install tools. Report unavailable capabilities honestly.`;
    await this.o.runner().send(thread.id, prompt);
    if (this.stopped || !ACTIVE.has(job.status)) return;
    const failed = this.o.runner().status(thread.id) === "error";
    if (failed || !job.outputIds.length) {
      this.patch(job, {
        status: "failed",
        error: failed
          ? "Image execution failed. Review the transcript; any saved outputs remain available."
          : "The plugin returned no registered images. Review the transcript before retrying.",
      });
      return;
    }
    const binding = this.data.capabilities.find(
      (c) => c.id === job.capabilityId,
    );
    if (binding && binding.pluginVersion === job.capability.pluginVersion)
      binding.verifiedVersion = binding.pluginVersion;
    this.patch(job, { status: "succeeded" });
  }
  async dispose() {
    this.stopped = true;
    for (const job of this.data.jobs)
      if (ACTIVE.has(job.status)) {
        try {
          this.patch(job, { status: "interrupted", error: "Modex closed during generation. Retry explicitly." });
        } catch { job.status = "interrupted"; }
        finally { if (job.threadId) this.o.runner().stop(job.threadId); }
      }
    await this.active;
    await this.agent.dispose();
  }
}
