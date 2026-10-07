import { IconButton } from "./ui/IconButton";

export interface RailActiveWork {
  count: number;
  waiting: number;
}

function activeWorkLabel({ count, waiting }: RailActiveWork): string {
  const threads = `${count} active thread${count === 1 ? "" : "s"}`;
  return waiting ? `${threads}; ${waiting} waiting for approval` : threads;
}

/**
 * The 48 px icon rail. Chat remains the main surface; companion pairing and Settings live below it.
 */
export function Rail({ onOpenSettings, onOpenCompanion, onEnableStreamerMode, activeWork, onOpenActiveWork }: { onOpenSettings: () => void; onOpenCompanion: () => void; onEnableStreamerMode: () => void; activeWork?: RailActiveWork; onOpenActiveWork?: () => void }) {
  const workLabel = activeWork && activeWork.count > 0 ? activeWorkLabel(activeWork) : "";
  return (
    <nav className="rail" aria-label="Surfaces" data-testid="rail">
      <IconButton icon="home" label="Chat" size="lg" className="rail-btn active" aria-current="page" data-testid="rail-chat" tooltipSide="bottom" />
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
