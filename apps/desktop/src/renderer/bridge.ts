import type { ModexBridge } from "../shared/types";
import { createBrowserBridge } from "./browser-bridge";

declare global {
  interface Window {
    modex?: ModexBridge;
  }
}

const unavailable: ModexBridge = {
  platform: "web",
  async invoke() { throw new Error("Modex bridge unavailable: open this UI inside the Electron app."); },
  onEvent() { return () => {}; },
  onTerminalEvent() { return () => {}; },
};

export const bridge: ModexBridge = window.modex ?? (import.meta.env.DEV ? createBrowserBridge() : unavailable);
