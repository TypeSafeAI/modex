import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FakeProcess } from "./fakeproc.js";

// Sanitized captures from real CLI runs (see test/fixtures/conversation/README.md). Replaying them
// tests the adapters against bytes the CLIs really sent; it is not live-provider acceptance.
export const FIXTURES = fileURLToPath(new URL("../../test/fixtures/conversation/", import.meta.url));
export const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8").split("\n").filter((l) => l.trim());
export const CODEX_THREAD = "01a14da2-063a-77a3-9092-0e3543b84bd0";
export const CLAUDE_SESSION = "852a2cd1-6453-4922-802d-193d60be6980";

/** Writes `text` to the fake CLI's stdout in chunks of 1, 2, 3, 5 and 7 bytes, splitting UTF-8 sequences and JSON lines. */
export async function trickle(proc: FakeProcess, text: string): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  const sizes = [1, 2, 3, 5, 7];
  for (let at = 0, n = 0; at < bytes.length; n++) {
    const size = sizes[n % sizes.length]!;
    proc.stdout.write(bytes.subarray(at, at + size));
    at += size;
    if (n % 16 === 0) await new Promise((r) => setImmediate(r));
  }
}

/**
 * Plays a captured app-server stream to CodexBackend. Setup requests are answered with the capture's
 * own thread and turn ids; each server request (an approval) waits for Modex's reply before the next line.
 */
export function codexServer(proc: FakeProcess, lines: string[], opts: { split?: boolean; close?: number } = {}) {
  const turnId = (lines.map((l) => JSON.parse(l) as { method?: string; params?: { turn?: { id?: string } } }).find((m) => m.method === "turn/started")?.params?.turn?.id) ?? "turn-1";
  const threadId = (JSON.parse(lines[0]!) as { params?: { threadId?: string; thread?: { id?: string } } }).params;
  const tid = threadId?.threadId ?? threadId?.thread?.id ?? CODEX_THREAD;
  let played: Promise<void> | null = null;
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fixture/0.163.0" } });
      else if (msg.method === "thread/start" || msg.method === "thread/resume") proc.emitLine({ id: msg.id, result: { thread: { id: tid } } });
      else if (msg.method === "turn/start") {
        proc.emitLine({ id: msg.id, result: { turn: { id: turnId } } });
        played ??= (async () => {
          for (const raw of lines) {
            const m = JSON.parse(raw) as { id?: number; method?: string };
            if (opts.split) await trickle(proc, raw + "\n"); else proc.stdout.write(raw + "\n");
            if (m.id !== undefined && m.method) await proc.waitFor((l) => { const r = JSON.parse(l) as { id?: number; result?: unknown }; return r.id === m.id && r.result !== undefined; }, 5000);
          }
          if (opts.close !== undefined) proc.close(opts.close);
        })();
      }
    }
  });
}

/** Plays a captured `claude -p` stream. Each `control_request` waits for Modex's `control_response`. */
export async function claudeStream(proc: FakeProcess, lines: string[], opts: { split?: boolean } = {}): Promise<void> {
  await proc.waitFor((l) => l.includes('"type":"user"'));
  for (const raw of lines) {
    const m = JSON.parse(raw) as { type: string; request_id?: string };
    if (opts.split) await trickle(proc, raw + "\n"); else proc.stdout.write(raw + "\n");
    if (m.type === "control_request") await proc.waitFor((l) => l.includes('"control_response"') && l.includes(m.request_id!), 5000);
  }
  proc.close(0);
}

