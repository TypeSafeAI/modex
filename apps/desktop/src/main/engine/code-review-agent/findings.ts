import { randomUUID } from "node:crypto";
import type { LineAnchor, PrFile, PrKey, PrRevision } from "../../../shared/code-review.js";
import { parsePatch } from "../../../shared/code-review-patch.js";
import { AGENT_LIMITS, SEVERITIES, agentText, type AgentFinding, type FindingSeverity } from "../../../shared/code-review-agent.js";

/**
 * CR-6 (#325): findings are read back from the CLI's reply, bounded, and bound to the snapshot. A finding that
 * names a path and head-side lines main can find in the included patches gets CR-5's anchor; one that names a
 * place main cannot find stays `unverified`, with no anchor invented. The model's text is never authority.
 */
export interface RawFinding { title: string; detail: string; severity: FindingSeverity; path: string | null; line: number | null; endLine: number | null }

const FENCE = "```json";
const BLOCK = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/;

/** The reply without its findings block, and the block parsed. `malformed` when a block was there but unreadable. */
export function extractFindings(reply: string): { text: string; findings: RawFinding[]; malformed: boolean } {
  const trimmed = reply.trimEnd();
  // Only the final fence is the findings block: a reply may quote JSON earlier, and that quote stays text.
  const at = trimmed.lastIndexOf(FENCE);
  const match = at < 0 ? null : BLOCK.exec(trimmed.slice(at));
  if (!match) return { text: reply, findings: [], malformed: false };
  const text = trimmed.slice(0, at).trimEnd();
  let parsed: unknown;
  try { parsed = JSON.parse(match[1]!); } catch { return { text, findings: [], malformed: true }; }
  const list = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { findings?: unknown }).findings : undefined;
  if (!Array.isArray(list)) return { text, findings: [], malformed: true };
  const findings: RawFinding[] = [];
  let malformed = false;
  for (const item of list) {
    const finding = rawFinding(item);
    if (!finding) { malformed = true; continue; }
    if (findings.length < AGENT_LIMITS.findings) findings.push(finding);
  }
  return { text, findings, malformed };
}

function rawFinding(value: unknown): RawFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const title = agentText(v.title, AGENT_LIMITS.findingTitle, false);
  const detail = agentText(v.detail ?? "", AGENT_LIMITS.findingDetail, true);
  if (title === null || detail === null) return null;
  const severity = SEVERITIES.includes(v.severity as FindingSeverity) ? (v.severity as FindingSeverity) : "note";
  const path = v.path === null || v.path === undefined ? null : agentText(v.path, 1024, false);
  if (path === null && v.path !== null && v.path !== undefined) return null;
  const line = lineNumber(v.line), endLine = lineNumber(v.endLine);
  if (line === undefined || endLine === undefined) return null;
  return { title: title.replace(/\s+/g, " ").trim(), detail, severity, path, line, endLine: endLine !== null && line !== null && endLine >= line ? endLine : null };
}

function lineNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10_000_000 ? (value as number) : undefined;
}

/** The head-side line numbers each included patch shows, by repository path. */
export function headLines(files: PrFile[]): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch.kind !== "text") continue;
    const shown = new Set<number>();
    for (const hunk of parsePatch(file).hunks) for (const row of hunk.rows) if (row.newLine !== null) shown.add(row.newLine);
    if (shown.size) lines.set(file.path, shown);
  }
  return lines;
}

/** Binds each finding to the snapshot: an anchor only where every named line is in the head-side diff. */
export function bindFindings(raw: RawFinding[], files: PrFile[], key: PrKey, revision: PrRevision): AgentFinding[] {
  const lines = headLines(files);
  return raw.map((f) => {
    const base: AgentFinding = { id: randomUUID(), ...f, anchor: null, reference: "none" };
    if (f.path === null) return base;
    const shown = lines.get(f.path);
    if (!shown || f.line === null) return { ...base, reference: "unverified" };
    const end = f.endLine ?? f.line;
    for (let n = f.line; n <= end; n++) if (!shown.has(n)) return { ...base, reference: "unverified" };
    const anchor: LineAnchor = { key, revision, commitSha: revision.headSha, path: f.path, side: "head", start: f.line, end };
    return { ...base, anchor, reference: "anchored" };
  });
}
