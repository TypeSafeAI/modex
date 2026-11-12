import { StoreDemo, type DemoCopy } from "../../store-desktop/src/main/demo";
import type { ModexBridge, TerminalEvent, ThreadEvent } from "../../desktop/src/shared/types";

/** Where the real feature lives for someone on the web: the Mac app, not a paired host. */
export const WEB_DEMO_COPY: DemoCopy = {
  unavailable: "This is a demo workspace. Download Modex for Mac to use accounts, external pages or system tools.",
  notice: "Demo workspace: providers, files, approvals and replies are simulated in this browser tab. Nothing is sent anywhere.",
  account: "Demo workspace: no account is connected. Sign in from Modex for Mac.",
  claudeLogin: "Demo workspace: sign in to Claude from Modex for Mac.",
  attachments: "Attachments are not available in the demo workspace.",
};

export interface DemoWorkspace {
  /** Changes with every reset, so the interface can start again from the new workspace. */
  id(): string;
  bridge: ModexBridge;
  reset(): void;
}

/**
 * The Store edition's in-memory workspace behind the renderer's bridge. Commands and events
 * are copied and delivered asynchronously, as they are over Electron's IPC.
 */
export function createDemoWorkspace(): DemoWorkspace {
  const threads = new Set<(event: ThreadEvent) => void>();
  const terminals = new Set<(event: TerminalEvent) => void>();
  let demo: StoreDemo;
  const start = () => {
    const workspace: StoreDemo = new StoreDemo(
      (event) => { const copy = structuredClone(event); queueMicrotask(() => { if (demo === workspace) for (const cb of threads) cb(copy); }); },
      (event) => { const copy = structuredClone(event); queueMicrotask(() => { if (demo === workspace) for (const cb of terminals) cb(copy); }); },
      WEB_DEMO_COPY,
    );
    // The desktop app's default appearance; the Store edition's demo starts in its own.
    workspace.invoke("settings:update", { theme: "graphite" });
    demo = workspace;
  };
  start();
  return {
    id: () => demo.id,
    reset() { demo.dispose(); start(); },
    bridge: {
      // Not "web": that is browser development, which asks for a folder on this computer.
      platform: "demo",
      async invoke(channel, payload) {
        if (channel === "clipboard:write") {
          await navigator.clipboard.writeText((payload as { text: string }).text);
          return undefined as never;
        }
        return demo.invoke(channel, payload) as never;
      },
      onEvent(cb) { threads.add(cb); return () => { threads.delete(cb); }; },
      onTerminalEvent(cb) { terminals.add(cb); return () => { terminals.delete(cb); }; },
    },
  };
}
