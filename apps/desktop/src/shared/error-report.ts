/**
 * The text behind an in-app error's "Copy details": where it happened, when, the message verbatim,
 * and whatever context the surface knows (thread, path, project). Main appends the app version and
 * platform when it writes the clipboard (`clipboard:write` with `appInfo`), because the renderer
 * does not know them. Turn failures have their own, richer report: `failureReport` in failures.ts.
 */
export function errorReport(input: { where: string; message: string; context?: Record<string, unknown>; at?: Date }): string {
  const context = Object.fromEntries(Object.entries(input.context ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ""));
  const message = input.message.trim() || "(no message)";
  const lines = [`Modex error: ${input.where}`, `At: ${(input.at ?? new Date()).toISOString()}`, "", "Message:", ...message.split("\n").map((line) => `  ${line}`)];
  if (Object.keys(context).length) lines.push("", "Context:", JSON.stringify(context, null, 2));
  return lines.join("\n");
}

/** The footer main adds to a copied error report. */
export function appInfoLine(info: { version: string; electron?: string; platform: string; arch: string }): string {
  return `App: Modex ${info.version}${info.electron ? ` · Electron ${info.electron}` : ""} · ${info.platform} ${info.arch}`;
}
