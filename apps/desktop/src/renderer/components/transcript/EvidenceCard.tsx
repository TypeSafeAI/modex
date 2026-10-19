import { useEffect, useState } from "react";
import type { Evidence, MemoryEvidence, MemoryExcerpt } from "../../../shared/evidence";
import { bridge } from "../../bridge";
import { useRedact } from "../../streamer";
import { ErrorNotice } from "../ui/ErrorNotice";

/**
 * Evidence the CLI itself attached to a reply (docs/conversation-evidence.md). Today that is Codex's
 * memory citations: where the model says a statement came from, not proof that it holds. Show lines
 * and Copy ask main for the cited lines, which it reads inside Codex's memories folder only. Nothing
 * here opens a file, fetches or runs anything.
 */
export function EvidenceCard({ evidence }: { evidence: Evidence[] }) {
  const memory = evidence.filter((e) => e.kind === "memory");
  if (!memory.length) return null;
  return (
    <div className="evidence" data-testid="evidence-memory" title="Cited by Codex from its memory files. A citation shows where the model says something came from; it does not prove it.">
      <div className="evidence-label">From Codex memory</div>
      <ul className="evidence-list">
        {memory.map((e, i) => <MemoryCitation key={`${e.path}:${e.lineStart}:${i}`} citation={e} />)}
      </ul>
    </div>
  );
}

function MemoryCitation({ citation }: { citation: MemoryEvidence }) {
  const redact = useRedact();
  const [excerpt, setExcerpt] = useState<MemoryExcerpt | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const range = citation.lineStart === citation.lineEnd ? `line ${citation.lineStart}` : `lines ${citation.lineStart}–${citation.lineEnd}`;
  const load = async (): Promise<MemoryExcerpt | null> => {
    if (excerpt) return excerpt;
    setError(null);
    try {
      const read = await bridge.invoke("evidence:memory", { path: citation.path, lineStart: citation.lineStart, lineEnd: citation.lineEnd });
      setExcerpt(read);
      return read;
    } catch (err) {
      setError(message(err));
      return null;
    }
  };
  const show = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    await load();
  };
  const copy = async () => {
    const read = await load();
    if (!read) return;
    try { await bridge.invoke("clipboard:write", { text: read.text }); setCopied(true); }
    catch (err) { setError(message(err)); }
  };
  return (
    <li>
      <code className="evidence-where">{citation.path} · {range}</code>
      {citation.note && <span className="evidence-note">{citation.note}</span>}
      <span className="evidence-actions">
        <button type="button" className="evidence-action" data-testid="evidence-show" aria-expanded={open} onClick={() => void show()}>{open ? "Hide lines" : "Show lines"}</button>
        <button type="button" className="evidence-action" data-testid="evidence-copy" aria-label={`Copy ${range} of ${citation.path}`} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </span>
      {open && excerpt && (
        <div className="evidence-excerpt-box">
          <div className="evidence-range" data-testid="evidence-range">
            {excerpt.lineStart === excerpt.lineEnd ? `Line ${excerpt.lineStart}` : `Lines ${excerpt.lineStart}–${excerpt.lineEnd}`} of {excerpt.totalLines}
            {excerpt.beyondEnd ? " · the citation runs past the end of the file" : ""}
            {excerpt.cut ? " · cut to the first 64 KB" : ""}
          </div>
          {/* Streamer Mode masks what is shown here; Copy puts the lines themselves on the clipboard. */}
          <pre className="evidence-excerpt" data-testid="evidence-excerpt">{redact(excerpt.text)}</pre>
        </div>
      )}
      {error && <ErrorNotice testId="evidence-error" where="Transcript · memory citation" message={error} onRetry={() => void load()} context={{ path: citation.path, lineStart: citation.lineStart, lineEnd: citation.lineEnd }} />}
    </li>
  );
}

/** A paired desktop cannot read this Mac's memory files: say so instead of an unknown-command error. */
function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return /Unknown desktop command/.test(text) ? "Memory files can be read only on the Mac that ran Codex." : text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
