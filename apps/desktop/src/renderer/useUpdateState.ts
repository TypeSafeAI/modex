import { useEffect, useRef, useState } from "react";
import type { ReleaseUpdate } from "../shared/types";
import type { UpdateInstallState } from "../shared/updates";
import { bridge } from "./bridge";

export function useUpdateState() {
  const [release, setRelease] = useState<ReleaseUpdate | null>(null);
  const [installation, setInstallation] = useState<UpdateInstallState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const observed = useRef(0);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    let active = true, requested = 0, checks = 0;
    const unsubscribe = bridge.onUpdateState?.(state => {
      observed.current++;
      if (active) setInstallation(state);
    });
    const readState = async () => {
      const request = ++requested, revision = observed.current;
      try {
        const state = await bridge.invoke("updates:state", undefined);
        if (active && request === requested && revision === observed.current) setInstallation(state);
      } catch { /* Older and paired hosts retain their manual release notice. */ }
    };
    const check = async () => {
      const request = ++checks;
      try {
        const value = await bridge.invoke("updates:check", undefined);
        if (active && request === checks) setRelease(value);
      } catch { /* An offline check must not discard an already prepared update. */ }
      if (active) void readState();
    };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    void readState(); void check();
    const timer = window.setInterval(visible, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", visible); window.addEventListener("focus", visible);
    return () => { active = false; unsubscribe?.(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible); };
  }, []);
  const run = async (channel: "updates:download" | "updates:cancel" | "updates:install" | "updates:quit") => {
    if (busy || pending.current.has(channel)) return;
    pending.current.add(channel);
    // Download resolves only after verification/cancellation. Keep Cancel usable
    // while it is pending; duplicate downloads still coalesce in this controller.
    const blocksControls = channel !== "updates:download";
    const revision = observed.current;
    if (blocksControls) setBusy(true);
    setError(undefined);
    try {
      const state = await bridge.invoke(channel, undefined);
      if (state && revision === observed.current) setInstallation(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The update action could not finish. Try again.";
      setError(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    } finally { pending.current.delete(channel); if (blocksControls) setBusy(false); }
  };
  return { update: installation?.release ?? release, installation, busy, error, run };
}
export type UpdateController = ReturnType<typeof useUpdateState>;
