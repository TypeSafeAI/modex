import { useContext, useEffect, useState } from "react";
import { TOOL_LOG_PAGE_BYTES, formatBytes, type ToolLogPage } from "../../../shared/evidence";
import type { ThreadItem } from "../../../shared/types";
import { bridge } from "../../bridge";
import { useRedact } from "../../streamer";
import { ErrorNotice } from "../ui/ErrorNotice";
import { TranscriptThread } from "./PatchCompare";

/**
 * A long tool's full log (docs/conversation-evidence.md). The transcript shows the last 256 KB; main
 * keeps the output from its first byte, up to 10 MB. Show full log reads it back one page at a time,
 * only when asked. Reading it runs nothing.
 */
export function ToolLog({ item }: { item: Extract<ThreadItem, { kind: "tool" }> }) {
  const threadId = useContext(TranscriptThread);
  const redact = useRedact();
  const [page, setPage] = useState<ToolLogPage | null>(null);
  /** Where each page shown so far started, for Earlier. */
  const [trail, setTrail] = useState<number[]>([]);
  const [none, setNone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!threadId || item.status !== "done") return null;

  const load = async (offset: number, nextTrail: number[]) => {
    setBusy(true);
    setError(null);
    try {
      const read = await bridge.invoke("evidence:tool-log", { threadId, itemId: item.id, offset });
      if (!read) setNone(true);
      else { setPage(read); setTrail(nextTrail); }
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!page) return;
    try { await bridge.invoke("clipboard:write", { text: page.text }); setCopied(true); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  if (none) return <p className="tool-log-none" data-testid="tool-log-none">Modex kept nothing more than this. The CLI's own logs may have the rest.</p>;
  if (!page) {
    return (
      <div className="tool-log-open">
        <button type="button" className="evidence-action" data-testid="tool-log-show" disabled={busy} onClick={() => void load(0, [])}>Show full log</button>
        {error && <ErrorNotice testId="tool-log-error" where="Transcript · full log" message={error} onRetry={() => void load(0, [])} context={{ itemId: item.id }} />}
      </div>
    );
  }
  const index = Math.floor(page.offset / TOOL_LOG_PAGE_BYTES) + 1;
  const pages = Math.max(Math.ceil(page.kept / TOOL_LOG_PAGE_BYTES), index);
  const kept = page.total === undefined
    ? `Kept ${formatBytes(page.kept)}; the tool did not finish, so the rest is unknown`
    : page.cut ? `Kept the first ${formatBytes(page.kept)} of ${formatBytes(page.total)}` : `Kept all ${formatBytes(page.kept)}`;
  return (
    <div className="tool-log" data-testid="tool-log">
      <div className="tool-log-status" data-testid="tool-log-status" role="status">{kept} · Page {index} of {pages}</div>
      {/* Streamer Mode masks what is shown here; Copy puts the page itself on the clipboard. */}
      <pre className="output tool-log-text" data-testid="tool-log-text">{redact(page.text)}</pre>
      <div className="tool-log-nav">
        <button type="button" className="evidence-action" data-testid="tool-log-prev" disabled={busy || trail.length === 0} onClick={() => void load(trail.at(-1)!, trail.slice(0, -1))}>Earlier</button>
        <button type="button" className="evidence-action" data-testid="tool-log-next" disabled={busy || page.next === null} onClick={() => void load(page.next!, [...trail, page.offset])}>Later</button>
        <button type="button" className="evidence-action" data-testid="tool-log-copy" aria-label={`Copy page ${index} of the full log`} onClick={() => void copy()}>{copied ? "Copied" : "Copy page"}</button>
        <button type="button" className="evidence-action" data-testid="tool-log-hide" onClick={() => { setPage(null); setTrail([]); }}>Hide</button>
      </div>
      {error && <ErrorNotice testId="tool-log-error" where="Transcript · full log" message={error} onRetry={() => void load(page.offset, trail)} context={{ itemId: item.id }} />}
    </div>
  );
}
