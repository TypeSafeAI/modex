import type { CSSProperties } from "react";
import { THEMES, type Theme } from "../../shared/theme";

export function ThemePicker({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return <fieldset className="theme-picker">
    <legend>Theme</legend>
    <div className="theme-options">
      {(Object.keys(THEMES) as Theme[]).map((id) => {
        const theme = THEMES[id];
        return <label className="theme-choice" key={id} data-selected={value === id}>
          <input type="radio" name="theme" value={id} checked={value === id} onChange={() => onChange(id)} aria-label={theme.name} />
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
