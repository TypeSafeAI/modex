import { BrandMark } from "./BrandMark";
import { Icon, type IconName } from "./ui/Icon";
import { Kbd } from "./ui/Kbd";

interface Props {
  onAddProject: () => void;
}

const modes: { name: string; icon: IconName; detail: string }[] = [
  { name: "Chat", icon: "comment", detail: "Explore the code and ask questions without making changes." },
  { name: "Agent", icon: "terminal", detail: "Build in your project with approval when needed." },
  { name: "Plan", icon: "review", detail: "Investigate an approach before starting implementation." },
  { name: "Full access", icon: "privacy", detail: "Let the agent act without approval prompts. Use with care." },
];

/** First run: no projects yet. With a project, a new chat is a draft (DraftView) instead. */
export function EmptyState({ onAddProject }: Props) {
  return (
    <div className="empty" data-testid="empty-state">
      <div className="empty-card">
        <section className="empty-start" aria-labelledby="empty-heading">
          <div className="empty-aura" aria-hidden="true"><BrandMark className="big" /></div>
          <p className="empty-kicker">YOUR WORKSPACE</p>
          <h1 id="empty-heading" data-testid="empty-title">What are we building?</h1>
          <p className="empty-intro">Work with Claude Code or Codex in a local repository. Keep threads, files, and changes together.</p>
          <button className="btn primary empty-cta" data-testid="empty-open-project" onClick={onAddProject}>
            <Icon name="folder" size={18} />
            <span>Open Project</span>
            <span className="empty-cta-arrow" aria-hidden="true">↗</span>
          </button>
          <p className="empty-note">Choose a folder on this Mac to get started.</p>
        </section>
        <section className="empty-workflows" aria-labelledby="empty-modes-heading">
          <h2 id="empty-modes-heading">Choose how you work</h2>
          <p>Set the mode when you start a thread.</p>
          <ul className="empty-modes" aria-label="Available work modes">
            {modes.map(({ name, icon, detail }) => (
              <li className="empty-mode" key={name}>
                <Icon name={icon} size={20} />
                <strong>{name}</strong><span>{detail}</span>
              </li>
            ))}
          </ul>
        </section>
        <p className="empty-shortcuts"><span><Kbd>⌘N</Kbd> new chat</span><span><Kbd>⌘⏎</Kbd> send</span><span><Kbd>⇧⌘P</Kbd> plan</span></p>
      </div>
    </div>
  );
}
