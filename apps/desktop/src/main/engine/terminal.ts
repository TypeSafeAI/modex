import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { IPty, IPtyForkOptions } from "node-pty";
import type { TerminalEvent, TerminalSnapshot } from "../../shared/types.js";

type Pty = Pick<IPty, "write" | "resize" | "kill" | "onData" | "onExit">;
type Spawn = (shell: string, args: string[], options: IPtyForkOptions) => Pty;
const require = createRequire(import.meta.url);
const HISTORY_LIMIT = 128 * 1024;

interface Session extends TerminalSnapshot {
  pty: Pty;
  subscriptions: { dispose(): void }[];
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly cwdFor: (threadId: string) => string,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly spawn: Spawn = (shell, args, options) => (require("node-pty") as typeof import("node-pty")).spawn(shell, args, options),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  open(threadId: string, cols: number, rows: number): TerminalSnapshot {
    this.checkSize(cols, rows);
    const cwd = this.cwdFor(threadId);
    const previous = this.sessions.get(threadId);
    if (previous) {
      return this.snapshot(previous);
    }
    if (!fs.statSync(cwd).isDirectory()) throw new Error("Terminal working directory is not a folder.");
    const env: NodeJS.ProcessEnv = { ...this.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ASAR;
    const shell = process.platform === "win32" ? env.COMSPEC || "powershell.exe" : env.SHELL || "/bin/bash";
    const pty = this.spawn(shell, process.platform === "win32" ? [] : ["-l"], { cwd, cols, rows, env, name: "xterm-256color" });
    const session: Session = { pty, subscriptions: [], sessionId: randomUUID(), output: "", sequence: 0, exitCode: null };
    this.sessions.set(threadId, session);
    session.subscriptions.push(pty.onData((data) => {
      session.output = (session.output + data).slice(-HISTORY_LIMIT);
      this.emit({ threadId, sessionId: session.sessionId, sequence: ++session.sequence, type: "data", data });
    }));
    session.subscriptions.push(pty.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      this.emit({ threadId, sessionId: session.sessionId, sequence: ++session.sequence, type: "exit", exitCode });
    }));
    return this.snapshot(session);
  }

  write(threadId: string, sessionId: string, data: string): void {
    if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("Invalid terminal input.");
    const session = this.session(threadId, sessionId);
    if (session.exitCode !== null) throw new Error("The terminal session has exited.");
    session.pty.write(data);
  }

  resize(threadId: string, sessionId: string, cols: number, rows: number): void {
    this.checkSize(cols, rows);
    const session = this.session(threadId, sessionId);
    if (session.exitCode === null) session.pty.resize(cols, rows);
  }

  close(threadId: string, sessionId?: string): void {
    const session = this.sessions.get(threadId);
    if (!session || (sessionId !== undefined && session.sessionId !== sessionId)) return;
    this.sessions.delete(threadId);
    for (const subscription of session.subscriptions) subscription.dispose();
    if (session.exitCode === null) session.pty.kill();
  }

  dispose(): void {
    for (const threadId of this.sessions.keys()) this.close(threadId);
  }

  private session(threadId: string, sessionId: string): Session {
    const session = this.sessions.get(threadId);
    if (!session || session.sessionId !== sessionId) throw new Error("This terminal session is no longer active.");
    return session;
  }

  private snapshot(session: Session): TerminalSnapshot {
    return { sessionId: session.sessionId, output: session.output, sequence: session.sequence, exitCode: session.exitCode };
  }

  private checkSize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 300) throw new Error("Invalid terminal dimensions.");
  }
}

/** The parts of an IPC event and window the terminal trust check reads (structural, so tests need no Electron). */
interface SenderLike { mainFrame: unknown }
interface WindowLike { isDestroyed(): boolean; webContents: unknown }

/**
 * Terminal channels are honoured only from the app window's own top frame. A shell is full user
 * authority, so a subframe, a second window or a destroyed window is refused.
 */
export function isTrustedTerminalSender(event: { sender: SenderLike; senderFrame: unknown }, win: WindowLike | null): boolean {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === event.sender.mainFrame);
}
