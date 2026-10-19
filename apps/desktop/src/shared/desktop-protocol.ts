import type { ThreadItem } from "./types.js";

export const DESKTOP_PROTOCOL = 1;

/** Every transcript item kind this build draws. Adding a kind to `ThreadItem` fails here until it is listed. */
const DRAWN: Record<ThreadItem["kind"], true> = { user: true, assistant: true, tool: true, approval: true, question: true, notice: true, thinking: true, plan: true, route: true };
export const DESKTOP_ITEM_KINDS = Object.keys(DRAWN) as ThreadItem["kind"][];
/** A paired desktop names the kinds it draws in this header on every request. Hosts that predate it ignore it. */
export const DESKTOP_ITEM_KINDS_HEADER = "x-modex-item-kinds";
/** What a client that names no kinds draws: Store builds cut before CF-3, such as TestFlight Store 0.0.8. */
export const LEGACY_DESKTOP_ITEM_KINDS: readonly string[] = ["user", "assistant", "tool", "approval", "notice", "thinking", "route"];

export type DesktopConnectionStatus = { state: "unpaired" | "authorizing" | "connecting" | "connected" | "offline"; detail: string; confirmationCode?: string }
  | { state: "recovery"; reason: "identity" | "protocol"; detail: string; confirmationCode?: never };
