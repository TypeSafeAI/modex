import { IconButton } from "./ui/IconButton";

export interface RailActiveWork {
  count: number;
  waiting: number;
  agents?: number;
}

function activeWorkLabel({ count, waiting, agents = 0 }: RailActiveWork): string {
  const threads = `${count} active thread${count === 1 ? "" : "s"}`;
  return [threads, agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "", waiting ? `${waiting} waiting for approval` : ""].filter(Boolean).join("; ");
}

/**
 * The 48 px icon rail. Chat remains the main surface; companion pairing and Settings live below it.
 */
export function Rail({ surface = "chat", onOpenChat, onOpenSpace, onOpenSettings, onOpenCompanion, onEnableStreamerMode, activeWork, onOpenActiveWork }: { surface?: "chat" | "space"; onOpenChat?: () => void; onOpenSpace?: () => void; onOpenSettings: () => void; onOpenCompanion: () => void; onEnableStreamerMode: () => void; activeWork?: RailActiveWork; onOpenActiveWork?: () => void }) {
  const workLabel = activeWork && activeWork.count > 0 ? activeWorkLabel(activeWork) : "";
  return (
    <nav className="rail" aria-label="Surfaces" data-testid="rail">
      <IconButton icon="home" label="Chat" size="lg" className={`rail-btn${surface === "chat" ? " active" : ""}`} aria-current={surface === "chat" ? "page" : undefined} data-testid="rail-chat" tooltipSide="bottom" onClick={onOpenChat} />
      {onOpenSpace && <IconButton icon="space" label="Space" size="lg" className={`rail-btn${surface === "space" ? " active" : ""}`} aria-current={surface === "space" ? "page" : undefined} data-testid="rail-space" tooltipSide="bottom" onClick={onOpenSpace} />}
      {workLabel && (
        <div className="rail-work">
          <IconButton icon="terminal" label={`Active work: ${workLabel}`} title={workLabel} size="lg" className="rail-btn rail-work-btn" data-testid="rail-work" tooltipSide="bottom" onClick={onOpenActiveWork} />
          <span className="rail-work-count" data-testid="rail-work-count" aria-hidden="true">{activeWork?.count}</span>
        </div>
      )}
      <span className="spacer" />
      <IconButton icon="privacy" label="Turn on Streamer Mode" size="lg" className="rail-btn" data-testid="streamer-mode-toggle" tooltipSide="top" onClick={onEnableStreamerMode} />
      <IconButton icon="phone" label="iPhone companion" size="lg" className="rail-btn" data-testid="open-companion" tooltipSide="top" onClick={onOpenCompanion} />
      <IconButton icon="gear" label="Settings" size="lg" className="rail-btn" data-testid="open-settings" tooltipSide="top" onClick={onOpenSettings} />
    </nav>
  );
}
