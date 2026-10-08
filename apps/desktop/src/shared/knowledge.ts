export const KNOWLEDGE_VERSION = "0.83.2";
export interface KnowledgeState {
  status: "idle" | "installing" | "starting" | "ready" | "stopping" | "error";
  installed: boolean;
  folder: string | null;
  url: string | null;
  error: string | null;
  /** Connected to a server started elsewhere; disconnecting must leave it running. */
  external?: boolean;
}

export function knowledgeBusy(state: KnowledgeState): boolean {
  return state.status === "installing" || state.status === "starting" || state.status === "stopping";
}
