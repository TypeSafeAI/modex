import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { UsageDashboard } from "./UsageDashboard";
import { sampleEvents } from "./sample";
import type { UsageEvent } from "./ledger";
import "../tokens.css";
import "./usage.css";

/** Inside Modex the page is served from `modex-analytics://app/` with the recorded usage beside it. */
const live = location.protocol === "modex-analytics:";
// Inside Modex, main sets the app's theme; the standalone preview takes ?theme= (Graphite by default).
if (!live) document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "graphite";
/** How often an open dashboard picks up turns that finished since it loaded. */
const REFRESH_MS = 15_000;

function LiveDashboard() {
  const [events, setEvents] = useState<UsageEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("./usage.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`Usage could not be read (HTTP ${response.status}).`);
        const rows = (await response.json()) as UsageEvent[];
        if (alive) { setEvents(rows); setError(null); }
      } catch (err) { if (alive) setError((err as Error).message); }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  if (!events) return <p className="live-status" role={error ? "alert" : "status"}>{error ?? "Loading usage…"}</p>;
  return <UsageDashboard events={events} demo={false} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {live ? <LiveDashboard /> : <UsageDashboard events={sampleEvents} />}
  </React.StrictMode>,
);
