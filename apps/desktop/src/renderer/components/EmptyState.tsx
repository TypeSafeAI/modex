import { BrandMark } from "./BrandMark";
import { Kbd } from "./ui/Kbd";

interface Props {
  onAddProject: () => void;
}

/** First run: no projects yet. With a project, a new chat is a draft (DraftView) instead. */
export function EmptyState({ onAddProject }: Props) {
  return (
    <div className="empty" data-testid="empty-state">
      <div className="empty-card">
        <div className="empty-aura" aria-hidden="true">
          <BrandMark className="big" />
        </div>
        <p className="empty-kicker">MODEX / PERSONAL DEV WORKSPACE</p>
        <h1 data-testid="empty-title">What are we building?</h1>
        <p className="empty-intro">A focused desk for Claude Code and Codex, grounded in your local repositories. Keep the work visible, deliberate, and close to the code.</p>
        <button className="btn primary empty-cta" data-testid="empty-open-project" onClick={onAddProject}>
          <span>Open a project</span>
          <span className="empty-cta-arrow" aria-hidden="true">↗</span>
        </button>
        <div className="empty-rule" aria-hidden="true" />
        <ul className="empty-modes" aria-label="Available work modes">
          <li className="empty-mode"><strong>Chat</strong><span>read-only</span></li>
          <li className="empty-mode"><strong>Agent</strong><span>build in project</span></li>
          <li className="empty-mode"><strong>Full access</strong><span>no prompts</span></li>
          <li className="empty-mode"><strong>Plan</strong><span>investigate first</span></li>
        </ul>
        <p className="empty-shortcuts"><Kbd>⌘N</Kbd><span>new chat</span><Kbd>⌘⏎</Kbd><span>send</span><Kbd>⇧⌘P</Kbd><span>plan</span></p>
      </div>
    </div>
  );
}
