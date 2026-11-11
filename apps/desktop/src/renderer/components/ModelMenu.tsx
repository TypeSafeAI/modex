import { Fragment, useEffect, useRef, useState } from "react";
import type { ModelInfo } from "../../shared/types";
import type { LocalModelDescriptor } from "../../shared/local-connections";
import type { LocalModelRef, LocalThreadTarget } from "../../shared/local-models";
import { FAILURE_WORDS, RUNTIME_NAMES, contextChoices, entryModels, tokensLabel, type LocalEntry } from "../local-models";
import { Icon } from "./ui/Icon";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui/Menu";

/** Local models offered beside the CLI's own (LM-4, #381). Main validates every choice again. */
export interface LocalMenu {
  entries: LocalEntry[];
  /** The thread's local target, when it has one. */
  current?: LocalThreadTarget;
  currentContext?: number;
  /** Why a local model cannot be chosen right now; the section still shows, read-only. */
  blocked?: string;
  /** The menu opened: a chance to list models again. */
  onOpen: () => void;
  onChoose: (model: LocalModelRef, contextTokens: number) => void;
  /** Back to the CLI's own models. */
  onClear: (model?: ModelInfo) => void;
  onManage: () => void;
}

interface Props {
  models: ModelInfo[];
  model: string;
  effort?: string;
  error?: string;
  disabled?: boolean;
  onModel: (id: string, effort?: string) => void;
  onEffort: (effort: string | undefined) => void;
  /** Incremented by a failure card's resolve action to focus the picker. */
  openRequest?: number;
  local?: LocalMenu;
}

/**
 * Codex-App-style model picker: a popover listing exactly the models the CLI reports
 * (name + description, default marked) and, for models that support it, a reasoning-effort
 * row. There is no free-text entry — a model is always one the CLI can run. Popover behaviour
 * (focus, arrow keys, Escape, outside click) comes from the shared Menu primitive.
 */
export function ModelMenu({ models, model, effort, error, disabled, onModel, onEffort, openRequest, local }: Props) {
  const [open, setOpen] = useState(false);
  /** The local model whose context choices are showing. */
  const [pending, setPending] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = local?.current;
  const selected = current ? undefined : models.find((m) => m.id === model);
  const close = () => { setOpen(false); setPending(null); trigger.current?.focus(); };
  const currentEntry = current ? local?.entries.find((e) => e.connection.id === current.model.connection.id && e.connection.revision === current.model.connection.revision) : undefined;
  // With no server added, the menu is the cloud list it always was; Settings → Local models adds one.
  const showLocal = Boolean(local && (current || local.entries.length > 0));
  useEffect(() => { if (open) local?.onOpen(); }, [open]);

  useEffect(() => {
    if (openRequest === undefined || openRequest === 0 || !models.length || error || disabled) return;
    setOpen(true);
    requestAnimationFrame(() => trigger.current?.focus());
  }, [openRequest, models.length, error, disabled]);

  const label = current ? current.model.id : error ? "Models unavailable" : models.length === 0 ? "Loading models…" : selected ? selected.label : "Choose model";
  const effortLabel = selected?.efforts?.length ? (effort ?? selected.defaultEffort ?? "default") : "";
  const where = currentEntry ? `${currentEntry.connection.label} at ${currentEntry.connection.origin}` : "a local server";
  const localTitle = current ? `Runs through Codex with ${current.model.id} on ${where}${local?.currentContext ? `, ${tokensLabel(local.currentContext)} context` : ""}. A local address does not prove the server keeps your messages on this Mac.` : undefined;

  return (
    <div className="model-menu">
      <button ref={trigger} data-testid="model-picker" className={`model-trigger${error && !current ? " warn" : ""}${current ? " local" : ""}`} onClick={() => setOpen((v) => !v)} disabled={disabled || (!current && !error && models.length === 0 && !local?.entries.length)} title={localTitle ?? error ?? selected?.description ?? "Model"} aria-haspopup="menu" aria-expanded={open}>
        {current && <span className="model-trigger-local" data-testid="model-local-badge">{currentEntry ? RUNTIME_NAMES[currentEntry.connection.runtime] : "Local"}</span>}
        <span className="model-trigger-label">{label}</span>
        {effortLabel && <span className="model-trigger-effort">{effortLabel}</span>}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={12} className="chev" />
      </button>
      <Menu open={open} onClose={() => { setOpen(false); setPending(null); }} anchorRef={trigger} focusSelected label="Model" testId="model-menu" className="model-list" placement="top-end">
        {error && <div className="menu-error">{error}</div>}
        {showLocal && models.length > 0 && <MenuLabel>{current ? "Cloud models (leaves the local model)" : "Cloud models"}</MenuLabel>}
        {models.map((m) => (
          <Fragment key={m.id}>
            <MenuItem data-testid="model-option" disabled={Boolean(current && local?.blocked)} checkable selected={!current && m.id === model} onClick={() => { if (current) { local!.onClear(m); close(); return; } onModel(m.id, m.defaultEffort); if (!m.efforts?.length) close(); }}>
              <span className="menu-body">
                <span className="menu-title" data-testid="model-option-title">{m.label}{m.isDefault ? <span className="menu-default">default</span> : null}</span>
                {m.description && <span className="menu-desc">{m.description}</span>}
              </span>
            </MenuItem>
            {!current && m.id === model && m.efforts?.length ? (
              <div className="effort-row" role="group" aria-label="Reasoning effort">
                <span className="effort-label">Reasoning</span>
                {m.efforts.map((e) => (
                  <button key={e} type="button" tabIndex={-1} role="menuitemradio" aria-label={`Reasoning effort: ${e}`} aria-checked={(effort ?? m.defaultEffort) === e} className={`effort-pill ${(effort ?? m.defaultEffort) === e ? "on" : ""}`} onClick={() => { onEffort(e); close(); }}>
                    {e}
                  </button>
                ))}
              </div>
            ) : null}
          </Fragment>
        ))}
        {showLocal && local && <LocalSection local={local} pending={pending} setPending={setPending} close={close} />}
      </Menu>
    </div>
  );
}

