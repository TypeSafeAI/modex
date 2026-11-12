import { useState } from "react";
import { applyUiScale, UI_SCALES, uiScale } from "../ui-scale";
import { SecretInput } from "../streamer";
import type { CSSProperties } from "react";
import { THEMES, type Theme } from "../../shared/theme";

/** Interface size, for this window: the whole app drawn at 100%, 110% or 125%. */
export function InterfaceSize() {
  const [scale, setScale] = useState(uiScale);
  return <fieldset className="theme-picker ui-size" data-testid="interface-size">
    <legend>Interface size</legend>
    <div className="ui-size-options" role="radiogroup" aria-label="Interface size">
      {UI_SCALES.map((value) => <button key={value} type="button" role="radio" aria-checked={scale === value} onClick={() => { applyUiScale(value, true); setScale(value); }}>{Math.round(value * 100)}%</button>)}
    </div>
  </fieldset>;
}

export function ThemePicker({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return <fieldset className="theme-picker">
    <legend>Theme</legend>
    <div className="theme-options">
      {(Object.keys(THEMES) as Theme[]).map((id) => {
        const theme = THEMES[id];
        return <label className="theme-choice" key={id} data-selected={value === id}>
          <SecretInput type="radio" name="theme" value={id} checked={value === id} onChange={() => onChange(id)} aria-label={theme.name} />
          <span className="theme-preview" aria-hidden="true" style={{ "--preview-bg": theme.background, "--preview-surface": theme.surface, "--preview-accent": theme.accent } as CSSProperties}>
            <span className="theme-preview-rail" /><span className="theme-preview-lines"><i /><i /><i /></span><span className="theme-preview-composer"><i /></span>
          </span>
          <span className="theme-name">{theme.name}</span>
          <span className="theme-description">{theme.description}</span>
        </label>;
      })}
    </div>
  </fieldset>;
}
