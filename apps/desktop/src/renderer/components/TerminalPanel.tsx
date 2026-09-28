import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEvent, TerminalSnapshot, Thread } from "../../shared/types";
import { bridge } from "../bridge";
import { IconButton } from "./ui/IconButton";

const MIN_H = 140;
const DEFAULT_H = 240;

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * The thread's embedded shell (a real PTY in main, see engine/terminal.ts). Hiding the panel keeps the
 * shell running; reopening replays its recent output. Close ends the shell; Restart replaces it.
 */
export function TerminalPanel({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const session = useRef<TerminalSnapshot | null>(null);
  const opening = useRef<Promise<TerminalSnapshot> | null>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const [height, setHeight] = useState(DEFAULT_H);
  const [maxHeight, setMaxHeight] = useState(window.innerHeight / 2);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const limit = Math.max(MIN_H, Math.floor(parent.clientHeight / 2));
      setMaxHeight(limit);
      setHeight((value) => Math.min(value, limit));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = screen.current;
    if (!host) return;
    let alive = true;
    let snapshot: TerminalSnapshot | null = null;
    const pending: TerminalEvent[] = [];
    session.current = null;
    setError("");
    setExitCode(null);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: token("--font-mono") || "ui-monospace, Menlo, monospace",
      scrollback: 3000,
      screenReaderMode: true,
      theme: { background: token("--bg-main"), foreground: token("--text-1"), cursor: token("--text-1"), selectionBackground: token("--bg-row-selected") },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    const fail = (err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); };
    const receive = (event: TerminalEvent) => {
      if (!alive || event.threadId !== thread.id) return;
      if (!snapshot) { pending.push(event); return; }
      if (event.sessionId !== snapshot.sessionId || event.sequence <= snapshot.sequence) return;
      snapshot.sequence = event.sequence;
      if (event.type === "data") terminal.write(event.data);
      else { snapshot.exitCode = event.exitCode; setExitCode(event.exitCode); }
    };
    const unsubscribe = bridge.onTerminalEvent(receive);
    const input = terminal.onData((data) => {
      if (snapshot && snapshot.exitCode === null) void bridge.invoke("terminal:write", { threadId: thread.id, sessionId: snapshot.sessionId, data }).catch(fail);
    });
    const resize = new ResizeObserver(() => {
      if (!alive || !host.clientWidth || !host.clientHeight) return;
      fit.fit();
      if (snapshot) void bridge.invoke("terminal:resize", { threadId: thread.id, sessionId: snapshot.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(fail);
    });
    resize.observe(host);
    opening.current = bridge.invoke("terminal:open", { threadId: thread.id, cols: terminal.cols, rows: terminal.rows });
    void opening.current.then((opened) => {
      if (!alive) return;
      snapshot = opened;
      session.current = opened;
      terminal.write(opened.output);
      setExitCode(opened.exitCode);
      for (const event of pending) receive(event);
      pending.length = 0;
      fit.fit();
      void bridge.invoke("terminal:resize", { threadId: thread.id, sessionId: opened.sessionId, cols: terminal.cols, rows: terminal.rows }).catch(fail);
      terminal.focus();
    }).catch(fail);
    return () => {
      alive = false;
      unsubscribe();
      input.dispose();
      resize.disconnect();
      terminal.dispose();
    };
  }, [thread.id, generation]);

  const end = async (restart: boolean) => {
    try {
      const active = session.current ?? await opening.current?.catch(() => null);
      if (active) await bridge.invoke("terminal:close", { threadId: thread.id, sessionId: active.sessionId });
      if (restart) setGeneration((v) => v + 1);
      else onClose();
    } catch (err) { setError((err as Error).message); }
  };
  const clamp = (value: number) => Math.round(Math.max(MIN_H, Math.min(maxHeight, value)));
  const where = thread.worktree?.branch ?? thread.cwd.split(/[\\/]/).filter(Boolean).pop() ?? thread.cwd;

  return (
    <section ref={panel} className="terminal-panel" data-testid="terminal-panel" aria-label="Terminal" style={{ height }}>
      <div
        className="terminal-resize"
        data-testid="terminal-resize"
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        aria-valuemin={MIN_H}
        aria-valuemax={maxHeight}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(e) => { drag.current = { y: e.clientY, height }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (drag.current) setHeight(clamp(drag.current.height + drag.current.y - e.clientY)); }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setHeight((v) => clamp(v + (e.key === "ArrowUp" ? 20 : -20))); } }}
      />
      <header className="terminal-head">
        <span className="terminal-title">Terminal</span>
        <span className="terminal-cwd" data-testid="terminal-cwd" title={thread.cwd}>{where}</span>
        {exitCode !== null && <span className="terminal-exit" data-testid="terminal-exit" role="status">Exited ({exitCode})</span>}
        <span className="spacer" />
        <IconButton icon="restart" label="Restart terminal" data-testid="terminal-restart" onClick={() => void end(true)} />
        <IconButton icon="close" label="Close terminal" data-testid="terminal-close" onClick={() => void end(false)} />
      </header>
      {error && <div className="terminal-error" role="alert">{error}</div>}
      <div className="terminal-screen" data-testid="terminal-screen" ref={screen} />
    </section>
  );
}
