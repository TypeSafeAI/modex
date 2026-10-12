import type { ReleaseUpdate } from "./types.js";

export interface UpdateInstallState {
  phase: "disabled" | "idle" | "available" | "checking" | "downloading" | "verifying" | "cancelling" | "ready" | "preparing" | "staged" | "uncertain" | "recovery" | "error";
  release: ReleaseUpdate | null;
  installable: boolean;
  /** Only this process has confirmed staging and can invoke native restart. */
  canRestart: boolean;
  received: number;
  total: number;
  message?: string;
}
