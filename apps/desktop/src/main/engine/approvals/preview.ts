import path from "node:path";
import type { ApprovalGateConfig, ApprovalPreview, ApprovalRule } from "../../../shared/types.js";
import type { JevTransport } from "../routing/jev.js";
import { decide } from "./gate.js";

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters.`);
  return value.trim();
}

/** Saves reject invalid drafts; migration alone would silently discard them. */
export function validateRules(raw: unknown): ApprovalRule[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Use at most 100 approval rules.");
  const ids = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid approval rule.");
    const id = text(value.id, "Rule ID", 100);
    if (ids.has(id)) throw new Error("Approval rule IDs must be unique.");
    ids.add(id);
    const when = text(value.when, "When", 500);
    if (!["allow", "ask", "never"].includes(value.decision) || typeof value.enabled !== "boolean") throw new Error("Invalid rule decision or enabled flag.");
    const project = value.project === undefined ? undefined : text(value.project, "Project root", 4096);
    if (project && !path.isAbsolute(project)) throw new Error("Rule scope must be an absolute project root.");
    const match = value.match === undefined || value.match === "" ? undefined : text(value.match, "Exact match", 500);
    if (match && !/^[^:]+:\s*\S/.test(match)) throw new Error('Exact match must be "<tool>: <pattern>", for example "Bash: npm test*".');
    return { id, when, decision: value.decision, enabled: value.enabled, ...(project ? { project } : {}), ...(match ? { match } : {}) };
  });
}

interface Context {
  project(id: string): { path: string; name: string } | undefined;
  config: ApprovalGateConfig;
  jev(): Promise<{ transport: JevTransport | null; model: string }>;
}

export async function previewApproval(raw: unknown, ctx: Context): Promise<ApprovalPreview> {
  if (!raw || typeof raw !== "object") throw new Error("Invalid approval preview.");
  const req = raw as Record<string, unknown>;
  const rules = validateRules(req.rules);
  const project = ctx.project(text(req.projectId, "Project", 100));
  if (!project) throw new Error("Choose an existing project for Try it.");
  if (req.backend !== "claude" && req.backend !== "codex") throw new Error("Choose Claude or Codex.");
  if (req.mode !== "chat" && req.mode !== "agent" && req.mode !== "full-access") throw new Error("Invalid preview mode.");
  if (typeof req.escalation !== "boolean") throw new Error("Invalid escalation flag.");
  const tool = text(req.tool, "Tool", 100);
  const title = text(req.title, "Sample action", 2000);
  let setupError: string | undefined;
  const { transport, model } = await ctx.jev().catch((err: unknown) => {
    setupError = err instanceof Error ? err.message : "Could not resolve Jev.";
    return { transport: null, model: "" };
  });
  const result = await decide({ backend: req.backend, tool, title, cwd: project.path, escalation: req.escalation,
    ...(tool === "Bash" || tool === "command" ? { input: { command: title.replace(/^\$ /, "") } } : {}),
  }, { rules, config: { ...ctx.config, enabled: true }, project: { root: project.path, name: project.name }, mode: req.mode, transport, model });
  return { ...result, ...(setupError ? { jevError: setupError, downgraded: result.downgraded ?? "jev-unavailable" } : {}), gateEnabled: ctx.config.enabled, jevAvailable: transport !== null };
}
