import type { Observation } from "../../shared/conversation-events.js";
import type { Exec } from "../../shared/evidence.js";
import type { TurnSink } from "./backends/types.js";

export interface NativeContextInput { args?: Record<string, unknown>; exec?: Exec }
const MASK = "[private connection]";
// A bare eight-character hex prefix is an ordinary identifier/digest fragment, not a UUID-shaped secret.
const PRIVATE_PREFIX = 9;
type Delta = Extract<Observation, { type: "message.delta" | "reasoning.delta" }>;
interface Pending { text: string; emit(text: string): void }

/** Literal main-owned connection values only. Shared history is bounded and never persisted. */
export class ContextPrivacy {
  private readonly pending = new Map<string, Pending>();
  private readonly originals = new WeakMap<Observation, NativeContextInput>();
  private readonly seen = new Set<string>();
  private values: string[];
  private bytes: number;
  private closed = false;
  constructor(private readonly known: Set<string>) {
    this.values = [...known].sort((a, b) => b.length - a.length);
    this.bytes = this.values.reduce((sum, value) => sum + Buffer.byteLength(value) + 64, 0);
  }
  addConnection(url: string): void {
    const values = [url];
    try { const token = new URL(url).pathname.split("/").at(-1); if (token && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token)) values.push(token); } catch { /* An exact opaque fixture URL is still protected. */ }
    const fresh = values.filter(value => value && !this.known.has(value));
    const bytes = fresh.reduce((sum, value) => sum + Buffer.byteLength(value) + 64, 0);
    if (this.bytes + bytes > 2 * 1024 * 1024) throw new Error("This thread's private connection registry is full. Restart Modex before continuing.");
    for (const value of fresh) this.known.add(value);
    this.bytes += bytes; this.values = [...this.known].sort((a, b) => b.length - a.length);
  }
  contains(value: unknown): boolean {
    const sensitive = (text: string) => this.values.some(secret => text.includes(secret)) || this.prefix(text) >= PRIVATE_PREFIX;
    if (typeof value === "string") return sensitive(value);
    let found = false;
    JSON.stringify(value, (key, item: unknown) => { if (sensitive(key) || (typeof item === "string" && sensitive(item))) found = true; return item; });
    return found;
  }
  private replace(value: string): string { for (const secret of this.values) value = value.split(secret).join(MASK); return value; }
  text(value: string): string {
    const text = this.replace(value), held = this.prefix(text);
    return held >= PRIVATE_PREFIX ? text.slice(0, -held) + MASK : text;
  }
  redact<T>(value: T): T {
    if (value === undefined || !this.values.length) return value;
    const encoded = JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? this.text(item) : item);
    return JSON.parse(this.replace(encoded)) as T;
  }
  original(event: Observation): NativeContextInput | undefined { return this.originals.get(event); }
  error(value: unknown): Error {
    const message = value instanceof Error ? value.message : String(value), safe = this.text(message);
    return value instanceof Error && safe === message ? value : new Error(safe);
  }
  private prefix(text: string): number {
    let held = 0;
    for (const secret of this.values) {
      for (let length = Math.min(secret.length - 1, text.length); length > held; length--) {
        if (text.endsWith(secret.slice(0, length))) { held = length; break; }
      }
    }
    return held;
  }
  private push(key: string, chunk: string, emit: Pending["emit"]): void {
    const text = this.replace((this.pending.get(key)?.text ?? "") + chunk), held = this.prefix(text);
    if (held) this.pending.set(key, { text: text.slice(-held), emit }); else this.pending.delete(key);
    const safe = text.slice(0, text.length - held); if (safe) emit(safe);
  }
  private flush(key: string): void {
    const pending = this.pending.get(key); if (!pending) return; this.pending.delete(key);
    // Preserve ordinary short text; suppress long incomplete credential prefixes at a terminal boundary.
    pending.emit(pending.text.length >= PRIVATE_PREFIX ? MASK : pending.text);
  }
  finish(): void { if (this.closed) return; this.closed = true; for (const key of [...this.pending.keys()]) this.flush(key); }
  wrap(sink: TurnSink): TurnSink {
    let tail = 0;
    return {
      ...sink,
      observe: event => {
        if (this.closed) return;
        const native = JSON.stringify(event.native);
        if (event.source) { const id = JSON.stringify([event.native.runtime, event.source]); if (this.seen.has(id)) return; this.seen.add(id); }
        // Native identities remain exact or unavailable; never replace them with invented redacted identities.
        if (this.contains(event.native) || (event.source && this.contains(event.source))) return;
        if (event.type === "message.delta" || event.type === "reasoning.delta") {
          const template: Delta = { ...event, text: "" };
          const key = `${native}:${event.type}:${event.type === "reasoning.delta" ? `${event.representation}:${event.index}` : ""}`;
          this.push(key, event.text, text => sink.observe({ ...template, text, ...(template.source ? { source: `${template.source}:private-stream:${++tail}` } : {}) }));
          return;
        }
        if (event.type === "message.done" || event.type === "reasoning.done") for (const key of [...this.pending.keys()]) if (key.startsWith(`${native}:`)) this.flush(key);
        if (event.type === "tool.done") this.flush(`${native}:output`);
        let safe = this.redact(event);
        if (event.type === "tool.start" && safe.type === "tool.start" && this.contains({ args: event.tool.args, exec: event.tool.exec, title: event.tool.title })) safe = { ...safe, tool: { ...safe.tool, displayOnlyInputs: true } };
        if ((event.type === "tool.update" || event.type === "tool.done") && (safe.type === "tool.update" || safe.type === "tool.done")
          && this.contains({ args: event.progress?.args, title: event.progress?.title })) safe = { ...safe, progress: { ...safe.progress, displayOnlyInputs: true } };
        if (safe.type === "tool.update" && safe.progress.output !== undefined) {
          const output = safe.progress.output, held = this.prefix(output);
          safe = { ...safe, progress: { ...safe.progress, output: output.slice(0, output.length - held) } };
        }
        const original = event.type === "tool.start" ? { args: event.tool.args, exec: event.tool.exec } : event.type === "tool.done" ? { args: event.progress?.args } : undefined;
        if (original) this.originals.set(safe, original);
        try { sink.observe(safe); } finally { this.originals.delete(safe); }
      },
      ...(sink.output ? { output: (native, chunk) => { if (!this.closed && !this.contains(native)) this.push(`${JSON.stringify(native)}:output`, chunk, text => sink.output!(native, text)); } } : {}),
      notice: (level, text) => { if (!this.closed) sink.notice(level, this.text(text)); },
      session: handle => { if (this.closed) return; if (this.contains(handle)) sink.notice("warn", "The native session identifier contained a private connection and was not saved."); else sink.session(handle); },
      approval: async (request, signal) => {
        if (this.closed) return "no";
        if (!this.contains(request)) return sink.approval(request, signal);
        sink.notice("warn", "The native action contained a private connection and was refused."); return "no";
      },
      refusedByRule: request => this.closed ? undefined : this.contains(request) ? "The action contains a private connection." : sink.refusedByRule?.(request),
      ...(sink.deliverRequest ? { deliverRequest: async (native, write) => { if (!this.closed) await sink.deliverRequest!(native, write); } } : {}),
      ...(sink.question ? { question: async (request, signal) => {
        if (this.closed) return { withdrawn: "ended" as const };
        if (!this.contains(request)) return sink.question!(request, signal);
        sink.notice("warn", "The native question contained a private connection and was withdrawn."); return { withdrawn: "ended" as const };
      } } : {}),
    };
  }
}
