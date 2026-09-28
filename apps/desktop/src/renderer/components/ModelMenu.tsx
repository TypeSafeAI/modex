import { Fragment, useRef, useState } from "react";
import type { ModelInfo } from "../../shared/types";
import { Icon } from "./ui/Icon";
import { Menu, MenuItem } from "./ui/Menu";

interface Props {
  models: ModelInfo[];
  model: string;
  effort?: string;
  error?: string;
  disabled?: boolean;
  onModel: (id: string, effort?: string) => void;
  onEffort: (effort: string | undefined) => void;
}

/**
 * Codex-App-style model picker: a popover listing exactly the models the CLI reports
 * (name + description, default marked) and, for models that support it, a reasoning-effort
 * row. There is no free-text entry — a model is always one the CLI can run. Popover behaviour
 * (focus, arrow keys, Escape, outside click) comes from the shared Menu primitive.
 */
export function ModelMenu({ models, model, effort, error, disabled, onModel, onEffort }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = models.find((m) => m.id === model);
  const close = () => { setOpen(false); trigger.current?.focus(); };

  const label = error ? "Models unavailable" : models.length === 0 ? "Loading models…" : selected ? selected.label : "Choose model";
  const effortLabel = selected?.efforts?.length ? (effort ?? selected.defaultEffort ?? "default") : "";

  return (
    <div className="model-menu">
      <button ref={trigger} data-testid="model-picker" className={`model-trigger${error ? " warn" : ""}`} onClick={() => setOpen((v) => !v)} disabled={disabled || (!error && models.length === 0)} title={error ?? selected?.description ?? "Model"} aria-haspopup="menu" aria-expanded={open}>
        <span className="model-trigger-label">{label}</span>
        {effortLabel && <span className="model-trigger-effort">{effortLabel}</span>}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={12} className="chev" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} focusSelected label="Model" testId="model-menu" className="model-list" placement="top-end">
        {error && <div className="menu-error">{error}</div>}
        {models.map((m) => (
          <Fragment key={m.id}>
            <MenuItem data-testid="model-option" checkable selected={m.id === model} onClick={() => { onModel(m.id, m.defaultEffort); if (!m.efforts?.length) close(); }}>
              <span className="menu-body">
                <span className="menu-title" data-testid="model-option-title">{m.label}{m.isDefault ? <span className="menu-default">default</span> : null}</span>
                {m.description && <span className="menu-desc">{m.description}</span>}
              </span>
            </MenuItem>
            {m.id === model && m.efforts?.length ? (
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
      </Menu>
    </div>
  );
}
