import { useState } from "react";
import type { ThreadItem } from "../../../shared/types";
import { Markdown } from "../Markdown";
import { Icon } from "../ui/Icon";

/**
 * A reasoning row, labelled by what its text is (docs/conversation-events.md): a provider's summary,
 * reasoning text the provider sent in the clear, or nothing readable (timing only). Rows saved before
 * the representation was recorded read as they always did.
 */
export function ReasoningItem({ item }: { item: Extract<ThreadItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const running = item.status === "running";
  const isOpen = open ?? running;
  const secs = item.durationMs != null ? Math.max(1, Math.round(item.durationMs / 1000)) : null;
  const label = running ? "Thinking…" : secs ? `Thought for ${secs}s` : "Thinking";
  const tag = running ? null : item.reasoning === "summary" ? "Summary" : item.reasoning === "unavailable" || (item.reasoning && !item.text.trim()) ? "Not shared" : null;
  const empty = running ? "…" : item.reasoning ? "The model reasoned here, but its reasoning was not shared." : "The CLI did not share the reasoning text for this step.";
  return (
    <div className={`thinking ${item.status} ${isOpen ? "open" : ""}`} data-testid="item" data-item-kind="thinking" data-status={item.status} data-reasoning={item.reasoning}>
      <button className="thinking-head" data-testid="item-toggle" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <span className={`thinking-label ${running ? "shimmer" : ""}`} data-testid="thinking-label">{label}</span>
        {tag && <span className="thinking-tag" data-testid="reasoning-tag">{tag}</span>}
        <span className="spacer" />
        <Icon name="chevron-right" size={12} className={`chev${isOpen ? " open" : ""}`} />
      </button>
      {isOpen && (item.text.trim() ? <div className="thinking-body" data-testid="item-body"><Markdown text={item.text} /></div> : <div className="thinking-body dim" data-testid="item-body">{empty}</div>)}
    </div>
  );
}
