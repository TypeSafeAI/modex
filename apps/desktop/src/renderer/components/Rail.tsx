import { IconButton } from "./ui/IconButton";

/**
 * The 48 px icon rail. Chat remains the main surface; companion pairing and Settings live below it.
 */
export function Rail({ onOpenSettings, onOpenCompanion, onEnableStreamerMode }: { onOpenSettings: () => void; onOpenCompanion: () => void; onEnableStreamerMode: () => void }) {
  return (
    <nav className="rail" aria-label="Surfaces" data-testid="rail">
      <IconButton icon="home" label="Chat" size="lg" className="rail-btn active" aria-current="page" data-testid="rail-chat" tooltipSide="bottom" />
      <span className="spacer" />
      <IconButton icon="privacy" label="Turn on Streamer Mode" size="lg" className="rail-btn" data-testid="streamer-mode-toggle" tooltipSide="top" onClick={onEnableStreamerMode} />
      <IconButton icon="phone" label="iPhone companion" size="lg" className="rail-btn" data-testid="open-companion" tooltipSide="top" onClick={onOpenCompanion} />
      <IconButton icon="gear" label="Settings" size="lg" className="rail-btn" data-testid="open-settings" tooltipSide="top" onClick={onOpenSettings} />
    </nav>
  );
}
