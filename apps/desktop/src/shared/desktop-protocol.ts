export const DESKTOP_PROTOCOL = 1;

export type DesktopConnectionStatus = { state: "unpaired" | "authorizing" | "connecting" | "connected" | "offline"; detail: string; confirmationCode?: string }
  | { state: "recovery"; reason: "identity" | "protocol"; detail: string; confirmationCode?: never };
