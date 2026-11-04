import { useEffect, useState } from "react";
import type { LocalConnectionView, LocalModelDescriptor, LocalRuntime } from "../../shared/local-connections";
import { FAILURE_WORDS, RUNTIME_DEFAULTS, RUNTIME_NAMES, addConnection, cancelDiscovery, discover, discoverAll, entryModels, removeConnection, tokensLabel, updateConnection, useLocalModels, type LocalEntry } from "../local-models";
import { Icon } from "./ui/Icon";

/**
 * Settings → Local models (LM-4, #381): connect a model server running on this Mac, list its models,
 * and remove it. Every change applies at once through main, like an account sign-in, not on Save.
 * Listing reads metadata only. Nothing here loads a model, downloads one or runs inference; a model is
 * used only when a person picks it for a thread and sends a message.
 */
export function LocalModelsSettings() {
  const local = useLocalModels();
  const [runtime, setRuntime] = useState<LocalRuntime>("lmstudio");
  const [label, setLabel] = useState(RUNTIME_DEFAULTS.lmstudio.label);
  const [url, setUrl] = useState(RUNTIME_DEFAULTS.lmstudio.url);
  const [token, setToken] = useState("");
  const [manualModels, setManualModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => { void discoverAll(10_000); }, [local.loaded]);
  useEffect(() => { if (local.loaded && !local.entries.length) setAdding(true); }, [local.loaded, local.entries.length]);

  const chooseRuntime = (next: LocalRuntime) => {
    // Replace the defaults only while the person has not typed their own.
    if (label === RUNTIME_DEFAULTS[runtime].label) setLabel(RUNTIME_DEFAULTS[next].label);
    if (url === RUNTIME_DEFAULTS[runtime].url) setUrl(RUNTIME_DEFAULTS[next].url);
    setRuntime(next);
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setFeedback("");
    try { setFeedback(await fn()); } catch (error) { setFeedback((error as Error).message); } finally { setBusy(false); }
  };
  const add = () => void run(async () => {
    await addConnection({ label: label.trim(), runtime, url: url.trim(), manualModels: manualModels.split("\n").filter(Boolean), ...(token ? { token } : {}) });
    setToken(""); setAdding(false);
    return `${label.trim()} added. Checking its models…`;
  });

  return (
    <section id="settings-local" aria-labelledby="settings-local-title" className="settings-section" data-testid="settings-local-section">
      <div className="connections-heading">
        <div>
          <h3 id="settings-local-title">Local models</h3>
          <p>Connect Ollama, LM Studio or another compatible model server. Coding support is qualified separately for each configuration.</p>
        </div>
        <button type="button" className="btn small" disabled={busy || !local.entries.length} onClick={() => void discoverAll()}><Icon name="restart" />Refresh models</button>
      </div>
      <p className="connections-note">Changes here apply immediately. Checking models reads metadata only and does not load a model. Modex never downloads models. Your first message may make the server load one, which can take time and use a lot of memory. Local coding execution is unavailable until its qualification and admission gates pass.</p>
      {local.error && <p className="connection-feedback warn" role="alert" data-testid="local-models-error">Local models are unavailable: {local.error}</p>}
      <div className="connections-grid">
        {local.entries.map(entry => <ConnectionCard key={`${entry.connection.id}:${entry.connection.revision}`} entry={entry} busy={busy} run={run} />)}
      </div>
      {adding ? (
        <form className="connection-card local-add" data-testid="local-add-form" aria-labelledby="local-add-title" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <h4 id="local-add-title">Add a model server</h4>
          <label className="field"><span>Server</span>
            <select data-testid="local-runtime" value={runtime} disabled={busy} onChange={(event) => chooseRuntime(event.target.value as LocalRuntime)}>
              <option value="lmstudio">LM Studio</option>
              <option value="ollama">Ollama</option>
              <option value="responses">Other Responses-compatible server</option>
            </select>
          </label>
          <label className="field"><span>Name</span><input data-testid="local-label" value={label} disabled={busy} maxLength={64} onChange={(event) => setLabel(event.target.value)} /></label>
          <label className="field"><span>Address</span>
            <input data-testid="local-url" value={url} disabled={busy} spellCheck={false} onChange={(event) => setUrl(event.target.value)} />
            <small>{runtime === "lmstudio" ? "Start LM Studio's server (Developer → Start server, or lms server start). Its default address is http://127.0.0.1:1234. " : ""}Use a numeric address on this Mac, such as 127.0.0.1.</small>
          </label>
          <label className="field"><span>API token (optional)</span>
            <input data-testid="local-token" type="password" autoComplete="off" value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} />
            <small>Only if the server requires one. Modex keeps it in the Mac's secure storage.</small>
          </label>
          <label className="field"><span>Extra model IDs (one per line)</span><textarea data-testid="local-manual-models" value={manualModels} disabled={busy} spellCheck={false} onChange={event => setManualModels(event.target.value)} /><small>IDs are kept exactly as typed. Adding an ID does not qualify it for coding.</small></label>
          <div className="connection-actions">
            <button type="submit" className="btn primary" data-testid="local-add" disabled={busy || !label.trim() || !url.trim()}><Icon name="plus" />Add server</button>
            {local.entries.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>}
          </div>
        </form>
      ) : (
        <div className="connection-actions"><button type="button" className="btn" data-testid="local-add-open" disabled={busy} onClick={() => setAdding(true)}><Icon name="plus" />Add a model server</button></div>
      )}
      {feedback && <p className="connection-feedback" role="status" data-testid="local-feedback">{feedback}</p>}
      <p className="connection-footnote">A local thread sends messages and tool results through Codex to the configured address. That address does not prove where inference happens: the server can forward or redirect requests. Model listings establish neither coding compatibility nor offline operation.</p>
    </section>
  );
}