function LocalSection({ local, pending, setPending, close }: { local: LocalMenu; pending: string | null; setPending: (key: string | null) => void; close: () => void }) {
  const current = local.current;
  return (
    <div data-testid="model-local-section">
      <MenuSeparator />
      <MenuLabel>Local models</MenuLabel>
      {local.blocked && <div className="menu-note" data-testid="model-local-blocked">{local.blocked}</div>}
      {local.entries.map((entry) => {
        const usable = entryModels(entry).filter((m) => m.selectable);
        const result = entry.result;
        const state = entry.checking ? "checking…" : !result ? "not checked" : result.state === "ready" ? "reachable" : "unavailable";
        return (
          <div key={entry.connection.id} role="group" aria-label={`${entry.connection.label} models`} data-testid="model-local-group">
            <div className="menu-group-title"><span>{entry.connection.label}</span><span className={`menu-group-state ${result?.state ?? ""}`}>{state}</span></div>
            {entry.error && <div className="menu-note">{entry.error}</div>}
            {result?.state === "unavailable" && <div className="menu-note">{FAILURE_WORDS[result.reason] ?? "The server could not be checked."}</div>}
            {result?.state === "ready" && !usable.length && <div className="menu-note">No usable models on this server.</div>}
            {usable.map((m) => <LocalOption key={m.model.id} m={m} entry={entry} local={local} pending={pending} setPending={setPending} close={close} />)}
          </div>
        );
      })}
      {current && <MenuItem data-testid="model-local-clear" disabled={Boolean(local.blocked)} onClick={() => { local.onClear(); close(); }}><span className="menu-body"><span className="menu-title">Use cloud models again</span></span></MenuItem>}
      <MenuItem data-testid="model-local-manage" onClick={() => { close(); local.onManage(); }}><span className="menu-body"><span className="menu-title">Manage local models…</span></span></MenuItem>
    </div>
  );
}

function LocalOption({ m, entry, local, pending, setPending, close }: { m: LocalModelDescriptor; entry: LocalEntry; local: LocalMenu; pending: string | null; setPending: (key: string | null) => void; close: () => void }) {
  const key = `${entry.connection.id}\0${entry.connection.revision}\0${m.model.id}`;
  const current = local.current;
  const isCurrent = Boolean(current && current.model.connection.id === m.model.connection.id && current.model.connection.revision === m.model.connection.revision && current.model.id === m.model.id);
  const choices = contextChoices(m.advertisedContext);
  const facts = [m.loaded === "yes" ? "loaded" : null, m.advertisedContext ? `up to ${tokensLabel(m.advertisedContext)}` : null, "unverified locality"].filter(Boolean).join(" · ");
  return (
    <>
      <MenuItem data-testid="model-local-option" checkable selected={isCurrent} disabled={Boolean(local.blocked) || entry.checking || !choices.length} onClick={() => setPending(pending === key ? null : key)}>
        <span className="menu-body">
          <span className="menu-title" data-testid="model-local-title">{m.model.id}</span>
          <span className="menu-desc">{facts}</span>
        </span>
      </MenuItem>
      {pending === key && (
        <div className="effort-row" role="group" aria-label={`Context window for ${m.model.id}`} data-testid="model-local-context">
          <span className="effort-label">Context</span>
          {choices.map((n) => (
            <button key={n} type="button" tabIndex={-1} disabled={Boolean(local.blocked) || entry.checking} role="menuitemradio" aria-label={`Context window: ${n.toLocaleString()} tokens`} aria-checked={isCurrent && local.currentContext === n} className={`effort-pill ${isCurrent && local.currentContext === n ? "on" : ""}`} onClick={() => { local.onChoose(m.model, n); close(); }}>
              {tokensLabel(n)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
