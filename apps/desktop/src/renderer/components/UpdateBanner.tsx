import { useEffect, useState } from "react";
import type { ReleaseUpdate } from "../../shared/types";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";

const DISMISSED = "modex.dismissedUpdate";
export function UpdateBanner() {
  const [update, setUpdate] = useState<ReleaseUpdate | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED); } catch { return null; }
  });
  useEffect(() => {
    let active = true;
    const check = () => { void bridge.invoke("updates:check", undefined).then((value) => {
      if (active) setUpdate(value);
    }).catch(() => {}); };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    check();
    const timer = window.setInterval(onVisible, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  if (!update || update.version === dismissed) return null;
  const dismiss = () => {
    setDismissed(update.version);
    try { localStorage.setItem(DISMISSED, update.version); } catch { /* Keep this session dismissible without storage. */ }
  };
  return <aside className="update-banner" data-testid="update-banner" aria-label="Modex update">
    <Icon name="info" />
    <span role="status">Modex {update.version} is available</span>
    <a href={update.url} target="_blank" rel="noreferrer">View update <Icon name="arrow-right" size={14} /></a>
    <button type="button" className="icon-btn" aria-label="Dismiss update notification" onClick={dismiss}><Icon name="close" /></button>
  </aside>;
}
