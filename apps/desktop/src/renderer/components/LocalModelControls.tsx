import { useState } from "react";
import type { Thread } from "../../shared/types";
import type { LocalConnectionView } from "../../shared/local-connections";
import { bridge } from "../bridge";

/** Local endpoint configuration stays on the desktop's existing main-owned connection route. */
export function LocalModelControls({ thread, busy, onSelecting }: { thread: Thread; busy: boolean; onSelecting?: (pending: boolean) => void }) {
  const [connections, setConnections] = useState<LocalConnectionView[]>([]);
  const [selected, setSelected] = useState("");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("Strata");
  const [token, setToken] = useState("");
  const [model, setModel] = useState(thread.localTarget?.model.id ?? "qwen3.8-flash-next-iq3_s");
  const [context, setContext] = useState(String(thread.localContextTokens ?? 32768));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const active = thread.localTarget;
  const load = async () => {
    try {
      const reply = await bridge.invoke("local-models:command", { op: "list" });
      if (reply.op === "list") setConnections(reply.connections);
    } catch (err) { setError((err as Error).message); }
  };
  const useLocal = async () => {
    onSelecting?.(true);
    setSaving(true); setError("");
    try {
      if (!model.trim() || !Number.isSafeInteger(Number(context)) || Number(context) < 4096 || Number(context) > 262144) throw new Error("Enter an exact model ID and an effective context of 4096–262144 tokens.");
      let connection = connections.find(c => c.id === selected);
      if (!connection) {
        const reply = await bridge.invoke("local-models:command", { op: "create", input: { label, runtime: "responses", url, manualModels: [model], ...(token ? { token } : {}) } });
        setToken("");
        if (reply.op !== "create") throw new Error("The connection could not be saved.");
        connection = reply.connection;
        setConnections(old => [...old, reply.connection]); setSelected(connection.id);
      }
      await bridge.invoke("thread:update", { threadId: thread.id, patch: {
        localTarget: { schema: 1, harness: "codex", model: { schema: 1, connection: { id: connection.id, revision: connection.revision }, id: model } },
        localContextTokens: Number(context),
      } });
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); onSelecting?.(false); }
  };
  const clear = async () => {
    onSelecting?.(true);
    setSaving(true); setError("");
    try { await bridge.invoke("thread:update", { threadId: thread.id, patch: { localTarget: null } }); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); onSelecting?.(false); }
  };
  return <details className="local-model-controls" data-testid="local-model-controls" onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>Local model{active && <span data-testid="local-model-active"> · {active.model.id}</span>}</summary>
    <div className="local-model-form">
      <p>Experimental: compatibility depends on the server and model. Run an already served local model through Codex. Start the server in Strata, then enter its loopback IP address. Modex does not launch or download models.</p>
      <fieldset disabled={busy || saving}>
        <label>Connection<select aria-label="Local connection" value={selected} onChange={event => {
          setSelected(event.target.value);
          const connection = connections.find(c => c.id === event.target.value);
          if (connection?.manualModels[0]) setModel(connection.manualModels[0]);
        }}><option value="">New Responses connection</option>{connections.map(c => <option key={c.id} value={c.id}>{c.label} · {c.origin}</option>)}</select></label>
        {!selected && <>
          <label>Name<input value={label} onChange={event => setLabel(event.target.value)} /></label>
          <label>Local server URL<input aria-label="Local server URL" placeholder="http://127.0.0.1:PORT/v1" value={url} onChange={event => setUrl(event.target.value)} /></label>
          <label>Server token (optional)<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
        </>}
        <label>Exact local model ID<input aria-label="Exact local model ID" value={model} onChange={event => setModel(event.target.value)} /></label>
        <label>Effective context tokens<input aria-label="Effective context tokens" type="number" min={4096} max={262144} value={context} onChange={event => setContext(event.target.value)} /></label>
        <p>Ordinary text and tools only. Auto, Plan, images and external tools are unavailable. Locality is unverified; a local server can forward requests. After an app restart, select the target again to start a fresh conversation.</p>
        <button type="button" className="btn small" onClick={() => void useLocal()}>Save and use local model</button>
        {active && <button type="button" className="btn small" onClick={() => void clear()}>Use cloud models</button>}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