function ConnectionCard({ entry, busy, run }: { entry: LocalEntry; busy: boolean; run: (fn: () => Promise<string>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const { connection: c, result } = entry;
  const models = entryModels(entry);
  const generative = models.filter(model => model.selectable);
  const other = models.filter(model => !model.selectable);
  const titleId = `local-${c.id}-title`;
  const status = entry.checking ? "Checking…" : !result ? "Not checked yet" : result.state === "ready" ? `Answered · ${generative.length} coding ${generative.length === 1 ? "candidate" : "candidates"}` : "Unavailable";
  return (
    <div className="connection-card local-connection" role="group" aria-labelledby={titleId} data-testid="local-connection" data-state={entry.checking ? "checking" : result?.state ?? "unchecked"}>
      <header className="connection-heading">
        <div><h4 id={titleId}>{c.label}</h4><p>{RUNTIME_NAMES[c.runtime]} · <code>{c.origin}{c.basePath}</code>{c.credential.present ? " · token saved" : ""}</p></div>
        <span className={`connection-badge${result?.state === "ready" && !entry.checking ? " connected" : ""}`} data-testid="local-connection-status"><span aria-hidden="true" />{status}</span>
      </header>
      {result?.state === "unavailable" && <p className="connection-feedback warn" data-testid="local-connection-reason">{FAILURE_WORDS[result.reason] ?? "The server could not be checked."}</p>}
      {result && <p className="connection-footnote">Last checked: <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time></p>}
      {result?.state === "ready" && result.truncated && <p className="connection-feedback">The server listed more models than Modex reads; only the first are shown.</p>}
      {generative.length > 0 && <ul className="local-models-list" aria-label={`Models on ${c.label}`}>
        {generative.map(model => <ModelRow key={model.model.id} model={model} />)}
      </ul>}
      {result?.state === "ready" && !generative.length && <p className="connection-feedback" data-testid="local-no-models">No usable models. {c.runtime === "lmstudio" ? "Download a model in LM Studio, then refresh." : "Install a model in the server, then refresh."}</p>}
      {other.length > 0 && <p className="connection-footnote" data-testid="local-unusable">Not offered for coding: {other.map(model => `${model.model.id} (${model.unselectableReason === "embedding" ? "embedding model" : model.unselectableReason === "cloud" ? "served from the cloud" : "not a text model"})`).join(", ")}.</p>}
      <div className="connection-actions">
        {entry.checking && <button type="button" className="btn small" onClick={() => void run(async () => { await cancelDiscovery(c); return "Check cancelled."; })}>Cancel check</button>}
        <button type="button" className="btn small" data-testid="local-refresh" disabled={busy || entry.checking} onClick={() => void discover(c)}><Icon name="restart" />Refresh</button>
        <button type="button" className="btn small" data-testid="local-edit" disabled={busy} onClick={() => setEditing(value => !value)}>{editing ? "Cancel edit" : "Edit"}</button>
        <button type="button" className="btn small ghost" data-testid="local-remove" disabled={busy} onClick={() => {
          if (!window.confirm(`Remove ${c.label}? Past conversations stay readable. Choose another model before sending on a thread that used this connection.`)) return;
          void run(async () => { await removeConnection(c); return `${c.label} removed.`; });
        }}>Remove</button>
        {c.credential.present && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run(async () => { await updateConnection(c, { token: null }); return "Token removed."; })}>Remove token</button>}
      </div>
      {editing && <EditConnection connection={c} busy={busy} run={run} />}
    </div>
  );
}

function ModelRow({ model }: { model: LocalModelDescriptor }) {
  const facts = [
    model.loaded === "yes" ? "loaded" : model.loaded === "no" ? "not loaded" : "load state unknown",
    model.advertisedContext ? `server advertises ${tokensLabel(model.advertisedContext)} context` : "server context unknown",
    model.advertised.tools === "advertised" ? "server advertises tool use" : model.advertised.tools === "not-advertised" ? "no tool use listed" : null,
    model.source === "manual" ? "typed by you" : null,
    "coding capability unverified",
  ].filter(Boolean);
  return <li data-testid="local-model"><code>{model.model.id}</code>{facts.length ? <span className="local-model-facts"> · {facts.join(" · ")}</span> : null}</li>;
}

function EditConnection({ connection, busy, run }: { connection: LocalConnectionView; busy: boolean; run: (fn: () => Promise<string>) => Promise<void> }) {
  const [label, setLabel] = useState(connection.label);
  const [runtime, setRuntime] = useState(connection.runtime);
  const [url, setUrl] = useState(`${connection.origin}${connection.basePath}`);
  const [token, setToken] = useState("");
  const [manualModels, setManualModels] = useState(connection.manualModels.join("\n"));
  return <form data-testid="local-edit-form" onSubmit={event => {
    event.preventDefault();
    void run(async () => {
      await updateConnection(connection, { label: label.trim(), runtime, url: url.trim(), manualModels: manualModels.split("\n").filter(Boolean), ...(token ? { token } : {}) });
      setToken(""); return "Connection updated. Select its current revision on each thread before sending.";
    });
  }}>
    <label className="field"><span>Name</span><input value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
    <label className="field"><span>Server</span><select value={runtime} disabled={busy} onChange={event => setRuntime(event.target.value as LocalRuntime)}>{Object.entries(RUNTIME_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <label className="field"><span>Address</span><input value={url} disabled={busy} spellCheck={false} onChange={event => setUrl(event.target.value)} /></label>
    <label className="field"><span>Replacement token (optional)</span><input type="password" autoComplete="off" value={token} disabled={busy} onChange={event => setToken(event.target.value)} /><small>Leave blank to keep the token for the same address. Changing the address clears it unless you enter a replacement.</small></label>
    <label className="field"><span>Extra model IDs (one per line)</span><textarea value={manualModels} disabled={busy} spellCheck={false} onChange={event => setManualModels(event.target.value)} /></label>
    <button type="submit" className="btn primary" disabled={busy || !label.trim() || !url.trim()}>Save connection</button>
  </form>;
}
