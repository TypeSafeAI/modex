import type { Evidence } from "../../../shared/evidence";

/**
 * Evidence the CLI itself attached to a reply (docs/conversation-evidence.md). Today that is Codex's
 * memory citations: where the model says a statement came from, not proof that it holds. Display
 * only: nothing here opens, fetches or runs anything.
 */
export function EvidenceCard({ evidence }: { evidence: Evidence[] }) {
  const memory = evidence.filter((e) => e.kind === "memory");
  if (!memory.length) return null;
  return (
    <div className="evidence" data-testid="evidence-memory" title="Cited by Codex from its memory files. A citation shows where the model says something came from; it does not prove it.">
      <div className="evidence-label">From Codex memory</div>
      <ul className="evidence-list">
        {memory.map((e, i) => (
          <li key={`${e.path}:${e.lineStart}:${i}`}>
            <code className="evidence-where">{e.path} · {e.lineStart === e.lineEnd ? `line ${e.lineStart}` : `lines ${e.lineStart}–${e.lineEnd}`}</code>
            {e.note && <span className="evidence-note">{e.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
