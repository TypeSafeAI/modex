import type { ModexBridge } from "../../desktop/src/shared/types";
import { createDemoWorkspace } from "./demo-bridge";

declare global {
  interface Window { modex?: ModexBridge }
}

// Installed by the entry before the interface loads (see main.ts).
export const workspace = createDemoWorkspace();
window.modex = workspace.bridge;
