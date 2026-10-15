import type { TurnResult, TurnUsage } from "./types.js";

/** One model call's input, split the way both CLIs report it. */
export interface CallInput {
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** A Claude API call's input from an `assistant` message's `message.usage`. */
export function claudeCall(u: { input_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown }): CallInput {
  return { cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens), uncached: count(u.input_tokens) };
}

/** A Codex response's input from `tokenUsage.last`; `inputTokens` already includes cached and written tokens. */
export function codexCall(b: { inputTokens?: unknown; cachedInputTokens?: unknown; cacheWriteInputTokens?: unknown }): CallInput {
  const cacheRead = count(b.cachedInputTokens);
  const cacheWrite = count(b.cacheWriteInputTokens);
  return { cacheRead, cacheWrite, uncached: Math.max(0, count(b.inputTokens) - cacheRead - cacheWrite) };
}

/** Collects one turn's model calls into a `TurnUsage`. A call whose id was already counted is ignored. */
export class UsageMeter {
  private readonly seen = new Set<string>();
  private first?: CallInput;
  private last?: CallInput;
  private calls = 0;
  private output?: number;
  private readonly sum = { input: 0, cached: 0, cacheWrite: 0 };

  call(input: CallInput, id?: string): void {
    if (id !== undefined) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
    }
    this.calls++;
    this.first ??= input;
    this.last = input;
    this.sum.input += input.uncached;
    this.sum.cached += input.cacheRead;
    this.sum.cacheWrite += input.cacheWrite;
  }

  /** Adds output tokens the CLI reported for part of the turn. */
  addOutput(tokens: unknown): void {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return;
    this.output = (this.output ?? 0) + Math.round(tokens);
  }

  usage(): TurnUsage | undefined {
    if (!this.first || !this.last) return undefined;
    const { cacheRead, cacheWrite, uncached } = this.last;
    return { first: { ...this.first }, contextTokens: cacheRead + cacheWrite + uncached, ...(this.output !== undefined ? { outputTokens: this.output } : {}), calls: this.calls, totals: { ...this.sum } };
  }
}

/** `result` with the turn's usage attached when the meter saw at least one model call. */
export function withUsage(result: TurnResult, meter: UsageMeter): TurnResult {
  const usage = meter.usage();
  return usage ? { ...result, usage } : result;
}
