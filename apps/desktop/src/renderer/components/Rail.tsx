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
 * The 48 px icon rail. Chat remains the main surface, with Space and Analytics beside it; companion pairing and Settings live below.
 * Code Review appears only where its switch allows (`code-review/feature.ts`).
 */
export function Rail({ surface = "chat", onOpenChat, onOpenSpace, onOpenAnalytics, onOpenImages, onOpenPlugins, onOpenRoutines, onOpenCodeReview, onOpenSettings, onOpenCompanion, onEnableStreamerMode, streamerMode = false, activeWork, onOpenActiveWork }: { surface?: "chat" | "space" | "analytics" | "images" | "plugins" | "routines" | "code-review"; onOpenRoutines?: () => void; onOpenCodeReview?: () => void; onOpenAnalytics?: () => void; onOpenImages?: () => void; onOpenPlugins?: () => void; onOpenChat?: () => void; onOpenSpace?: () => void; onOpenSettings: () => void; onOpenCompanion: () => void; onEnableStreamerMode: () => void; streamerMode?: boolean; activeWork?: RailActiveWork; onOpenActiveWork?: () => void }) {
  const workLabel = activeWork && activeWork.count > 0 ? activeWorkLabel(activeWork) : "";
  return (
    <nav className="rail" aria-label="Surfaces" data-testid="rail">
      <IconButton icon="home" label="Chat" size="lg" className={`rail-btn${surface === "chat" ? " active" : ""}`} aria-current={surface === "chat" ? "page" : undefined} data-testid="rail-chat" tooltipSide="bottom" onClick={onOpenChat} />
      {onOpenSpace && <IconButton icon="space" label="Space" size="lg" className={`rail-btn${surface === "space" ? " active" : ""}`} aria-current={surface === "space" ? "page" : undefined} data-testid="rail-space" tooltipSide="bottom" onClick={onOpenSpace} />}
      {onOpenAnalytics && <IconButton icon="analytics" label="Analytics" size="lg" className={`rail-btn${surface === "analytics" ? " active" : ""}`} aria-current={surface === "analytics" ? "page" : undefined} data-testid="rail-analytics" tooltipSide="bottom" onClick={onOpenAnalytics} />}
      {onOpenImages && <IconButton icon="image" label="Images" size="lg" className={`rail-btn${surface === "images" ? " active" : ""}`} aria-current={surface === "images" ? "page" : undefined} data-testid="rail-images" tooltipSide="bottom" onClick={onOpenImages} />}
      {onOpenRoutines && <IconButton icon="history" label="Routines" size="lg" className={`rail-btn${surface === "routines" ? " active" : ""}`} aria-current={surface === "routines" ? "page" : undefined} data-testid="rail-routines" tooltipSide="bottom" onClick={onOpenRoutines} />}
      {onOpenPlugins && <IconButton icon="shapes" label="Plugins" size="lg" className={`rail-btn${surface === "plugins" ? " active" : ""}`} aria-current={surface === "plugins" ? "page" : undefined} data-testid="rail-plugins" tooltipSide="bottom" onClick={onOpenPlugins} />}
      {onOpenCodeReview && <IconButton icon="pull-request" label="Code Review" size="lg" className={`rail-btn${surface === "code-review" ? " active" : ""}`} aria-current={surface === "code-review" ? "page" : undefined} data-testid="rail-code-review" tooltipSide="bottom" onClick={onOpenCodeReview} />}
      {workLabel && (
        <div className="rail-work">
          <IconButton icon="terminal" label={`Active work: ${workLabel}`} title={workLabel} size="lg" className="rail-btn rail-work-btn" data-testid="rail-work" tooltipSide="bottom" onClick={onOpenActiveWork} />
          <span className="rail-work-count" data-testid="rail-work-count" aria-hidden="true">{activeWork?.count}</span>
        </div>
      )}
      <span className="spacer" />
      <IconButton icon="privacy" label={streamerMode ? "Turn off Streamer Mode" : "Turn on Streamer Mode"} aria-pressed={streamerMode} size="lg" className="rail-btn" data-testid="streamer-mode-toggle" tooltipSide="top" onClick={onEnableStreamerMode} />
      <IconButton icon="phone" label="iPhone companion" size="lg" className="rail-btn" data-testid="open-companion" tooltipSide="top" onClick={onOpenCompanion} />
      <IconButton icon="gear" label="Settings" size="lg" className="rail-btn" data-testid="open-settings" tooltipSide="top" onClick={onOpenSettings} />
    </nav>
  );
}
